/**
 * Static citation/bibliography cross-check. Pure functions over the project's
 * .tex/.bib sources — no compile, no network: which \cite keys resolve to a
 * bibliography entry, which entries are never cited, and whether
 * \bibliography/\addbibresource point at files that exist. The parsed entries
 * (with title/doi/eprint fields) feed the online verifier in bibverify.ts.
 */

export interface BibEntry {
  key: string;
  /** Entry type without the @, lowercased: article, book, misc, … */
  type: string;
  /** File and 1-based line of the @entry, with the source line for quoting. */
  file: string;
  line: number;
  text: string;
  title?: string;
  author?: string;
  year?: string;
  doi?: string;
  eprint?: string;
  url?: string;
}

export interface CiteOccurrence {
  key: string;
  file: string;
  /** 1-based line, with the ORIGINAL source line for quoting. */
  line: number;
  text: string;
}

export interface BibCheckResult {
  /** false when a cited key has no entry (or there is no bibliography at all). */
  ok: boolean;
  /** Short human line for the chat activity list. */
  summary: string;
  /** Full model-readable report. */
  report: string;
  /** Entries that are actually cited — the ones worth verifying online. */
  citedEntries: BibEntry[];
}

/** Cut a line at its first unescaped %; \% (and \\\% …) is literal. */
export function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "%") continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 0) return line.slice(0, i);
  }
  return line;
}

// \cite, \citep/t/alp/alt, \autocite, \parencite, \textcite, \footcite,
// \nocite, \citeauthor, \citeyear, capitalized and starred variants, with up
// to two optional [..] arguments. Known limitation: biblatex multicite
// (\cites{a}{b}) only yields its first group.
const CITE_RE = /\\[a-zA-Z]*[cC]ite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/g;

/** All citation-key occurrences in one .tex source (comments stripped). */
export function extractCitations(file: string, tex: string): CiteOccurrence[] {
  const out: CiteOccurrence[] = [];
  const lines = tex.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripComment(lines[i]);
    for (const m of stripped.matchAll(CITE_RE)) {
      for (const raw of m[1].split(",")) {
        const key = raw.trim();
        if (key) out.push({ key, file, line: i + 1, text: lines[i] });
      }
    }
  }
  return out;
}

/** \bibitem[label]{key} definitions in one .tex source. */
export function extractBibitems(file: string, tex: string): CiteOccurrence[] {
  const out: CiteOccurrence[] = [];
  const lines = tex.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripComment(lines[i]);
    for (const m of stripped.matchAll(/\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
      out.push({ key: m[1].trim(), file, line: i + 1, text: lines[i] });
    }
  }
  return out;
}

