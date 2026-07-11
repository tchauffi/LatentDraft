import { test } from "node:test";
import assert from "node:assert/strict";
import { locateSuggestion } from "../src/lib/inlineSuggest";

test("locateSuggestion finds a unique occurrence", () => {
  assert.deepEqual(locateSuggestion("abc def ghi", "def"), { from: 4, to: 7 });
});

test("locateSuggestion returns null when the text is missing", () => {
  assert.equal(locateSuggestion("abc", "zzz"), null);
});

test("locateSuggestion returns null for ambiguous matches", () => {
  assert.equal(locateSuggestion("dup … dup", "dup"), null);
});

test("locateSuggestion returns null for whole-document edits", () => {
  assert.equal(locateSuggestion("anything", ""), null);
});

test("locateSuggestion handles multi-line anchors", () => {
  const doc = "line one\nline two\nline three\n";
  assert.deepEqual(locateSuggestion(doc, "line two\nline three"), { from: 9, to: 28 });
});
