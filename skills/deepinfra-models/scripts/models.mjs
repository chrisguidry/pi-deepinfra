#!/usr/bin/env node
// Command line for choosing a DeepInfra model: what is serving, what it costs,
// and — when a benchmark source is available — which one buys the most
// capability per dollar.
//
// Run it with the --help flag for the full option list.
import { describeAge } from "../../../catalog-cache.js";
import { blendedPrice, loadCatalog, toRows } from "./catalog.mjs";
import { catalogAnomalies, joinAnomalies, overrideAnomalies, summarize } from "./diagnostics.mjs";
import { matchScores, rankByValue } from "./match.mjs";
import { SOURCES, parseCsv, scoresFromJson } from "./sources.mjs";

const USAGE = `Usage: models.mjs [list|show|score] [options]

Commands
  list                     serving models with prices and capabilities (default)
  show <model-id>          everything known about one model
  score                    rank models by benchmark score per dollar

Filters
  --vision                 image input
  --audio                  audio input
  --video                  video input
  --reasoning              reasoning models
  --non-reasoning          non-reasoning models
  --zdr                    DeepInfra-hosted only (zero retention)
  --tag <tag>              require a raw DeepInfra tag
  --min-context <tokens>
  --max-price <usd>        upper bound on the blended $/M price

Output
  --sort <name|price|context>   list order (default: name)
  --limit <n>
  --json
  --diagnose                    every data finding, not just the summary
  --catalog <file>              read a saved catalog instead of fetching it
  --refresh                     ignore the cached copies and fetch again

Score sources
  --source <arena|epoch>        default: arena
  --scores <file|->             any leaderboard as JSON or CSV; - reads stdin
  --config <name>               Arena leaderboard config (default: text_style_control)
                                also: webdev (Code Arena), agent, vision_style_control,
                                document, search
  --category <name>             category inside that config (default: overall)
  --benchmark <pattern>         Epoch: average only matching benchmarks; * is a wildcard
  --min-votes <n>               drop thinly-voted Arena entries

Scoring notes
  The value column is score per blended $/M, blended 3:1 input:output. Only
  compare values within one source: an Arena rating and an Epoch mean share no
  scale. Both sources are keyless and both cover part of the catalog, so
  unscored models are listed rather than dropped silently. For a coding signal
  use --config webdev, or --source epoch --benchmark '*SWE*' to narrow the mean.`;

function parseArgs(argv) {
  const options = { command: "list", flags: new Set(), values: {} };
  const takesValue = new Set([
    "tag", "min-context", "max-price", "sort", "limit", "source", "scores", "category", "min-votes",
    "config", "benchmark", "catalog",
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (takesValue.has(name)) options.values[name] = argv[++i];
      else options.flags.add(name);
    } else if (options.command === "list") options.command = arg;
    else options.values.model = arg;
  }
  return options;
}

const FLAG_LEGEND = "flags: r reasoning, d can disable reasoning, v vision, a audio, i video, Z zero retention";

// Where the numbers came from, so a cached price is never read as a fresh one.
function describeOrigin(origin) {
  if (!origin) return "unknown";
  if (origin.kind === "cache") return `cached, ${describeAge(origin.entry)}`;
  if (origin.kind === "revalidated") return "cached, revalidated as unchanged";
  if (origin.kind === "network") return "fetched now";
  if (origin.kind === "file") return `from ${origin.path}`;
  return origin.kind;
}

function capabilityString(model) {
  const letters = [];
  if (model.reasoning) letters.push("r");
  if (model.canDisableReasoning) letters.push("d");
  if (model.vision) letters.push("v");
  if (model.audio) letters.push("a");
  if (model.video) letters.push("i");
  if (model.zdr) letters.push("Z");
  return letters.join("");
}

