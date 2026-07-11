import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveOllamaContext,
  ensureOllamaContextVariant,
  isOllamaCloudModel,
} from "../src/providers.js";

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

test("isOllamaCloudModel recognizes daemon-proxied cloud models", () => {
  assert.equal(isOllamaCloudModel("gpt-oss:120b-cloud"), true);
  assert.equal(isOllamaCloudModel("deepseek-v3.1:671b-cloud"), true);
  assert.equal(isOllamaCloudModel("qwen2.5-coder:latest"), false);
  assert.equal(isOllamaCloudModel("cloudy-model:7b"), false);
});

test("ensureOllamaContextVariant leaves cloud models untouched", async () => {
  // Cloud models run remotely — no local num_ctx variant must be created.
  // This must short-circuit BEFORE any network call to the Ollama daemon.
  assert.equal(await ensureOllamaContextVariant("gpt-oss:120b-cloud"), "gpt-oss:120b-cloud");
});
