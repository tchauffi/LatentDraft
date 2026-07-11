import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rm, access } from "node:fs/promises";
import path from "node:path";
import { renderMermaid } from "../src/mermaid.js";
import { compileTex, sessionDir } from "../src/compile.js";

// Integration tests: they run the real mermaid-cli (headless Chromium), so
// each render takes a few seconds.

const SESSION = `mmd-${Date.now().toString(36)}`;

after(async () => {
  await rm(sessionDir(SESSION), { recursive: true, force: true });
});

test("renderMermaid renders a flowchart PNG that LaTeX can include", async () => {
  const res = await renderMermaid(
    SESSION,
    "flowchart LR\n  A[Draft] --> B[Compile]\n  B --> C{OK?}\n  C -->|no| A",
    "pipeline.png",
  );
  assert.equal(res.ok, true, res.output);
  assert.equal(res.file, "pipeline.png");
  await access(path.join(sessionDir(SESSION), "pipeline.png")); // throws if missing
  const compiled = await compileTex(
    SESSION,
    "\\documentclass{article}\\usepackage{graphicx}\\begin{document}\\includegraphics[width=0.9\\textwidth]{pipeline.png}\\end{document}",
  );
  assert.equal(compiled.ok, true, compiled.log);
});

test("renderMermaid strips ```mermaid fences the model tends to add", async () => {
  const res = await renderMermaid(SESSION, "```mermaid\npie\n  \"a\": 60\n  \"b\": 40\n```", "pie.png");
  assert.equal(res.ok, true, res.output);
});

test("renderMermaid reports syntax errors instead of crashing", async () => {
  const res = await renderMermaid(SESSION, "flowchart LR\n  A --> --> ???", "bad.png");
  assert.equal(res.ok, false);
  assert.ok(res.output.length > 0, "parser message is returned for the model to act on");
});

test("renderMermaid rejects unsafe filenames", async () => {
  const res = await renderMermaid(SESSION, "pie\n  \"a\": 1", "../escape.png");
  assert.equal(res.ok, false);
  assert.match(res.output, /filename/i);
});
