import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripComment,
  extractCitations,
  extractBibitems,
  extractBibEntries,
  checkBibtex,
} from "../src/bibcheck.js";

/* ---- stripComment ---- */

test("stripComment cuts at % but keeps \\%", () => {
  assert.equal(stripComment("text % comment"), "text ");
  assert.equal(stripComment("50\\% of cases \\cite{a}"), "50\\% of cases \\cite{a}");
  assert.equal(stripComment("\\\\% comment after literal backslash"), "\\\\");
  assert.equal(stripComment("no comment here"), "no comment here");
});

/* ---- extractCitations ---- */

test("extractCitations handles the \\cite family and multi-key groups", () => {
  const tex = [
    "\\cite{knuth84}",
    "\\citep[see][p.~2]{shannon48, turing50 ,vaswani17}",
    "\\autocite{a1} and \\parencite{a2} and \\textcite{a3}",
    "\\Citet*{caps} \\citeauthor{auth} \\citeyear{yr}",
    "\\nocite{*}",
  ].join("\n");
  const keys = extractCitations("main.tex", tex).map((c) => c.key);
  assert.deepEqual(keys, [
    "knuth84",
    "shannon48",
    "turing50",
    "vaswani17",
    "a1",
    "a2",
    "a3",
    "caps",
    "auth",
    "yr",
    "*",
  ]);
});

test("extractCitations records line numbers and the original line", () => {
  const tex = "first line\nsee \\cite{key1} % trailing note\n";
  const [c] = extractCitations("main.tex", tex);
  assert.equal(c.line, 2);
  assert.equal(c.text, "see \\cite{key1} % trailing note");
});

test("extractCitations ignores commented-out citations", () => {
  const tex = "% \\cite{ghost}\nreal \\cite{real} text\n50\\% sure \\cite{escaped}";
  const keys = extractCitations("main.tex", tex).map((c) => c.key);
  assert.deepEqual(keys, ["real", "escaped"]);
});

/* ---- extractBibitems ---- */

test("extractBibitems finds \\bibitem with and without label", () => {
  const tex = "\\begin{thebibliography}{9}\n\\bibitem{plain}\n\\bibitem[Knu84]{labeled} Knuth.\n\\end{thebibliography}";
  assert.deepEqual(
    extractBibitems("main.tex", tex).map((b) => b.key),
    ["plain", "labeled"],
  );
});

/* ---- extractBibEntries ---- */

test("extractBibEntries parses fields with braces, quotes, and bare values", () => {
  const bib = `@article{ shannon48 ,
  title   = {A Mathematical {T}heory of Communication},
  author  = "Claude E. Shannon",
  year    = 1948,
  doi     = {10.1002/j.1538-7305.1948.tb01338.x},
}
@misc{vaswani17,
  title = {Attention Is All You Need},
  eprint = {1706.03762},
  url = {https://arxiv.org/abs/1706.03762}
}`;
  const [a, b] = extractBibEntries("refs.bib", bib);
  assert.equal(a.key, "shannon48");
  assert.equal(a.type, "article");
  assert.equal(a.title, "A Mathematical Theory of Communication");
  assert.equal(a.author, "Claude E. Shannon");
  assert.equal(a.year, "1948");
  assert.equal(a.doi, "10.1002/j.1538-7305.1948.tb01338.x");
  assert.equal(a.line, 1);
  assert.equal(b.key, "vaswani17");
  assert.equal(b.eprint, "1706.03762");
  assert.equal(b.url, "https://arxiv.org/abs/1706.03762");
});

test("extractBibEntries skips @string/@preamble/@comment", () => {
  const bib = `@string{acm = {ACM Press}}
@preamble{"\\newcommand{\\x}{y}"}
@comment{ignored}
@book{knuth84, title = {The TeXbook}, year = 1984}`;
  const entries = extractBibEntries("refs.bib", bib);
  assert.deepEqual(
    entries.map((e) => e.key),
    ["knuth84"],
  );
});

/* ---- checkBibtex ---- */

test("all citations resolve", () => {
  const result = checkBibtex({
    "main.tex": "\\cite{a} and \\cite{b}",
    "refs.bib": "@misc{a, title={A}}\n@misc{b, title={B}}",
  });
  assert.equal(result.ok, true);
  assert.match(result.report, /✅ All 2 citation key\(s\) resolve/);
  assert.match(result.summary, /All 2 citation/);
  assert.equal(result.citedEntries.length, 2);
});

test("missing key is reported with the quoted source line and a case hint", () => {
  const result = checkBibtex({
    "main.tex": "intro\nas shown by \\cite{smith2020}\n",
    "refs.bib": "@article{Smith2020, title={T}}",
  });
  assert.equal(result.ok, false);
  assert.match(result.report, /⛔ 1 citation key\(s\) have NO matching/);
  assert.match(result.report, /'smith2020' \(did you mean 'Smith2020'\?\) — main\.tex/);
  assert.match(result.report, /> 2: as shown by \\cite\{smith2020\}/);
  assert.match(result.summary, /1 unresolved/);
});

test("citations with no bibliography source at all", () => {
  const result = checkBibtex({ "main.tex": "\\cite{a}" });
  assert.equal(result.ok, false);
  assert.match(result.report, /NO bibliography source/);
  assert.equal(result.summary, "No bibliography source found");
});

test("\\bibitem counts as a definition (thebibliography)", () => {
  const result = checkBibtex({
    "main.tex": "\\cite{k}\n\\begin{thebibliography}{9}\n\\bibitem{k} K.\n\\end{thebibliography}",
  });
  assert.equal(result.ok, true);
});

test("missing \\bibliography target is flagged, existing one is not", () => {
  const bad = checkBibtex({
    "main.tex": "\\cite{a}\n\\bibliography{references}",
    "refs.bib": "@misc{a, title={A}}",
  });
  assert.match(bad.report, /does not exist in the project: references\.bib/);
  assert.match(bad.report, /> 2: \\bibliography\{references\}/);

  const good = checkBibtex({
    "main.tex": "\\cite{a}\n\\bibliography{refs}",
    "refs.bib": "@misc{a, title={A}}",
  });
  assert.doesNotMatch(good.report, /does not exist in the project/);
});

test("unused entries are listed with file:line, suppressed by \\nocite{*}", () => {
  const files = {
    "main.tex": "\\cite{used}",
    "refs.bib": "@misc{used, title={U}}\n@misc{spare, title={S}}",
  };
  const result = checkBibtex(files);
  assert.match(result.report, /⚠️ 1 bib entr\(y\/ies\) never cited: spare \(refs\.bib:2\)/);

  const nocite = checkBibtex({ ...files, "main.tex": "\\cite{used}\\nocite{*}" });
  assert.doesNotMatch(nocite.report, /never cited/);
  assert.match(nocite.report, /\\nocite\{\*\}/);
  // \nocite{*} makes every entry "cited" for online verification.
  assert.equal(nocite.citedEntries.length, 2);
});

test("no citations at all is ok", () => {
  const result = checkBibtex({ "main.tex": "no cites here" });
  assert.equal(result.ok, true);
  assert.equal(result.summary, "No citations found");
});

test("citedEntries carries the fields the online verifier needs", () => {
  const result = checkBibtex({
    "main.tex": "\\cite{v}",
    "refs.bib": "@misc{v, title={Attention Is All You Need}, eprint={1706.03762}}",
  });
  assert.equal(result.citedEntries[0].title, "Attention Is All You Need");
  assert.equal(result.citedEntries[0].eprint, "1706.03762");
});
