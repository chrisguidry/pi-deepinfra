import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "deepinfra";
const PROVIDER_NAME = "DeepInfra";
const BASE_URL = "https://api.deepinfra.com/v1/openai";
const MODELS_URL = "https://api.deepinfra.com/models/list";

// DeepInfra catalogs in cents per token; pi tracks cost in dollars per
// million tokens.
const TO_DOLLARS_PER_MILLION = 1_000_000 / 100;

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

interface DeepInfraPricing {
  cents_per_input_token?: number | null;
  cents_per_output_token?: number | null;
  rate_per_input_token_cached?: number | null;
  rate_per_input_token_cache_write?: number | null;
}

interface DeepInfraModel {
  model_name: string;
  type: string;
  tags: string[];
  max_tokens: number | null;
  deprecated?: number | null;
  replaced_by?: string | null;
  pricing?: DeepInfraPricing;
}

// Only serving text-generation models that can call tools are useful to pi.
// Deprecated and replaced entries are gone or broken, and pi sends tool
// definitions on every request, so a model without the "tools" tag fails
// with HTTP 405.
export function isServingTextModel(model: DeepInfraModel): boolean {
  return (
    model.type === "text-generation" &&
    !model.deprecated &&
    !model.replaced_by &&
    model.tags.includes("openai") &&
    model.tags.includes("tools")
  );
}

function perMillion(centsPerToken: number | null | undefined): number {
  return (centsPerToken ?? 0) * TO_DOLLARS_PER_MILLION;
}

// The cache rate fields are multipliers on the input price (0.2 means cache
// reads cost 0.2x the input rate), unlike the cents-per-token price fields.
function perMillionCached(
  rate: number | null | undefined,
  inputPerMillion: number,
): number {
  return (rate ?? 0) * inputPerMillion;
}

// The catalog reports max_tokens per model; DeepInfra sets it to the model's
// context length, which is the only size signal the endpoint exposes.
// DeepInfra accepts reasoning_effort "none" and it disables reasoning, but
// only models tagged can-disable-reasoning honor it. On other reasoning
// models the "off" level would be a lie, so the map removes it from pi's
// thinking-level picker.
function thinkingLevelMap(model: DeepInfraModel): ProviderModelConfig["thinkingLevelMap"] {
  if (!model.tags.includes("reasoning")) return undefined;
  return model.tags.includes("can-disable-reasoning") ? { off: "none" } : { off: null };
}

export function toModel(model: DeepInfraModel): ProviderModelConfig {
  const contextWindow =
    model.max_tokens && model.max_tokens > 0 ? model.max_tokens : DEFAULT_CONTEXT_WINDOW;
  const inputPerMillion = perMillion(model.pricing?.cents_per_input_token);
  return {
    id: model.model_name,
    name: model.model_name,
    reasoning: model.tags.includes("reasoning"),
    thinkingLevelMap: thinkingLevelMap(model),
    input: model.tags.includes("multimodal") ? ["text", "image"] : ["text"],
    cost: {
      input: inputPerMillion,
      output: perMillion(model.pricing?.cents_per_output_token),
      cacheRead: perMillionCached(model.pricing?.rate_per_input_token_cached, inputPerMillion),
      cacheWrite: perMillionCached(model.pricing?.rate_per_input_token_cache_write, inputPerMillion),
    },
    contextWindow,
    maxTokens: Math.min(contextWindow, DEFAULT_MAX_TOKENS),
    // DeepInfra's OpenAI-compatible endpoint accepts only the system, user,
    // assistant, and tool roles. Without this override, pi sends the system
    // prompt with the "developer" role on reasoning models, and DeepInfra
    // returns HTTP 422.
    compat: {
      supportsDeveloperRole: false,
    },
  };
}

async function fetchServingModels(signal?: AbortSignal): Promise<ProviderModelConfig[]> {
  const response = await fetch(MODELS_URL, { signal });
  if (!response.ok) throw new Error(`DeepInfra catalog returned HTTP ${response.status}`);
  const catalog = (await response.json()) as DeepInfraModel[];
  return catalog.filter(isServingTextModel).map(toModel).sort((a, b) => a.id.localeCompare(b.id));
}

// pi publishes the returned list in memory, but persistence is the
// provider's job: publish() writes the catalog so the next offline start
// can serve it from context.stored.
export async function refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
  if (context.allowNetwork) {
    try {
      const models = await fetchServingModels(context.signal);
      await context.publish({
        persist: {
          models: models as unknown as Model<Api>[],
          checkedAt: Date.now(),
        },
      });
      return models;
    } catch (error) {
      // Aborts propagate in full; transient failures fall back to the stored catalog.
      if (context.signal.aborted) throw error;
    }
  }

  const stored = context.stored;
  return stored?.models?.length ? (stored.models as unknown as ProviderModelConfig[]) : [];
}

export default function (pi: ExtensionAPI) {
  // pi resolves apiKey references from config: $ENV_VAR, ${ENV_VAR}, a
  // literal, or a leading !command (for example
  // "!op read 'op://Vault/Item/credential'"). pi only auto-discovers env
  // keys for its built-in providers, so the extension registers the
  // DEEPINFRA_API_KEY reference itself when the variable is set. An
  // extension-registered apiKey overrides a models.json entry, so the
  // registration is conditional: without the variable, models.json remains
  // the only source.
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: BASE_URL,
    api: "openai-completions",
    ...(process.env.DEEPINFRA_API_KEY ? { apiKey: "$DEEPINFRA_API_KEY" } : {}),
    models: [],
    refreshModels,
  });
}
