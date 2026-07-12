/**
 * Online verification of bibliography entries against keyless scholarly APIs —
 * the anti-hallucination half of check_bibtex. LLMs invent plausible papers
 * and DOIs that resolve to unrelated work, so per entry (first route that
 * applies): Crossref DOI lookup (existence + title match), arXiv id lookup,
 * Crossref bibliographic title search. Style of research.ts: plain fetch,
 * hard timeouts, never throws. `fetchFn` is injectable so tests stay offline.
 *
 * Verdict discipline: only a dead or mismatched identifier is near-definitive.
 * A title-search miss is "possibly fabricated" (Crossref doesn't index many
 * books/theses/workshops), and any network failure is "unverified" — which
 * must NEVER be treated as hallucinated.
 */

import type { BibEntry } from "./bibcheck.js";

export type Verdict = "verified" | "mismatch" | "not-found" | "unverified";

export interface VerifyResult {
  key: string;
  verdict: Verdict;
  method: "doi" | "arxiv" | "title-search" | "none";
  /** Model-readable: what was found and how it compares to the entry. */
  detail: string;
}

const TIMEOUT_MS = 15000;
const MAX_ENTRIES = 25;
const CONCURRENCY = 3;
/** Similarity at or above which two titles count as the same work. */
const MATCH = 0.7;

/** Lowercase, drop LaTeX commands/braces/math, fold accents, strip punctuation. */
export function normalizeTitle(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[{}$~]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Token containment (|A∩B| / min size), robust to subtitles being cut. */
export function titleSimilarity(a: string, b: string): number {
  const tok = (s: string) => new Set(normalizeTitle(s).split(" ").filter((t) => t.length >= 2));
  const A = tok(a);
  const B = tok(b);
  if (A.size === 0 || B.size === 0) return 0;
  let common = 0;
  for (const t of A) if (B.has(t)) common++;
  return common / Math.min(A.size, B.size);
}

/** doi field cleaned of URL/`doi:` prefixes and trailing punctuation. */
export function cleanDoi(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const doi = raw
    .trim()
    .replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, "")
    .replace(/[.,;]+$/, "");
  return /^10\.\d{4,9}\//.test(doi) ? doi : undefined;
}

/** arXiv id from the eprint field or an arxiv.org URL. */
export function extractArxivId(entry: BibEntry): string | undefined {
  const ID = /(\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(\.[A-Z]{2})?\/\d{7})/;
  const fromEprint = entry.eprint?.match(ID)?.[0];
  if (fromEprint) return fromEprint;
  return entry.url?.match(/arxiv\.org\/(?:abs|pdf)\/([^\s}]+?)(?:\.pdf)?$/i)?.[1];
}

function headers(): Record<string, string> {
  // Crossref's "polite pool" gives better service when a mailto is supplied.
  const mailto = process.env.CROSSREF_MAILTO;
  return {
    Accept: "application/json",
    "User-Agent": `LatentDraft${mailto ? ` (mailto:${mailto})` : ""}`,
  };
}

async function verifyDoi(entry: BibEntry, doi: string, fetchFn: typeof fetch): Promise<VerifyResult> {
  const base = { key: entry.key, method: "doi" as const };
  let res: Response;
  try {
    res = await fetchFn(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ...base, verdict: "unverified", detail: `Crossref DOI lookup failed: ${String(err)}` };
  }
  if (res.status === 404) {
    return { ...base, verdict: "not-found", detail: `DOI ${doi} does not exist on Crossref — likely fabricated.` };
  }
  if (!res.ok) {
    return { ...base, verdict: "unverified", detail: `Crossref DOI lookup returned HTTP ${res.status}.` };
  }
  const data = (await res.json().catch(() => undefined)) as
    | { message?: { title?: string[]; issued?: { "date-parts"?: number[][] } } }
    | undefined;
  const realTitle = data?.message?.title?.[0];
  const realYear = data?.message?.issued?.["date-parts"]?.[0]?.[0];
  if (!realTitle) {
    return { ...base, verdict: "verified", detail: `DOI ${doi} exists (existence only — Crossref returned no title).` };
  }
  if (!entry.title || titleSimilarity(entry.title, realTitle) >= MATCH) {
    return { ...base, verdict: "verified", detail: `DOI ${doi} → "${realTitle}"${realYear ? ` (${realYear})` : ""}.` };
  }
  return {
    ...base,
    verdict: "mismatch",
    detail:
      `DOI ${doi} is "${realTitle}"${realYear ? ` (${realYear})` : ""} — NOT the entry's ` +
      `"${entry.title}". Wrong or fabricated DOI.`,
  };
}

async function verifyArxiv(entry: BibEntry, id: string, fetchFn: typeof fetch): Promise<VerifyResult> {
  const base = { key: entry.key, method: "arxiv" as const };
  let xml: string;
  try {
    const res = await fetchFn(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ...base, verdict: "unverified", detail: `arXiv API returned HTTP ${res.status}.` };
    xml = await res.text();
  } catch (err) {
    return { ...base, verdict: "unverified", detail: `arXiv lookup failed: ${String(err)}` };
  }
  // The feed's own <title> echoes the query — only titles INSIDE <entry> count.
  const entryXml = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  const realTitle = entryXml
    ?.match(/<title>([\s\S]*?)<\/title>/)?.[1]
    ?.replace(/\s+/g, " ")
    .trim();
  if (!realTitle || /^error/i.test(realTitle)) {
    return { ...base, verdict: "not-found", detail: `arXiv id ${id} does not exist — likely fabricated.` };
  }
  if (!entry.title || titleSimilarity(entry.title, realTitle) >= MATCH) {
    return { ...base, verdict: "verified", detail: `arXiv:${id} → "${realTitle}".` };
  }
  return {
    ...base,
    verdict: "mismatch",
    detail: `arXiv:${id} is "${realTitle}" — NOT the entry's "${entry.title}". Wrong or fabricated id.`,
  };
}

