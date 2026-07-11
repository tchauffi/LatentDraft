import { test, after } from "node:test";
import assert from "node:assert/strict";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import { compileTex, writeSessionFiles, sessionDir } from "../src/compile.js";

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
