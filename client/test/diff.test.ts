import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEdit,
  parseLatexEditBlocks,
  stripLatexEditBlocks,
  extractFullDocLatex,
  stripLatexDocBlock,
} from "../src/lib/diff";

const edit = (old_string: string, new_string: string) => ({
  id: "e1",
  explanation: "",
  old_string,
  new_string,
});

test("applyEdit replaces a unique occurrence", () => {
  const res = applyEdit("one two three", edit("two", "2"));
  assert.deepEqual(res, { ok: true, doc: "one 2 three" });
});

test("applyEdit reports not-found", () => {
  const res = applyEdit("one two three", edit("four", "4"));
  assert.deepEqual(res, { ok: false, reason: "not-found" });
});

test("applyEdit reports ambiguous matches", () => {
  const res = applyEdit("aba aba", edit("aba", "x"));
  assert.deepEqual(res, { ok: false, reason: "ambiguous" });
});

test("applyEdit with an empty old_string replaces the whole document", () => {
  const res = applyEdit("anything at all", edit("", "fresh document"));
  assert.deepEqual(res, { ok: true, doc: "fresh document" });
});

const FENCED = [
  "Here is the change:",
  "```latex-edit",
  "@@ explanation: fix the title",
  "<<<<<<< OLD",
  "\\title{Old}",
  "=======",
  "\\title{New}",
  ">>>>>>> NEW",
  "```",
  "Done.",
].join("\n");

test("parseLatexEditBlocks extracts old/new/explanation from a fenced block", () => {
  const edits = parseLatexEditBlocks(FENCED);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].explanation, "fix the title");
  assert.equal(edits[0].old_string, "\\title{Old}");
  assert.equal(edits[0].new_string, "\\title{New}");
});

test("stripLatexEditBlocks removes the fence but keeps surrounding prose", () => {
  const stripped = stripLatexEditBlocks(FENCED);
  assert.match(stripped, /Here is the change:/);
  assert.match(stripped, /Done\./);
  assert.doesNotMatch(stripped, /<<<<<<< OLD/);
});

test("extractFullDocLatex finds a complete document and prefers the largest", () => {
  const small = "\\documentclass{article}\\begin{document}A\\end{document}";
  const large = "\\documentclass{article}\\begin{document}Much longer body here\\end{document}";
  const text = "```latex\n" + small + "\n```\ntext\n```tex\n" + large + "\n```";
  assert.equal(extractFullDocLatex(text), large);
});

test("extractFullDocLatex ignores fragments that are not full documents", () => {
  assert.equal(extractFullDocLatex("```latex\n\\section{Only a fragment}\n```"), null);
});

test("stripLatexDocBlock removes only the matching fenced document", () => {
  const body = "\\documentclass{article}\\begin{document}X\\end{document}";
  const text = "Intro\n```latex\n" + body + "\n```\nOutro";
  const stripped = stripLatexDocBlock(text, body);
  assert.match(stripped, /Intro/);
  assert.match(stripped, /Outro/);
  assert.doesNotMatch(stripped, /documentclass/);
});
