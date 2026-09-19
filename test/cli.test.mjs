import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CATALOG_CACHE_FILE, writeCache } from "../catalog-cache.js";

const SCRIPT = fileURLToPath(new URL("../skills/deepinfra-models/scripts/models.mjs", import.meta.url));

// Two models that differ only in context window and price, so a filter either
// applies or it does not. Both pass the serving filter.
const CATALOG = [
  {
    model_name: "lab/big-model",
    type: "text-generation",
    tags: ["openai", "tools", "reasoning"],
    max_tokens: 1_000_000,
    is_partner: false,
    pricing: { cents_per_input_token: 9e-6, cents_per_output_token: 1.8e-5 },
  },
  {
    model_name: "lab/small-model",
    type: "text-generation",
    tags: ["openai", "tools"],
    max_tokens: 8_192,
    is_partner: false,
    pricing: { cents_per_input_token: 1e-6, cents_per_output_token: 2e-6 },
  },
];

const directory = mkdtempSync(join(tmpdir(), "deepinfra-cli-"));
const catalogPath = join(directory, "catalog.json");
const scoresPath = join(directory, "scores.json");
// A cache directory of our own, so a run never reads the real one.
const cacheHome = mkdtempSync(join(tmpdir(), "deepinfra-cli-cache-"));
writeFileSync(catalogPath, JSON.stringify(CATALOG));
writeFileSync(scoresPath, JSON.stringify({ "big-model": 50, "small-model": 40 }));

// Every run reads both fixtures, so the tests exercise the real argument
// parsing and filtering without touching the network.
function run(args) {
  const output = execFileSync(
    process.execPath,
    [SCRIPT, ...args, "--catalog", catalogPath, "--scores", scoresPath, "--json"],
    { encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: cacheHome } },
  );
  return JSON.parse(output);
}

function runAgainstCache(args, cacheHome) {
  const output = execFileSync(process.execPath, [SCRIPT, ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, XDG_CACHE_HOME: cacheHome },
  });
  return JSON.parse(output);
}

test("list applies the context filter", () => {
  const { models } = run(["list", "--min-context", "100000"]);

  assert.deepEqual(models.map((model) => model.id), ["lab/big-model"]);
});

test("list applies the price filter", () => {
  const { models } = run(["list", "--max-price", "0.05"]);

  assert.deepEqual(models.map((model) => model.id), ["lab/small-model"]);
});

test("list applies the capability filter", () => {
  const { models } = run(["list", "--reasoning"]);

  assert.deepEqual(models.map((model) => model.id), ["lab/big-model"]);
});

// The score command reads filters from the same place as list. It did not once,
// which meant a run could claim a context filter it never applied.
test("score applies the same filters as list", () => {
  const { coverage, ranked } = run(["score", "--min-context", "100000"]);

  assert.equal(coverage.scoped, 1);
  assert.deepEqual(ranked.map((pair) => pair.model.id), ["lab/big-model"]);
});

test("score ranks by score per blended dollar", () => {
  const { ranked } = run(["score"]);

  assert.deepEqual(ranked.map((pair) => pair.model.id), ["lab/small-model", "lab/big-model"]);
});

test("score reports a model the source never scored", () => {
  const { coverage, diagnostics } = run(["score", "--limit", "1"]);

  assert.equal(coverage.scoped, 2);
  assert.equal(coverage.scored, 2);
  assert.ok(diagnostics.some((finding) => finding.kind === "shared-score") === false);
});

test("show describes one model without a score source", () => {
  const output = execFileSync(
    process.execPath,
    [SCRIPT, "show", "lab/big-model", "--catalog", catalogPath],
    { encoding: "utf8" },
  );

  assert.match(output, /deepinfra\/lab\/big-model/);
  assert.match(output, /minimal, low, medium, high, xhigh, max/);
});

test("an unknown sort fails with the alternatives", () => {
  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT, "list", "--sort", "score", "--catalog", catalogPath], { encoding: "utf8", stdio: "pipe" }),
    /unknown sort: score/,
  );
});

// The provider writes this file on every refresh. The skill must find it at the
// same path and in the same shape, or it downloads the catalog all over again.
test("list uses the catalog the provider cached", async () => {
  const cacheHome = mkdtempSync(join(tmpdir(), "deepinfra-cli-shared-"));
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheHome;
  try {
    await writeCache(CATALOG_CACHE_FILE, { data: [{ ...CATALOG[0], model_name: "lab/from-the-cache" }] });
  } finally {
    process.env.XDG_CACHE_HOME = previous;
  }

  const { models } = runAgainstCache(["list"], cacheHome);

  assert.deepEqual(models.map((model) => model.id), ["lab/from-the-cache"]);
});