// The source name a score actually came from, marked when it is not the model
// as configured: `~` for a name several catalog models share, `^` for an effort
// variant standing in for its base.
function matchedNameWithMarkers(pair) {
  return `${pair.matchedName}${pair.shared ? "~" : ""}${pair.viaEffort ? "^" : ""}`;
}

function money(value) {
  if (value === 0) return "0";
  return value < 0.01 ? value.toFixed(5) : value.toFixed(3);
}

// Scores arrive on wildly different scales: an Arena rating is in the
// thousands, an Epoch mean is out of 100, and the agent leaderboard's IPS score
// is a fraction. Fixed decimals would print the last of those as 0.0.
function score(value) {
  if (!Number.isFinite(value)) return "n/a";
  return Math.abs(value) >= 1 ? value.toFixed(1) : value.toFixed(4);
}

function tokens(value) {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : `${Math.round(value / 1024)}k`;
}

function printFindings(findings, { full } = {}) {
  if (findings.length === 0) return;
  const counts = summarize(findings).map(([kind, count]) => `${kind} ${count}`).join(", ");
  console.log(`data notes (${findings.length}): ${counts}`);
  const shown = full ? findings : findings.slice(0, 8);
  for (const item of shown) {
    console.log(`  ${item.kind}: ${item.subject} — ${item.detail}`);
    if (full) console.log(`      fix: ${item.hint}`);
  }
  if (!full && findings.length > shown.length) {
    console.log(`  ... and ${findings.length - shown.length} more (--diagnose lists all)`);
  }
}

function table(columns, rows) {
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...rows.map((row) => String(row[index]).length)),
  );
  const line = (cells) =>
    cells
      .map((cell, index) => (columns[index].right ? String(cell).padStart(widths[index]) : String(cell).padEnd(widths[index])))
      .join("  ")
      .trimEnd();
  return [line(columns.map((column) => column.header)), ...rows.map(line)].join("\n");
}

function matchesFilters(model, filters, flags) {
  if (flags.has("vision") && !model.vision) return false;
  if (flags.has("audio") && !model.audio) return false;
  if (flags.has("video") && !model.video) return false;
  if (flags.has("reasoning") && !model.reasoning) return false;
  if (flags.has("non-reasoning") && model.reasoning) return false;
  if (flags.has("zdr") && !model.zdr) return false;
  if (filters.tag && !model.tags.includes(filters.tag)) return false;
  if (filters["min-context"] && model.context < Number(filters["min-context"])) return false;
  if (filters["max-price"] && blendedPrice(model.cost) > Number(filters["max-price"])) return false;
  return true;
}

function sortModels(models, sort) {
  if (sort === "price") return [...models].sort((a, b) => blendedPrice(a.cost) - blendedPrice(b.cost));
  if (sort === "context") return [...models].sort((a, b) => b.context - a.context);
  if (sort && sort !== "name") {
    throw new Error(`unknown sort: ${sort}; list orders by name, price, or context, and the score command ranks by benchmark value`);
  }
  return models;
}

function listRows(models) {
  return models.map((model) => [
    model.id,
    money(model.cost.input),
    money(model.cost.output),
    money(model.cost.cacheRead),
    money(blendedPrice(model.cost)),
    tokens(model.context),
    capabilityString(model),
  ]);
}

async function loadScores(options) {
  if (options.values.scores) {
    const source = options.values.scores;
    let text;
    if (source === "-") {
      text = await new Promise((resolve) => {
        let buffer = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => (buffer += chunk));
        process.stdin.on("end", () => resolve(buffer));
      });
    } else {
      const { readFile } = await import("node:fs/promises");
      text = await readFile(source, "utf8");
    }
    const trimmed = text.trim();
    const scores = trimmed.startsWith("{") || trimmed.startsWith("[")
      ? scoresFromJson(trimmed)
      : parseCsv(trimmed).map((row) => ({
          name: row.name ?? row.model,
          score: Number(row.score),
        }));
    return { source: "scores", label: source, url: source, publishedAt: "provided", origin: { kind: "file", path: source }, scores };
  }
  const name = options.values.source ?? "arena";
  const loader = SOURCES[name];
  if (!loader) throw new Error(`unknown source: ${name} (expected ${Object.keys(SOURCES).join(", ")})`);
  return loader({
    config: options.values.config,
    category: options.values.category,
    benchmark: options.values.benchmark,
    refresh: options.flags.has("refresh"),
  });
}

