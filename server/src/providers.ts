import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";

export type ProviderId = "ollama" | "ollama-cloud" | "openai-compatible" | "anthropic";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Whether this provider is usable given the current environment/config. */
  available: boolean;
  /** Model ids the user can pick. */
  models: string[];
  /** Reason it is unavailable, for the UI. */
  note?: string;
  /** modelId → usable context window in tokens, when known. For Ollama this is
   * the EFFECTIVE window (the num_ctx we bake in, capped at the model's native
   * maximum), since that is where silent truncation actually starts. */
  context?: Record<string, number>;
}

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

/**
 * Context window to run Ollama models with. Ollama loads every model with a
 * small default context (4096 in current builds) and SILENTLY TRUNCATES the
 * prompt from the top when it overflows — which deletes the system prompt
 * (all the tool instructions) on any real task. The OpenAI-compatible endpoint
 * ignores `options.num_ctx`, so we bake the context into a derived model
 * variant instead (see ensureOllamaContextVariant). Set OLLAMA_NUM_CTX=0 to
 * disable and use the models as-is.
 */
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 16384);

/** Tag that marks the derived context variants we create ("ollama rm" to clean up). */
const VARIANT_TAG = "latentdraft";

/**
 * Ollama Cloud, used DIRECTLY (https://ollama.com with an API key) rather than
 * proxied through the local daemon. Set OLLAMA_CLOUD_API_KEY (or OLLAMA_API_KEY)
 * to enable. Model list comes from the cloud /api/tags; OLLAMA_CLOUD_MODELS
 * overrides it when set (comma-separated).
 */
const OLLAMA_CLOUD_BASE_URL = process.env.OLLAMA_CLOUD_BASE_URL ?? "https://ollama.com";
const OLLAMA_CLOUD_API_KEY =
  process.env.OLLAMA_CLOUD_API_KEY ?? process.env.OLLAMA_API_KEY;
const OLLAMA_CLOUD_MODELS = (process.env.OLLAMA_CLOUD_MODELS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * A signed-in local daemon lists Ollama Cloud models alongside local ones
 * (they carry a "-cloud" suffix). They run remotely: baking a num_ctx variant
 * is meaningless (and /api/create may reject it), and the local NUM_CTX cap
 * does not apply to their context window.
 */
export function isOllamaCloudModel(modelId: string): boolean {
  return /-cloud(:|$)/.test(modelId);
}

/** OpenAI-compatible host (LM Studio, OpenRouter, vLLM, a hosted OpenAI, ...). */
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL; // e.g. https://api.openai.com/v1
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODELS = (process.env.OPENAI_MODELS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Context window to report for OpenAI-compatible models (the server can't
 * discover it — LM Studio/vLLM/OpenRouter all differ). Unset = unknown. */
const OPENAI_CONTEXT_LENGTH = Number(process.env.OPENAI_CONTEXT_LENGTH ?? 0);

/** All current Claude models have (at least) a 200k context window. */
const ANTHROPIC_CONTEXT_LENGTH = 200_000;

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
    return (data.models ?? [])
      .map((m) => m.name)
      // Hide the derived context variants — the picker shows base models and
      // the chat route swaps in the variant transparently.
      .filter((name) => !name.endsWith(`:${VARIANT_TAG}`))
      .sort();
  } catch {
    return [];
  }
}

/** Models available on Ollama Cloud, via its /api/tags. The catalog endpoint
 * is PUBLIC (only chatting needs the API key), so list regardless of key —
 * the picker can show what's available even before the key is configured.
 * OLLAMA_CLOUD_MODELS overrides the listing when set. */
