import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeBibKey,
  toBibtex,
  mergeCandidates,
  searchCrossref,
  searchArxiv,
  findReferences,
  type RefCandidate,
} from "../src/refsearch.js";

function candidate(over: Partial<RefCandidate>): RefCandidate {
  return {
    source: "crossref",
    title: "Attention Is All You Need",
    authors: ["Ashish Vaswani", "Noam Shazeer"],
    year: 2017,
    ...over,
  };
}

/** Fake fetch returning canned responses per URL substring. */
function fakeFetch(routes: Record<string, { status: number; body: string }>): typeof fetch {
  return (async (url: unknown) => {
    const u = String(url);
    for (const [needle, r] of Object.entries(routes)) {
      if (u.includes(needle)) {
        return new Response(r.body, { status: r.status });
      }
    }
    throw new Error(`no fake route for ${u}`);
  }) as typeof fetch;
}

const crossrefSearch = (items: unknown[]) => JSON.stringify({ message: { items } });

const crossrefItem = (title: string, over: Record<string, unknown> = {}) => ({
  title: [title],
  author: [
    { given: "Ashish", family: "Vaswani" },
    { given: "Noam", family: "Shazeer" },
  ],
  issued: { "date-parts": [[2017]] },
  DOI: "10.5555/3295222",
  "container-title": ["Advances in Neural Information Processing Systems"],
  type: "proceedings-article",
  "is-referenced-by-count": 90000,
  ...over,
});

