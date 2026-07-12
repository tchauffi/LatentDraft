import { test } from "node:test";
import assert from "node:assert/strict";
import type { BibEntry } from "../src/bibcheck.js";
import {
  normalizeTitle,
  titleSimilarity,
  cleanDoi,
  extractArxivId,
  verifyEntry,
  verifyEntries,
  formatVerifyReport,
} from "../src/bibverify.js";

function entry(over: Partial<BibEntry>): BibEntry {
  return { key: "k", type: "article", file: "refs.bib", line: 1, text: "@article{k,", ...over };
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

const crossrefWork = (title: string, year = 2017) =>
  JSON.stringify({ message: { title: [title], issued: { "date-parts": [[year]] } } });

/* ---- pure helpers ---- */

test("normalizeTitle strips LaTeX, braces, accents, punctuation", () => {
  assert.equal(
    normalizeTitle("A {M}athematical \\emph{Theory} of Communicati\\'on!"),
    "a mathematical theory of communicati on",
  );
  assert.equal(normalizeTitle("Éléments d'analyse"), "elements d analyse");
});

test("titleSimilarity is high for same work, low for different works", () => {
  assert.ok(
    titleSimilarity("Attention Is All You Need", "Attention is all you need") >= 0.99,
  );
  // Subtitle cut off on one side still matches (containment).
  assert.ok(
    titleSimilarity("Deep Learning", "Deep Learning: Methods and Applications") >= 0.7,
  );
  assert.ok(titleSimilarity("Attention Is All You Need", "A Theory of Justice") < 0.4);
});

test("cleanDoi strips prefixes and rejects non-DOIs", () => {
  assert.equal(cleanDoi("https://doi.org/10.1000/xyz"), "10.1000/xyz");
  assert.equal(cleanDoi("doi:10.1000/xyz."), "10.1000/xyz");
  assert.equal(cleanDoi("not-a-doi"), undefined);
  assert.equal(cleanDoi(undefined), undefined);
});

test("extractArxivId reads eprint field and arxiv.org URLs", () => {
  assert.equal(extractArxivId(entry({ eprint: "1706.03762v5" })), "1706.03762v5");
  assert.equal(extractArxivId(entry({ url: "https://arxiv.org/abs/1706.03762" })), "1706.03762");
  assert.equal(extractArxivId(entry({ url: "https://example.com" })), undefined);
});

/* ---- verifyEntry routes ---- */

test("DOI that exists with matching title → verified", async () => {
  const f = fakeFetch({
    "api.crossref.org/works/": { status: 200, body: crossrefWork("Attention Is All You Need") },
  });
  const r = await verifyEntry(
    entry({ doi: "10.1000/abc", title: "Attention Is All You Need" }),
    f,
  );
  assert.equal(r.verdict, "verified");
  assert.equal(r.method, "doi");
});

test("DOI resolving to a different paper → mismatch naming the real one", async () => {
  const f = fakeFetch({
    "api.crossref.org/works/": { status: 200, body: crossrefWork("A Completely Different Paper", 2019) },
  });
  const r = await verifyEntry(entry({ doi: "10.1000/abc", title: "Invented Title About LLMs" }), f);
  assert.equal(r.verdict, "mismatch");
  assert.match(r.detail, /A Completely Different Paper/);
  assert.match(r.detail, /2019/);
});

test("DOI 404 → not-found", async () => {
  const f = fakeFetch({ "api.crossref.org/works/": { status: 404, body: "" } });
  const r = await verifyEntry(entry({ doi: "10.1000/nope", title: "T" }), f);
  assert.equal(r.verdict, "not-found");
  assert.match(r.detail, /does not exist/);
});

test("arXiv id found with matching title → verified; feed title echo is ignored", async () => {
  const atom = `<feed><title>ArXiv Query: id_list=1706.03762</title>
<entry><title>Attention Is All You Need</title></entry></feed>`;
  const f = fakeFetch({ "export.arxiv.org": { status: 200, body: atom } });
  const r = await verifyEntry(
    entry({ eprint: "1706.03762", title: "Attention Is All You Need" }),
    f,
  );
  assert.equal(r.verdict, "verified");
  assert.equal(r.method, "arxiv");
});

test("arXiv feed with no entry → not-found", async () => {
  const atom = `<feed><title>ArXiv Query</title></feed>`;
  const f = fakeFetch({ "export.arxiv.org": { status: 200, body: atom } });
  const r = await verifyEntry(entry({ eprint: "2301.99999", title: "Ghost Paper" }), f);
  assert.equal(r.verdict, "not-found");
});

test("title search with a weak best hit → not-found with closest candidate", async () => {
  const body = JSON.stringify({
    message: { items: [{ title: ["Unrelated Botany Study"], DOI: "10.2/x" }] },
  });
  const f = fakeFetch({ "query.bibliographic": { status: 200, body } });
  const r = await verifyEntry(entry({ title: "Emergent Reasoning in Large Language Models" }), f);
  assert.equal(r.verdict, "not-found");
  assert.match(r.detail, /closest: "Unrelated Botany Study"/);
  assert.match(r.detail, /double-check/);
});

test("title search with a close hit → verified with DOI in detail", async () => {
  const body = JSON.stringify({
    message: {
      items: [
        { title: ["Emergent Reasoning in Large Language Models"], DOI: "10.2/y", issued: { "date-parts": [[2023]] } },
      ],
    },
  });
  const f = fakeFetch({ "query.bibliographic": { status: 200, body } });
  const r = await verifyEntry(
    entry({ title: "Emergent Reasoning in Large Language Models", year: "2023" }),
    f,
  );
  assert.equal(r.verdict, "verified");
  assert.match(r.detail, /10\.2\/y/);
});

test("network failure → unverified, never not-found", async () => {
  const failing = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const r = await verifyEntry(entry({ doi: "10.1000/abc", title: "T" }), failing);
  assert.equal(r.verdict, "unverified");
});

test("entry with no doi/eprint/title → unverified", async () => {
  const r = await verifyEntry(entry({}), fakeFetch({}));
  assert.equal(r.verdict, "unverified");
  assert.equal(r.method, "none");
});

/* ---- rollup ---- */

test("verifyEntries + formatVerifyReport roll up verdicts", async () => {
  const f = fakeFetch({
    "api.crossref.org/works/10.1000%2Fgood": { status: 200, body: crossrefWork("Good Paper") },
    "api.crossref.org/works/10.1000%2Fdead": { status: 404, body: "" },
  });
  const results = await verifyEntries(
    [
      entry({ key: "good", doi: "10.1000/good", title: "Good Paper" }),
      entry({ key: "dead", doi: "10.1000/dead", title: "Fake Paper", line: 9 }),
      entry({ key: "blank" }),
    ],
    f,
  );
  const byKey = new Map(results.map((r) => [r.key, r]));
  assert.equal(byKey.get("good")?.verdict, "verified");
  assert.equal(byKey.get("dead")?.verdict, "not-found");
  assert.equal(byKey.get("blank")?.verdict, "unverified");

  const entries = new Map([
    ["good", entry({ key: "good" })],
    ["dead", entry({ key: "dead", line: 9 })],
    ["blank", entry({ key: "blank" })],
  ]);
  const report = formatVerifyReport(results, entries);
  assert.equal(report.ok, false);
  assert.match(report.summary, /1 reference\(s\) look fabricated/);
  assert.match(report.section, /⛔ NOT FOUND/);
  assert.match(report.section, /'dead' \(refs\.bib line 9\)/);
  assert.match(report.section, /✅ Verified \(1\): good/);
  assert.match(report.section, /do NOT treat as fabricated/);
});
