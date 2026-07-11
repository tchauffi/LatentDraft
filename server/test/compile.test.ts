import { test, after } from "node:test";
import assert from "node:assert/strict";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import {
  compileTex,
  writeSessionFiles,
  sessionDir,
  extractTexLogErrors,
  errorLineNumbers,
  sourceAtLines,
} from "../src/compile.js";

// Integration tests: they run the real vendored Tectonic binary. The package
// cache is warm after the first-ever compile, so each run takes ~a second.

const RUN = `t${Date.now().toString(36)}`;
const usedSessions = new Set<string>();

function session(name: string): string {
  const id = `${RUN}-${name}`;
  usedSessions.add(id);
  return id;
}

after(async () => {
  for (const id of usedSessions) {
    await rm(sessionDir(id), { recursive: true, force: true });
  }
});

const doc = (body: string) => `\\documentclass{article}\\begin{document}${body}\\end{document}`;

test("a valid document compiles to a PDF", async () => {
  const result = await compileTex(session("ok"), doc("Hello, LatentDraft."));
  assert.equal(result.ok, true, result.log);
  assert.ok(result.pdf && result.pdf.subarray(0, 5).toString() === "%PDF-", "response is a PDF");
});

test("a broken document fails with a log, not a crash", async () => {
  const result = await compileTex(session("bad"), doc("\\thisMacroDoesNotExist"));
  assert.equal(result.ok, false);
  assert.equal(result.pdf, undefined);
  assert.match(result.log, /thisMacroDoesNotExist|Undefined control sequence/i);
  // Tectonic's console output alone doesn't name the failing macro — the
  // detailed context must be pulled in from main.log.
  assert.match(result.log, /Error details from main\.log/);
  assert.match(result.log, /thisMacroDoesNotExist/);
  // And the source at the reported line must be quoted so the model can
  // anchor its fix on real text instead of counting lines.
  assert.match(result.log, /main\.tex source at the reported line/);
  assert.match(result.log, /> 1: \\documentclass\{article\}\\begin\{document\}\\thisMacroDoesNotExist/);
});

test("aux files are written and resolved by \\input", async () => {
  const id = session("aux");
  await writeSessionFiles(id, {
    "sections/intro.tex": "\\section{Intro} Content from an aux file.",
  });
  const result = await compileTex(id, doc("\\input{sections/intro}"));
  assert.equal(result.ok, true, result.log);
});

test("writeSessionFiles rejects traversal and absolute paths", async () => {
  const id = session("safe");
  await writeSessionFiles(id, {
    "notes.txt": "fine",
    "../escape.txt": "must not be written",
    "/tmp/abs.txt": "must not be written",
    "a/../../escape2.txt": "must not be written",
  });
  await access(path.join(sessionDir(id), "notes.txt")); // throws if missing
  const tmpRoot = path.dirname(sessionDir(id));
  for (const escaped of [path.join(tmpRoot, "escape.txt"), path.join(tmpRoot, "escape2.txt")]) {
    await assert.rejects(access(escaped), `${escaped} must not exist`);
  }
});

const UNDEFINED_CS_LOG = `This is Tectonic's XeTeX
LaTeX Font Info:    ... okay on input line 3.
LaTeX Font Info:    Checking defaults for TS1/cmr/m/n on input line 3.

! Undefined control sequence.
<recently read> \\badmacro

l.5 \\badmacro

No pages of output.
`;

test("extractTexLogErrors pulls the error block with its source context", () => {
  const out = extractTexLogErrors(UNDEFINED_CS_LOG);
  assert.match(out, /! Undefined control sequence\./);
  assert.match(out, /<recently read> \\badmacro/);
  assert.match(out, /l\.5 \\badmacro/);
  assert.doesNotMatch(out, /Font Info/, "noise lines must not be included");
  assert.doesNotMatch(out, /No pages of output/, "block ends at the blank line after l.N");
});

test("extractTexLogErrors returns empty string when there are no errors", () => {
  assert.equal(extractTexLogErrors("LaTeX Font Info: okay\nOutput written on main.pdf.\n"), "");
});

test("extractTexLogErrors keeps multiple error blocks separated", () => {
  const log = [
    "! Undefined control sequence.",
    "l.5 \\badmacro",
    "",
    "chatter between the errors",
    "! LaTeX Error: File `nope.sty' not found.",
    "l.2 \\usepackage{nope}",
    "",
  ].join("\n");
  const out = extractTexLogErrors(log);
  assert.match(out, /Undefined control sequence/);
  assert.match(out, /File `nope\.sty' not found/);
  assert.doesNotMatch(out, /chatter/);
});

test("extractTexLogErrors caps runaway output", () => {
  const block = "! Some error.\nl.1 x\n\n";
  const out = extractTexLogErrors(block.repeat(500), 2000);
  assert.ok(out.length <= 2050, `capped output, got ${out.length}`);
  assert.match(out, /more errors omitted/);
});

test("errorLineNumbers reads main.tex line numbers from console and .log details", () => {
  const console = "note: Running TeX ...\nerror: main.tex:5: Undefined control sequence\n";
  const details = "! Undefined control sequence.\nl.5 \\badmacro\n\n! Missing $ inserted.\nl.9 x_2\n";
  assert.deepEqual(errorLineNumbers(console, details), [5, 9]);
});

test("errorLineNumbers ignores l.N when the error is in another file", () => {
  const console = "error: sections/intro.tex:3: Undefined control sequence\n";
  const details = "! Undefined control sequence.\nl.3 \\badmacro\n";
  assert.deepEqual(errorLineNumbers(console, details), []);
});

test("sourceAtLines quotes numbered context and marks the error lines", () => {
  const tex = ["\\documentclass{article}", "\\begin{document}", "text", "\\badmacro", "more", "\\end{document}"].join("\n");
  const out = sourceAtLines(tex, [4], 1);
  assert.equal(out, "  3: text\n> 4: \\badmacro\n  5: more");
});

test("sourceAtLines separates distant windows with an ellipsis", () => {
  const tex = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  const out = sourceAtLines(tex, [2, 15], 1);
  assert.match(out, /> 2: line 2/);
  assert.match(out, /> 15: line 15/);
  assert.match(out, /…/);
});

test("concurrent compiles of one session serialize and each returns its own PDF", async () => {
  const id = session("race");
  const results = await Promise.all(
    [1, 2, 3].map((n) => compileTex(id, doc(`Concurrent run ${n}.`))),
  );
  for (const r of results) assert.equal(r.ok, true, r.log);
  // Distinct inputs must yield distinct PDFs — a race would corrupt or duplicate them.
  const unique = new Set(results.map((r) => r.pdf!.toString("base64")));
  assert.equal(unique.size, 3);
});
