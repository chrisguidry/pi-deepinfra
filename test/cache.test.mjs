import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CATALOG_CACHE_FILE, cacheDirectory, describeAge, isFresh, readCache, writeCache } from "../catalog-cache.js";
import { loadCatalog } from "../skills/deepinfra-models/scripts/catalog.mjs";
import { stubFetch } from "./stub-fetch.mjs";

// Point the cache at a fresh directory so a test never reads or writes the real
// one. cacheDirectory() reads the variable per call, so setting it here is
// enough even though the imports above have already run.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "pi-deepinfra-cache-"));

const SERVING_MODEL = {
  model_name: "lab/model",
  type: "text-generation",
  tags: ["openai", "tools"],
  max_tokens: 131_072,
};

function writeEntry(name, entry) {
  writeFileSync(join(cacheDirectory(), name), JSON.stringify(entry));
}

function catalogResponse(models) {
  return { ok: true, json: async () => models };
}

test("round-trips an entry", async () => {
  await writeCache("round-trip.json", { data: { value: 7 }, etag: "abc" });

  const entry = await readCache("round-trip.json");

  assert.equal(entry.data.value, 7);
  assert.equal(entry.etag, "abc");
  assert.equal(typeof entry.fetchedAt, "number");
});

test("treats an unreadable entry as a miss", async () => {
  writeFileSync(join(cacheDirectory(), "broken.json"), "{not json");

  assert.equal(await readCache("broken.json"), null);
});

test("treats an entry with no timestamp as a miss", async () => {
  writeEntry("no-timestamp.json", { data: { value: 1 } });

  assert.equal(await readCache("no-timestamp.json"), null);
});

test("lets an entry go stale after its window", async () => {
  const entry = { fetchedAt: Date.now() - 60_000 };

  assert.equal(isFresh(entry, 120_000), true);
  assert.equal(isFresh(entry, 30_000), false);
  assert.equal(isFresh(null, 120_000), false);
});

test("describes the age in words", () => {
  const now = Date.now();

  assert.equal(describeAge({ fetchedAt: now }, now), "just now");
  assert.equal(describeAge({ fetchedAt: now - 20 * 60_000 }, now), "20 min ago");
  assert.equal(describeAge({ fetchedAt: now - 3 * 60 * 60_000 }, now), "3 h ago");
  assert.equal(describeAge({ fetchedAt: now - 50 * 60 * 60_000 }, now), "2 d ago");
});

// The provider writes this file on every refresh, so a skill run that follows
// one must not ask DeepInfra for the same catalog again.
test("reads the provider's cached catalog without fetching", async (t) => {
  await writeCache(CATALOG_CACHE_FILE, { data: [SERVING_MODEL] });
  stubFetch(t, async () => {
    throw new Error("fetch must not be called");
  });

  const { catalog, origin } = await loadCatalog();

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].model_name, "lab/model");
  assert.equal(origin.kind, "cache");
});

test("fetches and rewrites the cache when the copy is stale", async (t) => {
  writeEntry(CATALOG_CACHE_FILE, {
    fetchedAt: Date.now() - 12 * 60 * 60 * 1000,
    data: [{ ...SERVING_MODEL, model_name: "lab/stale" }],
  });
  stubFetch(t, async () => catalogResponse([SERVING_MODEL]));

  const { catalog, origin } = await loadCatalog();

  assert.equal(origin.kind, "network");
  assert.equal(catalog[0].model_name, "lab/model");
  const rewritten = await readCache(CATALOG_CACHE_FILE);
  assert.equal(rewritten.data[0].model_name, "lab/model");
});

test("refresh fetches even when the copy is fresh", async (t) => {
  await writeCache(CATALOG_CACHE_FILE, { data: [{ ...SERVING_MODEL, model_name: "lab/cached" }] });
  let calls = 0;
  stubFetch(t, async () => {
    calls += 1;
    return catalogResponse([SERVING_MODEL]);
  });

  const { catalog, origin } = await loadCatalog({ refresh: true });

  assert.equal(calls, 1);
  assert.equal(origin.kind, "network");
  assert.equal(catalog[0].model_name, "lab/model");
});