async function listOllamaCloudModels(): Promise<string[]> {
  if (OLLAMA_CLOUD_MODELS.length > 0) return OLLAMA_CLOUD_MODELS;
  try {
    const res = await fetch(`${OLLAMA_CLOUD_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: OllamaTag[] };
    return (data.models ?? []).map((m) => m.name).sort();
  } catch {
    return [];
  }
}

const nativeContextCache = new Map<string, number | undefined>();

/** The model's native maximum context, from Ollama's model metadata
 * (`model_info["<arch>.context_length"]`). Works against the local daemon or,
 * with an API key, Ollama Cloud. Undefined when unavailable. */
async function ollamaNativeContext(
  modelId: string,
  baseUrl = OLLAMA_BASE_URL,
  apiKey?: string,
): Promise<number | undefined> {
  const cacheKey = `${baseUrl}:${modelId}`;
  if (nativeContextCache.has(cacheKey)) return nativeContextCache.get(cacheKey);
  let ctx: number | undefined;
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as { model_info?: Record<string, unknown> };
      const info = data.model_info ?? {};
      const arch = info["general.architecture"];
      const raw = typeof arch === "string" ? info[`${arch}.context_length`] : undefined;
      if (typeof raw === "number" && raw > 0) ctx = raw;
    }
  } catch {
    /* leave unknown */
  }
  nativeContextCache.set(cacheKey, ctx);
  return ctx;
}

/**
 * The context window an Ollama model EFFECTIVELY runs with here: the num_ctx
 * we bake into the derived variant, capped at the model's native maximum.
 * With variants disabled (numCtx <= 0) it is the native window — though
 * Ollama's own small default then truncates far earlier.
 */
export function effectiveOllamaContext(
  native: number | undefined,
  numCtx = OLLAMA_NUM_CTX,
): number | undefined {
  if (!(numCtx > 0)) return native;
  return native ? Math.min(native, numCtx) : numCtx;
}

const ensuredVariants = new Set<string>();

/**
 * Return the name of a derived Ollama model that is `modelId` plus a baked-in
 * `num_ctx` of OLLAMA_NUM_CTX, creating it on the Ollama server if needed
 * (instant — it is a metadata-only layer over the same weights). Falls back to
 * the base model if creation fails, so a broken Ollama create API degrades to
 * the old behavior instead of blocking chat.
 */
export async function ensureOllamaContextVariant(modelId: string): Promise<string> {
  // Cloud models proxied by the local daemon run remotely with their own
  // (large) context — a local num_ctx variant is meaningless for them.
  if (isOllamaCloudModel(modelId)) return modelId;
  if (!(OLLAMA_NUM_CTX > 0) || modelId.endsWith(`:${VARIANT_TAG}`)) return modelId;
  const name = `${modelId.replace(/[:/]/g, "-")}-ctx${OLLAMA_NUM_CTX}:${VARIANT_TAG}`;
  if (ensuredVariants.has(name)) return name;
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: name,
        from: modelId,
        parameters: { num_ctx: OLLAMA_NUM_CTX },
        stream: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    ensuredVariants.add(name);
    return name;
  } catch (err) {
    console.warn(
      `[server] could not create context variant ${name} (${String(err)}); ` +
        `using ${modelId} with Ollama's default context — long tasks may get truncated.`,
    );
    return modelId;
  }
}

