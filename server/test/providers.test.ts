import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveOllamaContext } from "../src/providers.js";

// The window reported to the UI must be where truncation ACTUALLY starts:
// the baked-in num_ctx, capped at the model's native maximum.

test("effectiveOllamaContext caps the baked num_ctx at the native window", () => {
  assert.equal(effectiveOllamaContext(131_072, 16_384), 16_384); // big model, our cap wins
  assert.equal(effectiveOllamaContext(8_192, 16_384), 8_192); // small model, native wins
});

test("effectiveOllamaContext falls back to num_ctx when native is unknown", () => {
  assert.equal(effectiveOllamaContext(undefined, 16_384), 16_384);
});

test("effectiveOllamaContext with variants disabled reports the native window", () => {
  assert.equal(effectiveOllamaContext(8_192, 0), 8_192);
  assert.equal(effectiveOllamaContext(undefined, 0), undefined);
});
