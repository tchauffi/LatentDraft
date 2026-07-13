/**
 * Reference DISCOVERY against keyless scholarly APIs — the constructive
 * counterpart to bibverify.ts. Where bibverify checks that entries the model
 * wrote are real, refsearch finds real records FIRST: it searches Crossref
 * and arXiv for a topic/claim/title and returns candidates with ready-to-
 * insert BibTeX, so the agent never has to write a .bib entry from memory
 * (which is how hallucinated references happen). Style of bibverify.ts:
 * plain fetch, hard timeouts, never throws, `fetchFn` injectable so tests
 * stay offline.
 */

import { titleSimilarity, cleanDoi, politeHeaders } from "./bibverify.js";

export interface RefCandidate {
  source: "crossref" | "arxiv";
  title: string;
  /** Display-order author names, "Given Family". */
  authors: string[];
  year?: number;
  /** Journal / proceedings name (Crossref container-title). */
  venue?: string;
  doi?: string;
  arxivId?: string;
  /** Crossref work type: journal-article, proceedings-article, book, … */
  type?: string;
  /** Crossref is-referenced-by-count — a rough prominence signal. */
  citedBy?: number;
}

/** What findReferences needs to know about the project's current bibliography. */
export interface ExistingRef {
  key: string;
  title?: string;
  doi?: string;
}

const TIMEOUT_MS = 15000;
/** Same-work threshold as bibverify. */
const MATCH = 0.7;
/** Cap authors written into a BibTeX entry (physics papers have hundreds). */
const MAX_BIB_AUTHORS = 20;

const STOPWORDS = new Set([
  "a", "an", "the", "on", "of", "in", "for", "and", "or", "with", "to", "from",
  "is", "are", "at", "by", "via", "into", "towards", "toward", "using", "about",
]);

