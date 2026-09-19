// The DeepInfra side of the picture: what is serving, what it costs, and what
// it can do.
//
// This reads through the same `isServingTextModel` and `toModel` the provider
// registers with, so a model the agent recommends is always a model pi can
// actually route to. Re-implementing the filter here would let the two drift.
import { isServingTextModel, toModel } from "../../../index.ts";

export const MODELS_URL = "https://api.deepinfra.com/models/list";

export const PROVIDER_ID = "deepinfra";

export async function fetchCatalog({ signal, path } = {}) {
  // Reading a saved catalog keeps the whole pipeline testable and usable
  // offline; the file holds exactly what the endpoint returns.
  if (path) {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(path, "utf8"));
  }
  const response = await fetch(MODELS_URL, { signal });
  if (!response.ok) {
    throw new Error(`DeepInfra catalog returned HTTP ${response.status}`);
  }
  return response.json();
}

// The thinking levels a reasoning model actually offers. pi hides a level from
// the picker when the map pins it to null, so the non-null keys are the truth.
export function availableEfforts(thinkingLevelMap) {
  if (!thinkingLevelMap) return [];
  return Object.entries(thinkingLevelMap)
    .filter(([, effort]) => effort !== null)
    .map(([level]) => level);
}

export function toRow(model) {
  const registered = toModel(model);
  return {
    id: registered.id,
    spec: `${PROVIDER_ID}/${registered.id}`,
    reasoning: registered.reasoning,
    // DeepInfra marks partner models separately: it serves those from the
    // partner's own infrastructure, so it cannot promise retention there. Its
    // model pages render a "Zero retention" chip on exactly the non-partner
    // set, which is what makes is_partner the ZDR signal.
    zdr: !model.is_partner,
    vision: registered.input.includes("image"),
    audio: model.tags.includes("input-audio"),
    video: model.tags.includes("input-video"),
    canDisableReasoning: model.tags.includes("can-disable-reasoning"),
    efforts: availableEfforts(registered.thinkingLevelMap),
    context: registered.contextWindow,
    // Kept alongside the effective context so a fallback can be reported as a
    // fallback rather than passed off as a measured window.
    contextReported: model.max_tokens && model.max_tokens > 0 ? model.max_tokens : null,
    maxTokens: registered.maxTokens,
    cost: registered.cost,
    discount: model.pricing?.discount ?? null,
    discountEndsAt: model.pricing?.discount_ends_at ?? null,
    cacheMultiplier: model.pricing?.rate_per_input_token_cached ?? null,
    tags: model.tags,
    description: model.description ?? "",
  };
}

// A 3:1 input:output blend, the convention Artificial Analysis uses for its
// own blended price. Holding the ratio fixed is what makes a score per dollar
// figure comparable when the score source changes.
export function blendedPrice(cost, { inputRatio = 3 } = {}) {
  return (cost.input * inputRatio + cost.output) / (inputRatio + 1);
}

export async function servingModels({ signal, path } = {}) {
  const catalog = await fetchCatalog({ signal, path });
  return catalog
    .filter(isServingTextModel)
    .map(toRow)
    .sort((a, b) => a.id.localeCompare(b.id));
}
