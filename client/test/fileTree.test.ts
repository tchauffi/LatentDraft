import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFileTree, isImageFile, moveTarget, parentOf } from "../src/lib/fileTree";

test("buildFileTree nests directories and marks generated files", () => {
  const tree = buildFileTree(
    ["main.tex", "refs.bib", "sections/intro.tex"],
    ["sine_wave.png", "sections/intro.tex"],
  );
  assert.deepEqual(tree, [
    {
      name: "sections",
      path: "sections",
      children: [{ name: "intro.tex", path: "sections/intro.tex" }],
    },
    { name: "main.tex", path: "main.tex" },
    { name: "refs.bib", path: "refs.bib" },
    { name: "sine_wave.png", path: "sine_wave.png", generated: true },
  ]);
});

test("buildFileTree pins main.tex first at the root only", () => {
  const tree = buildFileTree(["a.tex", "main.tex"], []);
  assert.equal(tree[0].path, "main.tex");
  assert.equal(tree[1].path, "a.tex");
});

test("buildFileTree keeps an editable file editable when the server also lists it", () => {
  const tree = buildFileTree(["refs.bib"], ["refs.bib"]);
  assert.deepEqual(tree, [{ name: "refs.bib", path: "refs.bib" }]);
});

test("buildFileTree of nothing is empty", () => {
  assert.deepEqual(buildFileTree([], []), []);
});

test("isImageFile matches image extensions only", () => {
  assert.equal(isImageFile("sine_wave.png"), true);
  assert.equal(isImageFile("photo.JPG"), true);
  assert.equal(isImageFile("refs.bib"), false);
  assert.equal(isImageFile("notes.txt"), false);
});

test("buildFileTree shows empty directories from the dirs listing", () => {
  const tree = buildFileTree(["main.tex"], [], ["data", "data/raw", "sections"]);
  assert.deepEqual(tree, [
    {
      name: "data",
      path: "data",
      children: [{ name: "raw", path: "data/raw", children: [] }],
    },
    { name: "sections", path: "sections", children: [] },
    { name: "main.tex", path: "main.tex" },
  ]);
});

test("buildFileTree merges dirs with file-derived directories without duplicates", () => {
  const tree = buildFileTree(["sections/intro.tex", "main.tex"], [], ["sections"]);
  assert.deepEqual(tree, [
    {
      name: "sections",
      path: "sections",
      children: [{ name: "intro.tex", path: "sections/intro.tex" }],
    },
    { name: "main.tex", path: "main.tex" },
  ]);
});

test("moveTarget puts the dragged entry under the destination folder", () => {
  assert.deepEqual(moveTarget("refs.bib", "sections"), { ok: true, to: "sections/refs.bib" });
  assert.deepEqual(moveTarget("sections/intro.tex", ""), { ok: true, to: "intro.tex" });
  // A folder moves as its basename, not its whole path.
  assert.deepEqual(moveTarget("data/raw", "archive"), { ok: true, to: "archive/raw" });
});

test("moveTarget rejects a drop on the folder the entry is already in", () => {
  assert.deepEqual(moveTarget("sections/intro.tex", "sections"), { ok: false });
  assert.deepEqual(moveTarget("refs.bib", ""), { ok: false });
});

test("moveTarget refuses to bury a folder inside itself", () => {
  assert.equal(moveTarget("data", "data").ok, false);
  const nested = moveTarget("data", "data/raw");
  assert.equal(nested.ok, false);
  assert.match((nested as { reason: string }).reason, /into itself/);
});

test("moveTarget refuses to move main.tex — it is the compile target", () => {
  const r = moveTarget("main.tex", "sections");
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /compile target/);
});

test("parentOf returns the containing folder, empty at the root", () => {
  assert.equal(parentOf("sections/intro.tex"), "sections");
  assert.equal(parentOf("data/raw/x.csv"), "data/raw");
  assert.equal(parentOf("main.tex"), "");
});
