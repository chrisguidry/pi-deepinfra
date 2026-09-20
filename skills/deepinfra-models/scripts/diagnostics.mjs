// Data-quality findings.
//
// Everything here is about telling the reader when a number is a guess, a
// placeholder, or a join that nearly happened. The catalog and the benchmark
// sites both change shape without warning, so a run that quietly drops a match
// or reports a fallback context window as though it were measured teaches the
// wrong thing.
//
// Findings are grouped by cause rather than listed per model. Twenty-one
// separate near misses are one normalization rule waiting to be written, and
// grouping is what makes that visible.
import { tagOverrides } from "../../../index.ts";
import { effortlessName, normalizeName } from "./match.mjs";

const SHARED_PREFIX_MIN_LENGTH = 8;
const SAMPLE_SIZE = 4;

function finding(kind, subject, detail, hint) {
  return { kind, subject, detail, hint };
}

function sample(ids) {
  const shown = ids.slice(0, SAMPLE_SIZE).join(", ");
  return ids.length > SAMPLE_SIZE ? `${shown}, and ${ids.length - SAMPLE_SIZE} more` : shown;
}

function plural(count, noun) {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

export function catalogAnomalies(models) {
  const findings = [];
  const seen = new Set();
  const duplicates = [];

  for (const model of models) {
    if (seen.has(model.id)) duplicates.push(model.id);
    seen.add(model.id);

    // `toModel` substitutes a default context window when the catalog has no
    // `max_tokens`, so the number is a guess rather than a measurement.
    if (model.contextReported === null) {
      findings.push(finding("context-fallback", model.id, `no max_tokens in the catalog, reporting ${model.context}`, "verify the real context window before trusting a context-based filter"));
    }

    if (model.cost.input === 0 && model.cost.output === 0) {
      findings.push(finding("zero-price", model.id, "input and output both price at zero", "check whether the catalog omits pricing for this entry"));
    }

    if (model.cacheMultiplier !== null && model.cacheMultiplier > 1) {
      findings.push(finding("cache-costlier-than-input", model.id, `cache read multiplier ${model.cacheMultiplier} exceeds 1`, "cache reads cost more than fresh input, which is unexpected for a cache"));
    }

    if (model.discount !== null && (model.discount < 0 || model.discount > 1)) {
      findings.push(finding("discount-out-of-range", model.id, `discount ${model.discount} is not a fraction between 0 and 1`, "the price arithmetic assumes the fraction-off reading verified against DeepInfra's model pages"));
    }

    if (model.discountEndsAt) {
      findings.push(finding("discount-expiring", model.id, `discount ends at ${model.discountEndsAt}`, "prices registered now will be too low once the discount lapses"));
    }
  }

  // `reasoning` and `non-reasoning` together is not a contradiction: it marks a
  // hybrid model that reasons only when asked.
  const hybrids = models.filter((m) => m.tags.includes("reasoning") && m.tags.includes("non-reasoning"));
  if (hybrids.length > 0) {
    findings.push(finding("hybrid-reasoning", plural(hybrids.length, "model"), "tagged reasoning and non-reasoning together, so they reason on demand", `registered as reasoning models with the full effort scale: ${sample(hybrids.map((m) => m.id))}`));
  }

  if (duplicates.length > 0) {
    findings.push(finding("duplicate-id", plural(duplicates.length, "model"), "listed more than once in the catalog", `collapses to one entry per id: ${sample(duplicates)}`));
  }

  return findings;
}

// The extension adds missing tags to a few models whose catalog entry is wrong.
// A catalog that now carries those tags makes the override redundant, and a
// model that vanished makes it dead; either way the entry should go, so the
// override cannot quietly grow into a model catalog of its own. This runs over
// the unfiltered rows, because a filter that hides the model would otherwise
// read as the model being gone.
export function overrideAnomalies(models) {
  const byId = new Map(models.map((model) => [model.id, model]));
  const findings = [];
  const redundant = [];
  const stale = [];

  for (const { model, tags } of tagOverrides()) {
    const entry = byId.get(model);
    if (!entry) stale.push(model);
    else if (tags.every((tag) => entry.tags.includes(tag))) redundant.push(model);
  }

  if (redundant.length > 0) {
    findings.push(finding("tag-override-redundant", plural(redundant.length, "override"), "adds tags the catalog already carries", `delete the override: ${sample(redundant)}`));
  }
  if (stale.length > 0) {
    findings.push(finding("tag-override-stale", plural(stale.length, "override"), "names a model the catalog no longer lists", `delete the override: ${sample(stale)}`));
  }

  return findings;
}

// Why did an unscored model miss? Usually the source simply lacks it, but
// sometimes the names differ by one meaningful word and the normalization is at
// fault. Reporting the near miss is what lets a later run tighten the rules
// instead of silently ranking a shorter list.
export function joinAnomalies(models, scores) {
  const findings = [];
  const sourceKeys = new Map();
  const effortKeys = new Set();
  for (const score of scores) {
    const key = normalizeName(score.name);
    if (!sourceKeys.has(key)) sourceKeys.set(key, score.name);
    const base = effortlessName(key);
    if (base) effortKeys.add(base);
  }

  const families = new Map();
  for (const model of models) {
    const key = normalizeName(model.id);
    const bucket = families.get(key) ?? [];
    bucket.push(model.id);
    families.set(key, bucket);
  }

  for (const ids of families.values()) {
    if (ids.length > 1) {
      findings.push(finding("shared-score", plural(ids.length, "model"), "collapse onto one benchmark name, so they share a score", `verify the variants really score alike: ${ids.join(", ")}`));
    }
  }

  const missesBySuffix = new Map();
  for (const model of models) {
    const key = normalizeName(model.id);
    // An effort variant counts as joined: matchScores falls back to the base
    // model, so reporting it here would contradict the ranking it produced.
    if (sourceKeys.has(key) || effortKeys.has(key)) continue;
    const near = [...sourceKeys.entries()]
      .filter(([candidate]) => candidate.length >= SHARED_PREFIX_MIN_LENGTH &&
        (candidate.startsWith(key) || key.startsWith(candidate)))
      .sort((a, b) => a[0].length - b[0].length)[0];
    if (!near) continue;
    const [candidateKey, candidateName] = near;
    // Which side carries the extra word decides the fix: a suffix only the
    // source has calls for stripping it from source names, and a suffix only
    // the catalog has calls for stripping it from catalog names.
    const sourceCarriesIt = candidateKey.startsWith(key);
    const suffix = sourceCarriesIt ? candidateKey.slice(key.length) : key.slice(candidateKey.length);
    const group = `${suffix}:${sourceCarriesIt ? "source" : "catalog"}`;
    const bucket = missesBySuffix.get(group) ?? { suffix, sourceCarriesIt, ids: [], example: candidateName };
    bucket.ids.push(model.id);
    missesBySuffix.set(group, bucket);
  }

  for (const bucket of [...missesBySuffix.values()].sort((a, b) => b.ids.length - a.ids.length)) {
    const side = bucket.sourceCarriesIt ? "the source name" : "the catalog name";
    findings.push(finding(
      "near-miss",
      `suffix "${bucket.suffix}" on ${side}`,
      `${plural(bucket.ids.length, "unscored model")} almost joined, e.g. "${bucket.example}"`,
      `stripping "${bucket.suffix}" from ${side} would join them: ${sample(bucket.ids)}`,
    ));
  }

  return findings;
}

export function summarize(findings) {
  const counts = new Map();
  for (const { kind } of findings) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