/** Enumerate providers and their models for the picker. */
export async function listProviders(): Promise<ProviderInfo[]> {
  const ollamaModels = await listOllamaModels();

  const ollamaContext: Record<string, number> = {};
  await Promise.all(
    ollamaModels.map(async (m) => {
      const native = await ollamaNativeContext(m);
      // Daemon-proxied cloud models run remotely: NUM_CTX does not cap them.
      const eff = isOllamaCloudModel(m) ? native : effectiveOllamaContext(native);
      if (eff) ollamaContext[m] = eff;
    }),
  );

  const cloudModels = await listOllamaCloudModels();
  const cloudContext: Record<string, number> = {};
  await Promise.all(
    cloudModels.map(async (m) => {
      const native = await ollamaNativeContext(m, OLLAMA_CLOUD_BASE_URL, OLLAMA_CLOUD_API_KEY);
      if (native) cloudContext[m] = native;
    }),
  );

  const providers: ProviderInfo[] = [
    {
      id: "ollama",
      label: "Ollama (local)",
      available: ollamaModels.length > 0,
      models: ollamaModels,
      context: ollamaContext,
      note:
        ollamaModels.length > 0
          ? undefined
          : `No models found at ${OLLAMA_BASE_URL}. Is 'ollama serve' running and a model pulled?`,
    },
    {
      id: "ollama-cloud",
      label: "Ollama Cloud",
      available: Boolean(OLLAMA_CLOUD_API_KEY) && cloudModels.length > 0,
      models: cloudModels,
      context: cloudContext,
      note: OLLAMA_CLOUD_API_KEY
        ? cloudModels.length
          ? undefined
          : `No models listed by ${OLLAMA_CLOUD_BASE_URL} — set OLLAMA_CLOUD_MODELS to name them explicitly.`
        : "Set OLLAMA_CLOUD_API_KEY to an ollama.com API key (create one at ollama.com/settings/keys) in the shell that runs the server, then restart. Signing in with 'ollama signin' is NOT enough for the direct cloud provider.",
    },
    {
      id: "openai-compatible",
      label: "OpenAI-compatible",
      available: Boolean(OPENAI_BASE_URL),
      models: OPENAI_MODELS,
      context:
        OPENAI_CONTEXT_LENGTH > 0
          ? Object.fromEntries(OPENAI_MODELS.map((m) => [m, OPENAI_CONTEXT_LENGTH]))
          : undefined,
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
      context: Object.fromEntries(ANTHROPIC_MODELS.map((m) => [m, ANTHROPIC_CONTEXT_LENGTH])),
      note: ANTHROPIC_API_KEY ? undefined : "Set ANTHROPIC_API_KEY to enable.",
    },
  ];

  return providers;
}

/**
 * Build an AI SDK v5 language model (LanguageModelV2 spec) for a provider id +
 * model id. These plug directly into a Mastra Agent's `model` slot; the v2
 * spec is required for Mastra's modern `agent.stream()` loop.
 */
export function getModel(providerId: ProviderId, modelId: string) {
  switch (providerId) {
    case "ollama": {
      const provider = createOpenAICompatible({
        name: "ollama",
        baseURL: `${OLLAMA_BASE_URL}/v1`,
      });
      return provider(modelId);
    }
    case "ollama-cloud": {
      if (!OLLAMA_CLOUD_API_KEY) throw new Error("OLLAMA_CLOUD_API_KEY is not configured.");
      const provider = createOpenAICompatible({
        name: "ollama-cloud",
        baseURL: `${OLLAMA_CLOUD_BASE_URL}/v1`,
        apiKey: OLLAMA_CLOUD_API_KEY,
      });
      return provider(modelId);
    }
    case "openai-compatible": {
      if (!OPENAI_BASE_URL) throw new Error("OPENAI_BASE_URL is not configured.");
      const provider = createOpenAICompatible({
        name: "openai-compatible",
        baseURL: OPENAI_BASE_URL,
        apiKey: OPENAI_API_KEY,
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

export type ProviderModel = ReturnType<typeof getModel>;

const visionCache = new Map<string, boolean>();

/**
 * Whether a model can accept image parts. Sending images to a text-only model
 * makes Ollama reject the WHOLE request (400 "does not support multimodal"),
 * killing the turn — so default to false unless we positively know better.
 */
export async function modelSupportsVision(
  providerId: ProviderId,
  modelId: string,
): Promise<boolean> {
  if (providerId === "anthropic") return true; // all current Claude models are multimodal
  if (providerId !== "ollama" && providerId !== "ollama-cloud") {
    return false; // openai-compatible: unknowable — play safe
  }
  const baseUrl = providerId === "ollama-cloud" ? OLLAMA_CLOUD_BASE_URL : OLLAMA_BASE_URL;
  const key = `${providerId}:${modelId}`;
  const cached = visionCache.get(key);
  if (cached !== undefined) return cached;
  let vision = false;
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as { capabilities?: string[] };
      vision = Array.isArray(data.capabilities) && data.capabilities.includes("vision");
    }
  } catch {
    /* treat as text-only */
  }
  visionCache.set(key, vision);
  return vision;
}
