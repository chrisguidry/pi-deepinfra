import assert from "node:assert/strict";
import test from "node:test";

import { refreshModels } from "../index.ts";

function memoryStore(initial = undefined) {
  let stored = initial;
  return {
    read: async () => stored,
    write: async (value) => {
      stored = value;
    },
    current: () => stored,
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

function stubFetch(t, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => {
    globalThis.fetch = original;
  });
}

test("fetches the catalog and persists it when network is allowed", async (t) => {
  stubFetch(t, async () => catalogResponse([SERVING_MODEL]));
  const store = memoryStore();

  const models = await refreshModels({ allowNetwork: true, store });

  assert.equal(models.length, 1);
  assert.equal(models[0].id, "example/model");
  assert.equal(store.current().models.length, 1);
});

test("falls back to the store when the network fails", async (t) => {
  stubFetch(t, async () => {
    throw new Error("connection refused");
  });
  const store = memoryStore({ models: [{ id: "stored/model" }], checkedAt: 1 });

  const models = await refreshModels({ allowNetwork: true, store });

  assert.equal(models.length, 1);
  assert.equal(models[0].id, "stored/model");
});

test("falls back to the store on a non-200 catalog response", async (t) => {
  stubFetch(t, async () => ({ ok: false, status: 503 }));
  const store = memoryStore({ models: [{ id: "stored/model" }], checkedAt: 1 });

  const models = await refreshModels({ allowNetwork: true, store });

  assert.equal(models[0].id, "stored/model");
});

test("reads only the store when network is not allowed", async (t) => {
  stubFetch(t, async () => {
    throw new Error("fetch must not be called");
  });
  const store = memoryStore({ models: [{ id: "stored/model" }], checkedAt: 1 });

  const models = await refreshModels({ allowNetwork: false, store });

  assert.equal(models[0].id, "stored/model");
});

test("returns no models when the store is empty and network is not allowed", async () => {
  const models = await refreshModels({ allowNetwork: false, store: memoryStore() });

  assert.deepEqual(models, []);
});

test("propagates an abort instead of falling back", async (t) => {
  const controller = new AbortController();
  stubFetch(t, async () => {
    controller.abort();
    throw new Error("aborted");
  });
  const store = memoryStore({ models: [{ id: "stored/model" }], checkedAt: 1 });

  await assert.rejects(
    refreshModels({ allowNetwork: true, store, signal: controller.signal }),
    /aborted/,
  );
});
