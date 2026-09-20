import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import { CATALOG_CACHE_FILE, writeCache } from "./catalog-cache.js";

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
  discount?: number | null;
  rate_per_explicit_cache_write_token?: Record<string, number> | null;
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
// Callers pass the effective input price, because DeepInfra scales the cached
// rate with the discount rather than with the list price.
function perMillionCached(
  rate: number | null | undefined,
  inputPerMillion: number,
): number {
  return (rate ?? 0) * inputPerMillion;
}

// The cents-per-token fields are the list price and `discount` is the fraction
// off it, so 0.3 means pay 70%. DeepInfra's model pages show both figures side
// by side with the discounted one as the current price, which makes it the
// price a request actually costs and the only one worth registering.
function costFor(model: DeepInfraModel): ProviderModelConfig["cost"] {
  const multiplier = 1 - (model.pricing?.discount ?? 0);
  const input = perMillion(model.pricing?.cents_per_input_token) * multiplier;
  return {
    input,
    output: perMillion(model.pricing?.cents_per_output_token) * multiplier,
    cacheRead: perMillionCached(model.pricing?.rate_per_input_token_cached, input),
    cacheWrite: perMillionCached(model.pricing?.rate_per_input_token_cache_write, input),
  };
}

// DeepInfra's OpenAI-compatible endpoint validates reasoning_effort against
// the full OpenAI-style scale and rejects anything else with HTTP 422, so
// every reasoning model can take minimal through max. The catalog's only
// per-model signal is can-disable-reasoning: on those models reasoning_effort
// "none" turns reasoning off, so the off level is real; on the others the
// model reasons no matter what is asked, so off is a lie and is hidden from
// the picker. xhigh and max must map to a non-null string or pi leaves them
// out of the thinking-level cycle, so they ride the full scale too.
const FULL_EFFORT_SCALE: Record<string, string> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

// DeepInfra records reasoning two ways: the `reasoning` tag on models that
// reason by default, and `can-disable-reasoning` on models where
// `reasoning_effort: "none"` turns it off. Several models carry only the
// second, sometimes next to a stale `non-reasoning`. A model that accepts
// `none` has reasoning to disable, so either tag proves the capability;
// reading only `reasoning` left those models without thinking levels, and on
// the ones that default to no reasoning it left them running silently.
function isReasoningModel(model: DeepInfraModel): boolean {
  return model.tags.includes("reasoning") || model.tags.includes("can-disable-reasoning");
}

function thinkingLevelMap(model: DeepInfraModel): ProviderModelConfig["thinkingLevelMap"] {
  if (!isReasoningModel(model)) return undefined;
  const canDisable = model.tags.includes("can-disable-reasoning");
  return { ...FULL_EFFORT_SCALE, off: canDisable ? "none" : null };
}

export function toModel(model: DeepInfraModel): ProviderModelConfig {
  const contextWindow =
    model.max_tokens && model.max_tokens > 0 ? model.max_tokens : DEFAULT_CONTEXT_WINDOW;
  return {
    id: model.model_name,
    name: model.model_name,
    reasoning: isReasoningModel(model),
    thinkingLevelMap: thinkingLevelMap(model),
    input: model.tags.includes("multimodal") ? ["text", "image"] : ["text"],
    cost: costFor(model),
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

async function fetchCatalog(signal?: AbortSignal): Promise<DeepInfraModel[]> {
  const response = await fetch(MODELS_URL, { signal });
  if (!response.ok) throw new Error(`DeepInfra catalog returned HTTP ${response.status}`);
  return (await response.json()) as DeepInfraModel[];
}

export function toModels(catalog: DeepInfraModel[]): ProviderModelConfig[] {
  return catalog
    .filter(isServingTextModel)
    .map(toModel)
    .sort((a, b) => a.id.localeCompare(b.id));
}

// pi publishes the returned list in memory, but persistence is the
// provider's job: publish() writes the catalog so the next offline start
// can serve it from context.stored.
export async function refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
  // pi calls this twice: once with the network off to restore the catalog it
  // already has, then again with the network on. The stored list belongs to the
  // offline pass, which leaves the online pass free to report a failure where pi
  // will surface it. Catching there instead meant a failed fetch put stale
  // prices in the model picker and looked like a successful refresh.
  if (context.allowNetwork) {
    const catalog = await fetchCatalog(context.signal);
    // pi keeps only the converted models, and that conversion drops the tags
    // and discount fields the skill filters on. Caching the raw download is
    // what lets the skill answer without fetching the same bytes again.
    await writeCache(CATALOG_CACHE_FILE, { data: catalog });
    const models = toModels(catalog);
    await context.publish({
      persist: {
        models: models as unknown as Model<Api>[],
        checkedAt: Date.now(),
      },
    });
    return models;
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