/** Strip delimiters/braces from a raw field value and collapse whitespace. */
function cleanValue(raw: string): string {
  let v = raw.trim();
  if ((v.startsWith("{") && v.endsWith("}")) || (v.startsWith('"') && v.endsWith('"'))) {
    v = v.slice(1, -1);
  }
  return v.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Tolerant .bib parser: @type{key, field = {…}|"…"|bare, …}. Skips
 * @string/@preamble/@comment. Unparseable stretches are skipped, not fatal.
 */
export function extractBibEntries(file: string, bib: string): BibEntry[] {
  const out: BibEntry[] = [];
  const lineOf = (idx: number) => bib.slice(0, idx).split("\n").length;
  const lines = bib.split(/\r?\n/);

  for (const start of bib.matchAll(/@([a-zA-Z]+)\s*[{(]/g)) {
    const type = start[1].toLowerCase();
    if (type === "string" || type === "preamble" || type === "comment") continue;
    let i = start.index + start[0].length;
    const keyMatch = /^\s*([^,\s{}()]+)\s*,/.exec(bib.slice(i));
    if (!keyMatch) continue;
    const line = lineOf(start.index);
    const entry: BibEntry = {
      key: keyMatch[1],
      type,
      file,
      line,
      text: lines[line - 1] ?? "",
    };
    i += keyMatch[0].length;

    // Field loop: name = value, until the entry's closing brace.
    let depth = 1; // inside the entry body
    while (i < bib.length && depth > 0) {
      const ch = bib[i];
      if (/\s|,/.test(ch)) {
        i++;
        continue;
      }
      if (ch === "}" || ch === ")") {
        depth--;
        i++;
        continue;
      }
      const field = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*/.exec(bib.slice(i));
      if (!field) break; // tolerate junk: give up on this entry's remaining fields
      i += field[0].length;
      let value = "";
      if (bib[i] === "{") {
        let d = 0;
        const from = i;
        do {
          if (bib[i] === "{") d++;
          else if (bib[i] === "}") d--;
          i++;
        } while (i < bib.length && d > 0);
        value = bib.slice(from, i);
      } else if (bib[i] === '"') {
        const end = bib.indexOf('"', i + 1);
        value = bib.slice(i, end === -1 ? bib.length : end + 1);
        i = end === -1 ? bib.length : end + 1;
      } else {
        const m = /^[^,}]*/.exec(bib.slice(i))!;
        value = m[0];
        i += m[0].length;
      }
      const name = field[1].toLowerCase();
      const clean = cleanValue(value);
      if (name === "title") entry.title = clean;
      else if (name === "author") entry.author = clean;
      else if (name === "year") entry.year = clean;
      else if (name === "doi") entry.doi = clean;
      else if (name === "eprint") entry.eprint = clean;
      else if (name === "url") entry.url = clean;
    }
    out.push(entry);
  }
  return out;
}

interface BibTarget {
  /** Requested .bib filename (extension added for \bibliography). */
  target: string;
  file: string;
  line: number;
  text: string;
}

function extractBibTargets(file: string, tex: string): BibTarget[] {
  const out: BibTarget[] = [];
  const lines = tex.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripComment(lines[i]);
    for (const m of stripped.matchAll(/\\bibliography\s*\{([^}]*)\}/g)) {
      for (const raw of m[1].split(",")) {
        const name = raw.trim();
        if (!name) continue;
        const target = name.endsWith(".bib") ? name : `${name}.bib`;
        out.push({ target, file, line: i + 1, text: lines[i] });
      }
    }
    for (const m of stripped.matchAll(/\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
      const name = m[1].trim();
      if (name) out.push({ target: name, file, line: i + 1, text: lines[i] });
    }
  }
  return out;
}

const quote = (o: { line: number; text: string }) => `  > ${o.line}: ${o.text}`;

export function checkBibtex(files: Record<string, string>): BibCheckResult {
  const texFiles = Object.keys(files).filter((f) => /\.tex$/i.test(f));
  const bibFiles = Object.keys(files).filter((f) => /\.bib$/i.test(f));

  const citations: CiteOccurrence[] = [];
  const bibitems: CiteOccurrence[] = [];
  const targets: BibTarget[] = [];
  for (const f of texFiles) {
    citations.push(...extractCitations(f, files[f]));
    bibitems.push(...extractBibitems(f, files[f]));
    targets.push(...extractBibTargets(f, files[f]));
  }
  const entries: BibEntry[] = [];
  for (const f of bibFiles) entries.push(...extractBibEntries(f, files[f]));

  const nociteAll = citations.some((c) => c.key === "*");
  const cites = citations.filter((c) => c.key !== "*");

  const defined = new Set<string>([...entries.map((e) => e.key), ...bibitems.map((b) => b.key)]);
  const definedLower = new Map<string, string>();
  for (const k of defined) definedLower.set(k.toLowerCase(), k);

  const citedKeys = new Set(cites.map((c) => c.key));
  const missing = new Map<string, CiteOccurrence[]>();
  for (const c of cites) {
    if (defined.has(c.key)) continue;
    const list = missing.get(c.key) ?? [];
    list.push(c);
    missing.set(c.key, list);
  }
  const missingTargets = targets.filter(
    (t) =>
      !(t.target in files) &&
      !Object.keys(files).some((f) => f.split("/").pop() === t.target),
  );
  const unused = nociteAll ? [] : entries.filter((e) => !citedKeys.has(e.key));
  const citedEntries = entries.filter((e) => nociteAll || citedKeys.has(e.key));

  const lines: string[] = [];
  lines.push(
    `BibTeX/citation check — ${texFiles.length} .tex file(s), ${bibFiles.length} .bib file(s): ` +
      `${cites.length} citation command(s), ${citedKeys.size} distinct key(s), ${entries.length + bibitems.length} bibliography entr(y/ies).`,
  );

  let summary: string;
  let ok = true;

  if (cites.length === 0 && !nociteAll) {
    lines.push("");
    lines.push("No \\cite-style commands found — nothing to check.");
    summary = "No citations found";
    return { ok: true, summary, report: lines.join("\n"), citedEntries };
  }

  if (defined.size === 0) {
    ok = false;
    lines.push("");
    lines.push(
      `⛔ ${cites.length} citation command(s) but NO bibliography source exists in the project ` +
        `(no .bib file, no thebibliography environment). Every citation will render as [?].`,
    );
  } else if (missing.size > 0) {
    ok = false;
    lines.push("");
    lines.push(`⛔ ${missing.size} citation key(s) have NO matching bibliography entry:`);
    for (const [key, occs] of missing) {
      const alt = definedLower.get(key.toLowerCase());
      const hint = alt ? ` (did you mean '${alt}'?)` : "";
      const first = occs[0];
      const more = occs.length > 1 ? ` (+${occs.length - 1} more use(s))` : "";
      lines.push(`- '${key}'${hint} — ${first.file}${more}:`);
      lines.push(quote(first));
    }
  } else {
    lines.push("");
    lines.push(`✅ All ${citedKeys.size} citation key(s) resolve to bibliography entries.`);
  }

  for (const t of missingTargets) {
    lines.push("");
    lines.push(`⚠️ ${t.file} references a bibliography file that does not exist in the project: ${t.target}`);
    lines.push(quote(t));
  }

  if (unused.length > 0) {
    lines.push("");
    lines.push(
      `⚠️ ${unused.length} bib entr(y/ies) never cited: ` +
        unused.map((e) => `${e.key} (${e.file}:${e.line})`).join(", ") +
        ".",
    );
  } else if (nociteAll) {
    lines.push("");
    lines.push("(\\nocite{*} keeps every entry — unused-entry check skipped.)");
  }

  if (!ok) {
    lines.push("");
    lines.push(
      "To fix a wrong key: edit the quoted line with edit_document, anchoring old_string on the " +
        "EXACT quoted source text (never include the '> N:' prefix). To add a missing entry: use " +
        "ONLY real bibliographic data — never invent authors, titles, years, or DOIs.",
    );
  }

  summary = ok
    ? `All ${citedKeys.size} citation(s) resolve`
    : defined.size === 0
      ? "No bibliography source found"
      : `${missing.size} unresolved citation key(s)`;
  return { ok, summary, report: lines.join("\n"), citedEntries };
}
