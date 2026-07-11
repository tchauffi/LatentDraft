import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contextSeverity,
  estimateRequestTokens,
  formatTokens,
  PROMPT_OVERHEAD_TOKENS,
} from "../src/lib/context";

test("estimateRequestTokens counts document, history, draft, and overhead", () => {
  const est = estimateRequestTokens({
    documentText: "x".repeat(4000), // 1000 tokens
    history: [{ content: "y".repeat(400) }, { content: "z".repeat(400) }], // 200
    draft: "w".repeat(200), // 50
  });
  assert.equal(est, PROMPT_OVERHEAD_TOKENS + 1000 + 200 + 50);
});

test("estimateRequestTokens caps the compile log at the server's truncation", () => {
  const withHugeLog = estimateRequestTokens({
    documentText: "",
    history: [],
    compileLog: "e".repeat(50_000),
  });
  // Only 2000 chars of the log ever reach the prompt.
  assert.equal(withHugeLog, PROMPT_OVERHEAD_TOKENS + 500);
});

test("formatTokens renders plain, one-decimal-k, and round-k forms", () => {
  assert.equal(formatTokens(850), "850");
  assert.equal(formatTokens(12_345), "12.3k");
  assert.equal(formatTokens(16_384), "16.4k");
  assert.equal(formatTokens(200_000), "200k");
  assert.equal(formatTokens(2_000), "2k"); // trailing .0 stripped
});

test("contextSeverity thresholds", () => {
  assert.equal(contextSeverity(1000, undefined), "unknown");
  assert.equal(contextSeverity(1000, 16_384), "ok");
  assert.equal(contextSeverity(12_300, 16_384), "warn"); // ≥75%
  assert.equal(contextSeverity(16_384, 16_384), "over");
  assert.equal(contextSeverity(20_000, 16_384), "over");
});