async function verifyByTitle(entry: BibEntry, fetchFn: typeof fetch): Promise<VerifyResult> {
  const base = { key: entry.key, method: "title-search" as const };
  const query = [entry.title, entry.author?.split(/\s+and\s+/i)[0], entry.year]
    .filter(Boolean)
    .join(" ");
  let data:
    | { message?: { items?: { title?: string[]; DOI?: string; issued?: { "date-parts"?: number[][] } }[] } }
    | undefined;
  try {
    const res = await fetchFn(
      `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=3&select=title,DOI,issued`,
      { headers: headers(), signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) return { ...base, verdict: "unverified", detail: `Crossref search returned HTTP ${res.status}.` };
    data = (await res.json()) as typeof data;
  } catch (err) {
    return { ...base, verdict: "unverified", detail: `Crossref search failed: ${String(err)}` };
  }
  let best: { title: string; doi?: string; year?: number; sim: number } | undefined;
  for (const item of data?.message?.items ?? []) {
    const title = item.title?.[0];
    if (!title) continue;
    const sim = titleSimilarity(entry.title!, title);
    if (!best || sim > best.sim) {
      best = { title, doi: item.DOI, year: item.issued?.["date-parts"]?.[0]?.[0], sim };
    }
  }
  if (best && best.sim >= MATCH) {
    const yearNote =
      entry.year && best.year && Math.abs(Number(entry.year) - best.year) > 1
        ? ` NOTE: found year ${best.year} but the entry says ${entry.year}.`
        : "";
    return {
      ...base,
      verdict: "verified",
      detail: `Crossref match: "${best.title}"${best.year ? ` (${best.year})` : ""}${best.doi ? `, DOI ${best.doi}` : ""}.${yearNote}`,
    };
  }
  return {
    ...base,
    verdict: "not-found",
    detail:
      `no Crossref record matches "${entry.title}"` +
      (best ? ` (closest: "${best.title}", similarity ${best.sim.toFixed(2)})` : "") +
      ". Possibly fabricated — but Crossref does not index many books/theses/workshops; double-check with web_search before removing.",
  };
}

export async function verifyEntry(entry: BibEntry, fetchFn: typeof fetch = fetch): Promise<VerifyResult> {
  const doi = cleanDoi(entry.doi);
  if (doi) return verifyDoi(entry, doi, fetchFn);
  const arxiv = extractArxivId(entry);
  if (arxiv) return verifyArxiv(entry, arxiv, fetchFn);
  if (entry.title) return verifyByTitle(entry, fetchFn);
  return {
    key: entry.key,
    verdict: "unverified",
    method: "none",
    detail: "no doi, eprint, or title field to check.",
  };
}

export async function verifyEntries(
  entries: BibEntry[],
  fetchFn: typeof fetch = fetch,
): Promise<VerifyResult[]> {
  const targets = entries.slice(0, MAX_ENTRIES);
  const results: VerifyResult[] = new Array(targets.length);
  let next = 0;
  async function worker() {
    while (next < targets.length) {
      const i = next++;
      results[i] = await verifyEntry(targets[i], fetchFn);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  if (entries.length > MAX_ENTRIES) {
    results.push({
      key: "…",
      verdict: "unverified",
      method: "none",
      detail: `${entries.length - MAX_ENTRIES} more entr(y/ies) not checked (limit ${MAX_ENTRIES} per call — use the keys parameter to check specific ones).`,
    });
  }
  return results;
}

/** Merge verification results into a report section + rolled-up status. */
export function formatVerifyReport(
  results: VerifyResult[],
  entryByKey: Map<string, BibEntry>,
): { ok: boolean; summary: string; section: string } {
  const verified = results.filter((r) => r.verdict === "verified");
  const mismatch = results.filter((r) => r.verdict === "mismatch");
  const notFound = results.filter((r) => r.verdict === "not-found");
  const unverified = results.filter((r) => r.verdict === "unverified");

  const where = (key: string) => {
    const e = entryByKey.get(key);
    return e ? ` (${e.file} line ${e.line})` : "";
  };

  const lines: string[] = [];
  lines.push(`External verification (Crossref/arXiv) of ${results.length} cited entr(y/ies):`);
  if (mismatch.length > 0) {
    lines.push("");
    lines.push("⛔ MISMATCH — identifier exists but is a DIFFERENT paper (strong hallucination signal):");
    for (const r of mismatch) lines.push(`- '${r.key}'${where(r.key)}: ${r.detail}`);
  }
  if (notFound.length > 0) {
    lines.push("");
    lines.push("⛔ NOT FOUND (likely fabricated):");
    for (const r of notFound) lines.push(`- '${r.key}'${where(r.key)}: ${r.detail}`);
  }
  if (verified.length > 0) {
    lines.push("");
    lines.push(`✅ Verified (${verified.length}): ${verified.map((r) => r.key).join(", ")}.`);
  }
  if (unverified.length > 0) {
    lines.push("");
    lines.push("❓ Could NOT be checked — do NOT treat as fabricated:");
    for (const r of unverified) lines.push(`- '${r.key}': ${r.detail}`);
  }

  const bad = mismatch.length + notFound.length;
  return {
    ok: bad === 0,
    summary:
      bad > 0
        ? `${bad} reference(s) look fabricated`
        : `${verified.length}/${results.length} references verified`,
    section: lines.join("\n"),
  };
}
