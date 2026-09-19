// Joining DeepInfra's model ids to another site's names.
//
// Every source spells a model differently: DeepInfra says `deepseek-ai/DeepSeek-V4-Flash`,
// Epoch says `DeepSeek V4 Flash 0731`, the Arena says `deepseek-v4-flash`. The
// normalization below is deliberately conservative — it strips only packaging
// suffixes and release dates, never words that distinguish one model from
// another. A missed match costs a data point; a wrong match silently ranks the
// wrong model, which is worse.
import { blendedPrice } from "./catalog.mjs";

const PACKAGING_SUFFIXES = ["instruct", "chat", "turbo", "fp8", "bf16", "awq", "gptq", "gguf"];

export function normalizeName(name) {
  let normalized = name.toLowerCase().split("/").pop() ?? "";
  normalized = normalized.replace(/[-_]?\d{4}-\d{2}-\d{2}$/, "");
  normalized = normalized.replace(/[-_]?\d{8}$/, "");
  normalized = normalized.replace(/[-_]?\d{4}$/, "");
  // Packaging suffixes stack, as in `Meta-Llama-3.1-8B-Instruct-Turbo`, so keep
  // stripping until none is left.
  let previous;
  do {
    previous = normalized;
    for (const suffix of PACKAGING_SUFFIXES) {
      normalized = normalized.replace(new RegExp(`[-_]${suffix}$`), "");
    }
  } while (normalized !== previous);
  return normalized.replace(/[^a-z0-9]/g, "");
}

function indexByNormalizedName(rows, nameOf) {
  const index = new Map();
  for (const row of rows) {
    const key = normalizeName(nameOf(row));
    const bucket = index.get(key);
    if (bucket) bucket.push(row);
    else index.set(key, [row]);
  }
  return index;
}

// Returns the scored pairs plus everything that did not join cleanly. Callers
// are expected to print the misses: a source that covers two thirds of the
// catalog is still useful, but only if the gap is visible.
export function matchScores(models, scores) {
  const modelIndex = indexByNormalizedName(models, (model) => model.id);
  const scoreIndex = indexByNormalizedName(scores, (score) => score.name);

  const pairs = [];
  const shared = new Map();
  const unscored = [];

  for (const model of models) {
    const key = normalizeName(model.id);
    const candidates = scoreIndex.get(key);
    if (!candidates) {
      unscored.push(model);
      continue;
    }
    const best = candidates.reduce((a, b) => ((b.votes ?? 0) > (a.votes ?? 0) ? b : a));
    // Several catalog entries collapsing onto one benchmark name means the
    // source does not distinguish those variants — a dated snapshot and its
    // base model, or a plain and a Turbo build. They are the same model family,
    // so the score applies to all of them, but the caller should say so rather
    // than present a family score as if it were measured per entry.
    const sameKey = modelIndex.get(key) ?? [];
    const isShared = sameKey.length > 1;
    if (isShared) shared.set(key, { name: best.name, models: sameKey.map((m) => m.id) });
    pairs.push({ model, score: best.score, matchedName: best.name, shared: isShared });
  }

  return { pairs, unscored, shared: [...shared.values()] };
}

export function rankByValue(pairs, { inputRatio = 3 } = {}) {
  return pairs
    .map((pair) => {
      const blended = blendedPrice(pair.model.cost, { inputRatio });
      return { ...pair, blended, value: blended > 0 ? pair.score / blended : Infinity };
    })
    .sort((a, b) => b.value - a.value);
}