const arxivFeed = (entries: { title: string; id: string; year?: number }[]) =>
  `<feed>${entries
    .map(
      (e) =>
        `<entry><id>http://arxiv.org/abs/${e.id}v1</id><title>${e.title}</title>` +
        `<published>${e.year ?? 2017}-06-12T00:00:00Z</published>` +
        `<author><name>Ashish Vaswani</name></author></entry>`,
    )
    .join("")}</feed>`;

/* ---- pure helpers ---- */

test("makeBibKey builds lastname+year+word and avoids collisions", () => {
  const c = candidate({});
  assert.equal(makeBibKey(c, new Set()), "vaswani2017attention");
  assert.equal(makeBibKey(c, new Set(["vaswani2017attention"])), "vaswani2017attentionb");
  // Stopwords and LaTeX-hostile characters are skipped/folded.
  assert.equal(
    makeBibKey(candidate({ title: "On the Éléments of Style", authors: ["Jörg Müller"] }), new Set()),
    "muller2017elements",
  );
  assert.equal(makeBibKey(candidate({ authors: [] }), new Set()), "anon2017attention");
});

test("toBibtex maps crossref types and escapes special characters", () => {
  const bib = toBibtex(
    candidate({ venue: "NeurIPS & Friends", doi: "10.1/x_y", type: "proceedings-article" }),
    "vaswani2017attention",
  );
  assert.match(bib, /^@inproceedings\{vaswani2017attention,/);
  assert.match(bib, /author = \{Vaswani, Ashish and Shazeer, Noam\}/);
  assert.match(bib, /booktitle = \{NeurIPS \\& Friends\}/);
  assert.match(bib, /doi = \{10.1\/x_y\}/);

  const article = toBibtex(candidate({ venue: "JMLR", type: "journal-article" }), "k");
  assert.match(article, /^@article\{k,/);
  assert.match(article, /journal = \{JMLR\}/);
});

test("toBibtex emits arXiv entries with an eprint the verifier can check", () => {
  const bib = toBibtex(
    candidate({ source: "arxiv", arxivId: "1706.03762", venue: "arXiv preprint" }),
    "vaswani2017attention",
  );
  assert.match(bib, /^@misc\{/);
  assert.match(bib, /eprint = \{1706\.03762\}/);
  assert.match(bib, /archivePrefix = \{arXiv\}/);
  assert.match(bib, /url = \{https:\/\/arxiv\.org\/abs\/1706\.03762\}/);
});

test("mergeCandidates interleaves sources and drops arXiv duplicates of crossref hits", () => {
  const cr = [candidate({ title: "Attention Is All You Need" }), candidate({ title: "BERT" })];
  const ax = [
    candidate({ source: "arxiv", title: "Attention is all you need", arxivId: "1706.03762" }),
    candidate({ source: "arxiv", title: "Deep Residual Learning", arxivId: "1512.03385" }),
  ];
  const merged = mergeCandidates(cr, ax, 5);
  assert.deepEqual(
    merged.map((c) => c.title),
    ["Attention Is All You Need", "BERT", "Deep Residual Learning"],
  );
  assert.equal(mergeCandidates(cr, ax, 2).length, 2);
});

/* ---- API parsing ---- */

test("searchCrossref parses items into candidates", async () => {
  const res = await searchCrossref(
    "attention",
    5,
    fakeFetch({ "api.crossref.org/works?": { status: 200, body: crossrefSearch([crossrefItem("Attention Is All You Need")]) } }),
  );
  assert.ok(Array.isArray(res));
  assert.equal(res.length, 1);
  assert.equal(res[0].title, "Attention Is All You Need");
  assert.deepEqual(res[0].authors, ["Ashish Vaswani", "Noam Shazeer"]);
  assert.equal(res[0].year, 2017);
  assert.equal(res[0].doi, "10.5555/3295222");
  assert.equal(res[0].citedBy, 90000);
});

test("searchArxiv parses the atom feed and strips version suffixes", async () => {
  const res = await searchArxiv(
    "attention",
    5,
    fakeFetch({ "export.arxiv.org": { status: 200, body: arxivFeed([{ title: "Attention Is All You Need", id: "1706.03762" }]) } }),
  );
  assert.ok(Array.isArray(res));
  assert.equal(res.length, 1);
  assert.equal(res[0].arxivId, "1706.03762");
  assert.equal(res[0].year, 2017);
  assert.deepEqual(res[0].authors, ["Ashish Vaswani"]);
});

test("search functions report errors instead of throwing", async () => {
  const cr = await searchCrossref("x", 5, fakeFetch({ "api.crossref.org": { status: 503, body: "" } }));
  assert.ok("error" in cr && /503/.test(cr.error));
  const ax = await searchArxiv("x", 5, fakeFetch({}));
  assert.ok("error" in ax && /failed/.test(ax.error));
});

/* ---- findReferences report ---- */

test("findReferences formats candidates with insertable BibTeX", async () => {
  const res = await findReferences("attention transformers", 5, [], fakeFetch({
    "api.crossref.org/works?": { status: 200, body: crossrefSearch([crossrefItem("Attention Is All You Need")]) },
    "export.arxiv.org": { status: 200, body: arxivFeed([{ title: "Deep Residual Learning", id: "1512.03385", year: 2015 }]) },
  }));
  assert.equal(res.ok, true);
  assert.equal(res.count, 2);
  assert.match(res.report, /1\. "Attention Is All You Need"/);
  assert.match(res.report, /@inproceedings\{vaswani2017attention,/);
  assert.match(res.report, /@misc\{vaswani2015deep,/);
  assert.match(res.report, /cited 90000×/);
  assert.match(res.report, /NEVER\s+change a block's title\/authors\/year\/DOI/);
});

test("findReferences flags candidates already in the bibliography (by DOI and by title)", async () => {
  const existing = [
    { key: "vaswani17", title: "Attention Is All You Need", doi: "10.5555/3295222" },
  ];
  const res = await findReferences("attention", 5, existing, fakeFetch({
    "api.crossref.org/works?": { status: 200, body: crossrefSearch([crossrefItem("Attention Is All You Need")]) },
    "export.arxiv.org": { status: 200, body: arxivFeed([]) },
  }));
  assert.match(res.report, /ALREADY IN THE BIBLIOGRAPHY as 'vaswani17'/);
  assert.doesNotMatch(res.report, /@inproceedings/);
});

test("findReferences avoids key collisions with existing entries", async () => {
  const res = await findReferences("attention", 5, [{ key: "vaswani2017attention" }], fakeFetch({
    "api.crossref.org/works?": { status: 200, body: crossrefSearch([crossrefItem("Attention Is All You Need")]) },
    "export.arxiv.org": { status: 200, body: arxivFeed([]) },
  }));
  assert.match(res.report, /@inproceedings\{vaswani2017attentionb,/);
});

test("findReferences with no matches says so without inventing anything", async () => {
  const res = await findReferences("zzz", 5, [], fakeFetch({
    "api.crossref.org/works?": { status: 200, body: crossrefSearch([]) },
    "export.arxiv.org": { status: 200, body: arxivFeed([]) },
  }));
  assert.equal(res.ok, true);
  assert.equal(res.count, 0);
  assert.match(res.report, /do NOT invent a reference/);
});

test("findReferences degrades to one source and fails only when both are down", async () => {
  const oneDown = await findReferences("attention", 5, [], fakeFetch({
    "api.crossref.org/works?": { status: 503, body: "" },
    "export.arxiv.org": { status: 200, body: arxivFeed([{ title: "Attention Is All You Need", id: "1706.03762" }]) },
  }));
  assert.equal(oneDown.ok, true);
  assert.equal(oneDown.count, 1);
  assert.match(oneDown.report, /one source was unavailable/);

  const bothDown = await findReferences("attention", 5, [], fakeFetch({}));
  assert.equal(bothDown.ok, false);
  assert.match(bothDown.report, /Do NOT write a \.bib entry from memory/);
});
