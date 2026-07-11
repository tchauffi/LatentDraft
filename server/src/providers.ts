import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV1 } from "ai";

export type ProviderId = "ollama" | "openai-compatible" | "anthropic";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Whether this provider is usable given the current environment/config. */
  available: boolean;
  /** Model ids the user can pick. */
  models: string[];
  /** Reason it is unavailable, for the UI. */
  note?: string;
}

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

/** OpenAI-compatible host (LM Studio, OpenRouter, vLLM, a hosted OpenAI, ...). */
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL; // e.g. https://api.openai.com/v1
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODELS = (process.env.OPENAI_MODELS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODELS = (process.env.ANTHROPIC_MODELS ?? "claude-opus-4-8,claude-sonnet-5")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface OllamaTag {
  name: string;
}

async function listOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: OllamaTag[] };
    return (data.models ?? []).map((m) => m.name).sort();
  } catch {
    return [];
  }
}

/** Enumerate providers and their models for the picker. */
export async function listProviders(): Promise<ProviderInfo[]> {
  const ollamaModels = await listOllamaModels();

  const providers: ProviderInfo[] = [
    {
      id: "ollama",
      label: "Ollama (local)",
      available: ollamaModels.length > 0,
      models: ollamaModels,
      note:
        ollamaModels.length > 0
          ? undefined
          : `No models found at ${OLLAMA_BASE_URL}. Is 'ollama serve' running and a model pulled?`,
    },
    {
      id: "openai-compatible",
      label: "OpenAI-compatible",
      available: Boolean(OPENAI_BASE_URL),
      models: OPENAI_MODELS,
      note: OPENAI_BASE_URL
        ? OPENAI_MODELS.length
          ? undefined
          : "Set OPENAI_MODELS to a comma-separated list of model ids."
        : "Set OPENAI_BASE_URL (and OPENAI_API_KEY) to enable.",
    },
    {
      id: "anthropic",
      label: "Anthropic",
      available: Boolean(ANTHROPIC_API_KEY),
      models: ANTHROPIC_MODELS,
      note: ANTHROPIC_API_KEY ? undefined : "Set ANTHROPIC_API_KEY to enable.",
    },
  ];

  return providers;
}

/** Build an AI SDK language model from a provider id + model id. */
export function getModel(providerId: ProviderId, modelId: string): LanguageModelV1 {
  switch (providerId) {
    case "ollama": {
      const provider = createOpenAI({
        baseURL: `${OLLAMA_BASE_URL}/v1`,
        apiKey: "ollama", // Ollama ignores the key but the SDK requires a value.
      });
      return provider(modelId);
    }
    case "openai-compatible": {
      if (!OPENAI_BASE_URL) throw new Error("OPENAI_BASE_URL is not configured.");
      const provider = createOpenAI({
        baseURL: OPENAI_BASE_URL,
        apiKey: OPENAI_API_KEY ?? "unused",
      });
      return provider(modelId);
    }
    case "anthropic": {
      if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured.");
      const provider = createAnthropic({ apiKey: ANTHROPIC_API_KEY });
      return provider(modelId);
    }
    default:
      throw new Error(`Unknown provider: ${providerId}`);
  }
}
