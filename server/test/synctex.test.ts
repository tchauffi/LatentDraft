import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compileProject } from "../src/compile.js";
import { parseSyncTex, forwardSearch, reverseSearch, loadProjectSyncTex } from "../src/synctex.js";

const DIR = path.join(os.tmpdir(), `lat-synctex-${Date.now().toString(36)}`);

after(async () => {
  await rm(DIR, { recursive: true, force: true });
});

test("parseSyncTex reads the tag table and records from a fixture", () => {
  const fixture = [
    "SyncTeX Version:1",
    `Input:1:${DIR}/main.tex`,
    "Input:2:",
    `Input:7:${DIR}/sections/intro.tex`,
    "Output:pdf",
    "Unit:1",
    "Content:",
    "{1",
    "(1,3:6553600,13107200:100,200,300",
    "h7,1:6553600,26214400:0,0,0",
    "}",
    "{2",
    "(1,8:6553600,13107200:100,200,300",
    "}",
  ].join("\n");
  const data = parseSyncTex(fixture, DIR);
  assert.deepEqual(
    [...data.inputs.entries()],
    [
      [1, "main.tex"],
      [7, "sections/intro.tex"],
    ],
  );
  assert.equal(data.records.length, 3);
  // sp → pt conversion: 6553600 / 65536 = 100pt.
  assert.deepEqual(data.records[0], { page: 1, tag: 1, line: 3, x: 100, y: 200 });

  // Forward: line in the \input'd file lands on page 1.
  assert.deepEqual(forwardSearch(data, "sections/intro.tex", 1), { page: 1, x: 100, y: 400 });
  // Forward: main.tex line 8 is on page 2; asking for line 5 snaps forward to it.
  assert.equal(forwardSearch(data, "main.tex", 5)!.page, 2);
  // Reverse: a click near the intro record maps back to the intro file.
  assert.deepEqual(reverseSearch(data, 1, 90, 390), { file: "sections/intro.tex", line: 1 });
  assert.equal(forwardSearch(data, "unknown.tex", 1), undefined);
});

test("a real project compile produces synctex that round-trips across files", async () => {
  await mkdir(path.join(DIR, "sections"), { recursive: true });
  await writeFile(
    path.join(DIR, "main.tex"),
    [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{One}",
      "First page content.",
      "\\input{sections/intro}",
      "\\newpage",
      "\\section{Two}",
      "Second page content here.",
      "\\end{document}",
    ].join("\n"),
  );
  await writeFile(path.join(DIR, "sections/intro.tex"), "Intro line from an aux file.\n");

  const compiled = await compileProject(DIR);
  assert.equal(compiled.ok, true, compiled.log);

  const data = (await loadProjectSyncTex(DIR))!;
  assert.ok(data, "synctex data must load after a compile");

  // Forward: a line in the \input'd file resolves to a position on page 1.
  const fwd = forwardSearch(data, "sections/intro.tex", 1)!;
  assert.equal(fwd.page, 1);
  assert.ok(fwd.y > 0 && fwd.y < 900, `y on the page, got ${fwd.y}`);

  // …and page 2 content resolves to page 2.
  const fwd2 = forwardSearch(data, "main.tex", 8)!;
  assert.equal(fwd2.page, 2);

  // Inverse: clicking exactly where forward pointed returns the same file.
  const rev = reverseSearch(data, fwd.page, fwd.x, fwd.y)!;
  assert.equal(rev.file, "sections/intro.tex");
});