async function scoreCommand(options) {
  const refresh = options.flags.has("refresh");
  const [{ catalog, origin: catalogOrigin }, source] = await Promise.all([
    loadCatalog({ path: options.values.catalog, refresh }),
    loadScores(options),
  ]);
  const models = toRows(catalog);
  let scores = source.scores;
  const minVotes = Number(options.values["min-votes"] ?? 0);
  if (minVotes > 0) scores = scores.filter((score) => (score.votes ?? 0) >= minVotes);

  const scoped = models.filter((model) => matchesFilters(model, options.values, options.flags));
  const { pairs, unscored, shared } = matchScores(scoped, scores);
  // A centred source has no meaningful ratio, so it orders by score alone.
  const ranked = source.centered
    ? pairs
        .map((pair) => ({ ...pair, blended: blendedPrice(pair.model.cost), value: null }))
        .sort((a, b) => b.score - a.score)
    : rankByValue(pairs);
  const limit = Number(options.values.limit ?? 20);
  const shown = ranked.slice(0, limit);
  const findings = [...catalogAnomalies(scoped), ...overrideAnomalies(models), ...joinAnomalies(scoped, scores)];

  if (options.json) {
    console.log(JSON.stringify({
      source: { name: source.source, label: source.label, url: source.url, publishedAt: source.publishedAt },
      coverage: { scoped: scoped.length, scored: pairs.length, unscored: unscored.length, shared: shared.length, effortDerived: pairs.filter((pair) => pair.viaEffort).length },
      ranked: shown,
      diagnostics: findings,
    }, null, 2));
    return;
  }

  console.log(table(
    [
      { header: "rank", right: true },
      { header: "model" },
      { header: "in $/M", right: true },
      { header: "out $/M", right: true },
      { header: "blend $/M", right: true },
      { header: "score", right: true },
      ...(source.centered ? [] : [{ header: "score/$", right: true }]),
      { header: "flags" },
      { header: "matched as" },
    ],
    shown.map((pair, index) => [
      index + 1,
      pair.model.id,
      money(pair.model.cost.input),
      money(pair.model.cost.output),
      money(pair.blended),
      score(pair.score),
      ...(source.centered ? [] : [pair.value.toFixed(0)]),
      capabilityString(pair.model),
      matchedNameWithMarkers(pair),
    ]),
  ));
  console.log("");
  console.log(`source: ${source.label} — ${source.url}`);
  console.log(`scored ${pairs.length} of ${scoped.length} models in scope` +
    (ranked.length > shown.length ? `; showing top ${shown.length}` : ""));
  if (source.benchmarks?.length) {
    console.log(`benchmarks averaged (${source.benchmarks.length}): ${source.benchmarks.join(", ")}`);
  }
  if (source.centered) {
    console.log("this leaderboard scores on a scale centred near zero, so a score per dollar says nothing; ordered by score alone");
  }
  if (source.truncated) {
    console.log("warning: the source paged out before it ran out of rows, so some entries were never read");
  }
  if (source.attribution) console.log(`attribution: ${source.attribution}`);
  console.log(`data: catalog ${describeOrigin(catalogOrigin)}, ${source.source} ${describeOrigin(source.origin)}`);
  if (unscored.length > 0) {
    const shownNames = unscored.slice(0, 12).map((m) => m.id);
    const rest = unscored.length - shownNames.length;
    console.log(`no score in this source (${unscored.length}): ${shownNames.join(", ")}` +
      (rest > 0 ? `, and ${rest} more (--json lists all)` : ""));
  }
  if (shared.length > 0) {
    console.log(`score shared across a model family (~) (${shared.length}): ` +
      shared.map((group) => `${group.name} = ${group.models.join("|")}`).join(", "));
  }
  const effortDerived = pairs.filter((pair) => pair.viaEffort);
  if (effortDerived.length > 0) {
    const listed = effortDerived.slice(0, 6).map((pair) => `${pair.model.id} <- ${pair.matchedName}`);
    console.log(`score taken from an effort variant (^) (${effortDerived.length}): ${listed.join(", ")}` +
      (effortDerived.length > listed.length ? `, and ${effortDerived.length - listed.length} more` : ""));
  }
  printFindings(findings, { full: options.flags.has("diagnose") });
  console.log(FLAG_LEGEND);
}