/** Strip HTML tags/entities Crossref sometimes leaves in titles. */
function cleanApiText(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Escape the BibTeX-special characters that plain API text can contain. */
function escapeBib(s: string): string {
  return s.replace(/[\\{}]/g, " ").replace(/([&%#$_])/g, "\\$1").replace(/\s+/g, " ").trim();
}

/** ASCII-fold and strip to lowercase alphanumerics (for citation keys). */
function asciiWord(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** `vaswani2017attention`-style key: first author's last name + year + first significant title word. */
export function makeBibKey(c: RefCandidate, usedKeys: ReadonlySet<string>): string {
  const lastName = asciiWord(c.authors[0]?.trim().split(/\s+/).pop() ?? "") || "anon";
  const titleWord =
    c.title
      .split(/\s+/)
      .map(asciiWord)
      .find((w) => w.length >= 2 && !STOPWORDS.has(w)) ?? "work";
  const base = `${lastName}${c.year ?? ""}${titleWord}`;
  if (!usedKeys.has(base)) return base;
  for (let i = 0; ; i++) {
    const key = `${base}${String.fromCharCode(98 + (i % 24))}${i >= 24 ? Math.floor(i / 24) : ""}`;
    if (!usedKeys.has(key)) return key;
  }
}

/** "Given Family" display names → BibTeX "Family, Given and Family, Given". */
function bibAuthors(authors: string[]): string {
  const formatted = authors.slice(0, MAX_BIB_AUTHORS).map((a) => {
    const parts = a.trim().split(/\s+/);
    if (parts.length < 2) return escapeBib(a.trim());
    const family = parts[parts.length - 1];
    return `${escapeBib(family)}, ${escapeBib(parts.slice(0, -1).join(" "))}`;
  });
  if (authors.length > MAX_BIB_AUTHORS) formatted.push("others");
  return formatted.join(" and ");
}

/** A complete BibTeX entry for a candidate, built ONLY from the API record's fields. */
export function toBibtex(c: RefCandidate, key: string): string {
  const fields: [string, string][] = [["title", `{${escapeBib(c.title)}}`]];
  if (c.authors.length > 0) fields.push(["author", bibAuthors(c.authors)]);
  const entryType =
    c.source === "arxiv" ? "misc"
    : c.type === "proceedings-article" ? "inproceedings"
    : c.type === "book" || c.type === "monograph" ? "book"
    : c.type === "journal-article" ? "article"
    : "misc";
  if (c.venue) {
    fields.push([entryType === "inproceedings" ? "booktitle" : "journal", escapeBib(c.venue)]);
  }
  if (c.year) fields.push(["year", String(c.year)]);
  if (c.doi) fields.push(["doi", c.doi]);
  if (c.arxivId) {
    fields.push(["eprint", c.arxivId]);
    fields.push(["archivePrefix", "arXiv"]);
    fields.push(["url", `https://arxiv.org/abs/${c.arxivId}`]);
  }
  const body = fields.map(([k, v]) => `  ${k} = {${v}},`).join("\n");
  return `@${entryType}{${key},\n${body}\n}`;
}

interface CrossrefItem {
  title?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  issued?: { "date-parts"?: number[][] };
  DOI?: string;
  "container-title"?: string[];
  type?: string;
  "is-referenced-by-count"?: number;
}

export async function searchCrossref(
  query: string,
  rows: number,
  fetchFn: typeof fetch = fetch,
): Promise<RefCandidate[] | { error: string }> {
  let data: { message?: { items?: CrossrefItem[] } } | undefined;
  try {
    const res = await fetchFn(
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${rows}` +
        `&select=title,author,issued,DOI,container-title,type,is-referenced-by-count`,
      { headers: politeHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) return { error: `Crossref search returned HTTP ${res.status}.` };
    data = (await res.json()) as typeof data;
  } catch (err) {
    return { error: `Crossref search failed: ${String(err)}` };
  }
  const out: RefCandidate[] = [];
  for (const item of data?.message?.items ?? []) {
    const title = item.title?.[0] && cleanApiText(item.title[0]);
    if (!title) continue;
    out.push({
      source: "crossref",
      title,
      authors: (item.author ?? [])
        .map((a) => cleanApiText(a.name ?? [a.given, a.family].filter(Boolean).join(" ")))
        .filter(Boolean),
      year: item.issued?.["date-parts"]?.[0]?.[0],
      venue: item["container-title"]?.[0] && cleanApiText(item["container-title"][0]),
      doi: item.DOI,
      type: item.type,
      citedBy: item["is-referenced-by-count"],
    });
  }
  return out;
}

export async function searchArxiv(
  query: string,
  max: number,
  fetchFn: typeof fetch = fetch,
): Promise<RefCandidate[] | { error: string }> {
  let xml: string;
  try {
    const res = await fetchFn(
      `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${max}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) return { error: `arXiv search returned HTTP ${res.status}.` };
    xml = await res.text();
  } catch (err) {
    return { error: `arXiv search failed: ${String(err)}` };
  }
  const out: RefCandidate[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = m[1];
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const id = entry.match(/<id>\s*https?:\/\/arxiv\.org\/abs\/([^<\s]+?)(?:v\d+)?\s*<\/id>/)?.[1];
    if (!title || /^error/i.test(title.trim()) || !id) continue;
    const published = entry.match(/<published>(\d{4})-/)?.[1];
    out.push({
      source: "arxiv",
      title: cleanApiText(title),
      authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((a) => cleanApiText(a[1])),
      year: published ? Number(published) : undefined,
      venue: "arXiv preprint",
      arxivId: id,
    });
  }
  return out;
}

/** Interleave Crossref/arXiv results, dropping arXiv preprints of works Crossref already returned. */
export function mergeCandidates(
  crossref: RefCandidate[],
  arxiv: RefCandidate[],
  max: number,
): RefCandidate[] {
  const kept: RefCandidate[] = [];
  const isDup = (c: RefCandidate) => kept.some((k) => titleSimilarity(k.title, c.title) >= MATCH);
  const queues = [crossref.slice(), arxiv.slice()];
  let q = 0;
  while (kept.length < max && (queues[0].length > 0 || queues[1].length > 0)) {
    const c = queues[q % 2].shift();
    q++;
    if (c && !isDup(c)) kept.push(c);
  }
  return kept;
}

function displayAuthors(authors: string[]): string {
  if (authors.length === 0) return "(no authors listed)";
  const names = authors.slice(0, 3).map((a) => a.split(/\s+/).pop() ?? a);
  return names.join(", ") + (authors.length > 3 ? " et al." : "");
}

/**
 * The find_references tool body: search both sources, merge, and format a
 * model-readable report with one ready-to-insert BibTeX block per candidate.
 * Candidates already present in the project's bibliography are flagged with
 * their existing key instead of getting a new entry.
 */
export async function findReferences(
  query: string,
  maxResults: number,
  existing: ExistingRef[],
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; count: number; summary: string; report: string }> {
  const [cr, ax] = await Promise.all([
    searchCrossref(query, maxResults, fetchFn),
    searchArxiv(query, maxResults, fetchFn),
  ]);
  const errors: string[] = [];
  if ("error" in cr) errors.push(cr.error);
  if ("error" in ax) errors.push(ax.error);
  if ("error" in cr && "error" in ax) {
    return {
      ok: false,
      count: 0,
      summary: "Reference search failed",
      report:
        `Reference search FAILED — could not reach the scholarly APIs:\n- ${errors.join("\n- ")}\n\n` +
        "Tell the user the search could not run (likely a network issue). Do NOT write a .bib " +
        "entry from memory instead.",
    };
  }
  const candidates = mergeCandidates(
    "error" in cr ? [] : cr,
    "error" in ax ? [] : ax,
    maxResults,
  );
  if (candidates.length === 0) {
    return {
      ok: true,
      count: 0,
      summary: `No records match “${query}”`,
      report:
        `No Crossref or arXiv record matches "${query}".` +
        (errors.length > 0 ? ` (Note: ${errors.join(" ")})` : "") +
        "\n\nTry the search again with different wording (a distinctive phrase from the title, " +
        "or author + topic). If nothing turns up, tell the user no reliable source was found — " +
        "do NOT invent a reference.",
    };
  }

  const usedKeys = new Set(existing.map((e) => e.key));
  const existingFor = (c: RefCandidate): ExistingRef | undefined =>
    existing.find(
      (e) =>
        (c.doi && e.doi && cleanDoi(e.doi) === c.doi) ||
        (e.title && titleSimilarity(e.title, c.title) >= MATCH),
    );

  const blocks: string[] = [];
  candidates.forEach((c, i) => {
    const meta = [
      c.year ? `(${c.year})` : undefined,
      c.venue,
      c.doi ? `DOI ${c.doi}` : undefined,
      c.arxivId ? `arXiv:${c.arxivId}` : undefined,
      c.citedBy !== undefined && c.citedBy > 0 ? `cited ${c.citedBy}×` : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    const head = `${i + 1}. "${c.title}" — ${displayAuthors(c.authors)} ${meta}`;
    const already = existingFor(c);
    if (already) {
      blocks.push(`${head}\n   ALREADY IN THE BIBLIOGRAPHY as '${already.key}' — just \\cite{${already.key}}.`);
      return;
    }
    const key = makeBibKey(c, usedKeys);
    usedKeys.add(key);
    const bib = toBibtex(c, key).replace(/^/gm, "   ");
    blocks.push(`${head}\n   BibTeX (key: ${key}):\n${bib}`);
  });

  const lines = [
    `Reference candidates for "${query}" — ${candidates.length} real record(s) from Crossref/arXiv:`,
    "",
    blocks.join("\n\n"),
    "",
    "To cite one: copy its BibTeX block into the project's .bib file EXACTLY as shown " +
      "(edit_document on the .bib, or create_file if the project has none), reference the .bib " +
      "from the document if it is new, and add \\cite{<key>} where the claim is made. NEVER " +
      "change a block's title/authors/year/DOI fields. If none of these candidates is what the " +
      "user needs, search again with different wording or tell them — do NOT write an entry " +
      "from memory.",
  ];
  if (errors.length > 0) lines.push("", `Note: one source was unavailable — ${errors.join(" ")}`);
  return {
    ok: true,
    count: candidates.length,
    summary: `Found ${candidates.length} reference candidate(s) for “${query}”`,
    report: lines.join("\n"),
  };
}
