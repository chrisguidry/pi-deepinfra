import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CATALOG_CACHE_FILE, readCache } from "../catalog-cache.js";
import { refreshModels } from "../index.ts";
import { stubFetch } from "./stub-fetch.mjs";

// Keep the cache out of the real one, and out of every other test file.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "pi-deepinfra-refresh-cache-"));

function refreshContext({ allowNetwork, stored, signal } = {}) {
  const published = [];
  return {
    allowNetwork,
    stored,
    signal: signal ?? new AbortController().signal,
    publish: async (publication) => {
      published.push(publication);
      return true;
    },
    published,
  };
}

function catalogResponse(models) {
  return {
    ok: true,
    json: async () => models,
  };
}

const SERVING_MODEL = {
  model_name: "example/model",
  type: "text-generation",
  tags: ["openai", "tools"],
  max_tokens: 131_072,
};

test("fetches the catalog and publishes it for persistence when network is allowed", async (t) => {
  stubFetch(t, async () => catalogResponse([SERVING_MODEL]));
  const context = refreshContext({ allowNetwork: true });

  const models = await refreshModels(context);

  assert.equal(models.length, 1);
  assert.equal(models[0].id, "example/model");
  assert.equal(context.published.length, 1);
  assert.equal(context.published[0].persist.models.length, 1);
});

test("persists the thinking level map with a reasoning model", async (t) => {
  stubFetch(t, async () =>
    catalogResponse([{ ...SERVING_MODEL, tags: ["openai", "tools", "reasoning", "can-disable-reasoning"] }]),
  );
  const context = refreshContext({ allowNetwork: true });

  const models = await refreshModels(context);

  assert.deepEqual(models[0].thinkingLevelMap, {
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
    off: "none",
  });
  assert.equal(context.published[0].persist.models[0].thinkingLevelMap.max, "max");
});

test("falls back to the stored catalog when the network fails", async (t) => {
  stubFetch(t, async () => {
    throw new Error("connection refused");
  });
  const context = refreshContext({
    allowNetwork: true,
    stored: { models: [{ id: "stored/model" }], checkedAt: 1 },
  });

  const models = await refreshModels(context);

  assert.equal(models.length, 1);
  assert.equal(models[0].id, "stored/model");
});

test("falls back to the stored catalog on a non-200 catalog response", async (t) => {
  stubFetch(t, async () => ({ ok: false, status: 503 }));
  const context = refreshContext({
    allowNetwork: true,
    stored: { models: [{ id: "stored/model" }], checkedAt: 1 },
  });

  const models = await refreshModels(context);

  assert.equal(models[0].id, "stored/model");
});

test("reads only the stored catalog when network is not allowed", async (t) => {
  stubFetch(t, async () => {
    throw new Error("fetch must not be called");
  });
  const context = refreshContext({
    allowNetwork: false,
    stored: { models: [{ id: "stored/model" }], checkedAt: 1 },
  });

  const models = await refreshModels(context);

  assert.equal(models[0].id, "stored/model");
});

test("returns no models when nothing is stored and network is not allowed", async () => {
  const models = await refreshModels(refreshContext({ allowNetwork: false }));

  assert.deepEqual(models, []);
});

test("propagates an abort instead of falling back", async (t) => {
  const controller = new AbortController();
  stubFetch(t, async () => {
    controller.abort();
    throw new Error("aborted");
  });
  const context = refreshContext({
    allowNetwork: true,
    stored: { models: [{ id: "stored/model" }], checkedAt: 1 },
    signal: controller.signal,
  });

  await assert.rejects(refreshModels(context), /aborted/);
});

// pi keeps only the converted model list, and that conversion drops the tags and
// pricing fields the skill filters and ranks on. Caching the raw download is
// what lets a skill run avoid fetching the same bytes again.
test("caches the raw catalog for the skill to reuse", async (t) => {
  stubFetch(t, async () =>
    catalogResponse([
      {
        ...SERVING_MODEL,
        tags: ["openai", "tools", "reasoning"],
        pricing: { cents_per_input_token: 9e-6, discount: 0.5 },
        is_partner: false,
      },
    ]),
  );

  await refreshModels(refreshContext({ allowNetwork: true }));

  const entry = await readCache(CATALOG_CACHE_FILE);
  assert.deepEqual(entry.data[0].tags, ["openai", "tools", "reasoning"]);
  assert.equal(entry.data[0].pricing.discount, 0.5);
  assert.equal(entry.data[0].is_partner, false);
});