async function showCommand(options) {
  const id = options.values.model;
  if (!id) throw new Error("show needs a model id");
  const { catalog, origin } = await loadCatalog({
    path: options.values.catalog,
    refresh: options.flags.has("refresh"),
  });
  const models = toRows(catalog);
  const model = models.find((m) => m.id === id || m.id.endsWith(`/${id}`));
  if (!model) throw new Error(`not a serving DeepInfra model: ${id}`);
  if (options.json) {
    console.log(JSON.stringify(model, null, 2));
    return;
  }
  console.log(`${model.id}
  use as        ${model.spec}
  context       ${model.context.toLocaleString()} tokens
  max output    ${model.maxTokens.toLocaleString()} tokens
  input $/M     ${money(model.cost.input)}
  output $/M    ${money(model.cost.output)}
  blended $/M   ${money(blendedPrice(model.cost))}  (3:1 input:output)
  cache read $/M  ${money(model.cost.cacheRead)}
  cache write $/M ${money(model.cost.cacheWrite)}
  capabilities  ${capabilityString(model)}
  thinking      ${model.efforts.length > 0 ? model.efforts.join(", ") : "not a reasoning model"}
  tags          ${model.tags.join(", ")}`);
  console.log(`prices        catalog ${describeOrigin(origin)}`);
  if (model.description) console.log(`\n${model.description}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  if (options.command === "score") {
    await scoreCommand(options);
    return;
  }
  if (options.command === "show") {
    await showCommand(options);
    return;
  }
  if (options.command !== "list") throw new Error(`unknown command: ${options.command}`);

  const { catalog, origin } = await loadCatalog({
    path: options.values.catalog,
    refresh: options.flags.has("refresh"),
  });
  const models = toRows(catalog);
  const scoped = sortModels(
    models.filter((model) => matchesFilters(model, options.values, options.flags)),
    options.values.sort,
  );
  const shown = options.values.limit ? scoped.slice(0, Number(options.values.limit)) : scoped;
  const findings = [...catalogAnomalies(scoped), ...overrideAnomalies(models)];

  if (options.json) {
    console.log(JSON.stringify({ models: shown, diagnostics: findings }, null, 2));
    return;
  }

  console.log(table(
    [
      { header: "model" },
      { header: "in $/M", right: true },
      { header: "out $/M", right: true },
      { header: "cache $/M", right: true },
      { header: "blend $/M", right: true },
      { header: "context", right: true },
      { header: "flags" },
    ],
    listRows(shown),
  ));
  console.log("");
  console.log(`${shown.length} of ${models.length} serving models; ` +
    `${models.length - scoped.length} filtered out` + (scoped.length > shown.length ? `, ${scoped.length - shown.length} past the limit` : ""));
  console.log("Prices are DeepInfra's current price, list price with any discount applied.");
  console.log(`data: catalog ${describeOrigin(origin)}`);
  printFindings(findings, { full: options.flags.has("diagnose") });
  console.log(FLAG_LEGEND);
}

main().catch((error) => {
  console.error(`models: ${error.message}`);
  process.exit(1);
});
