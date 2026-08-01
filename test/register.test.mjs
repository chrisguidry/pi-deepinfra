import assert from "node:assert/strict";
import test from "node:test";

import registerDeepInfra from "../index.ts";

function registeredProvider(t, envValue) {
  const original = process.env.DEEPINFRA_API_KEY;
  if (envValue === undefined) {
    delete process.env.DEEPINFRA_API_KEY;
  } else {
    process.env.DEEPINFRA_API_KEY = envValue;
  }
  t.after(() => {
    if (original === undefined) {
      delete process.env.DEEPINFRA_API_KEY;
    } else {
      process.env.DEEPINFRA_API_KEY = original;
    }
  });

  let registered;
  registerDeepInfra({
    registerProvider: (id, config) => {
      registered = { id, config };
    },
  });
  return registered;
}

test("registers the deepinfra provider", (t) => {
  const { id, config } = registeredProvider(t, undefined);
  assert.equal(id, "deepinfra");
  assert.equal(config.baseUrl, "https://api.deepinfra.com/v1/openai");
  assert.equal(config.api, "openai-completions");
});

test("registers the env var reference when DEEPINFRA_API_KEY is set", (t) => {
  const { config } = registeredProvider(t, "dik-test");
  assert.equal(config.apiKey, "$DEEPINFRA_API_KEY");
});

test("registers no apiKey when DEEPINFRA_API_KEY is not set", (t) => {
  const { config } = registeredProvider(t, undefined);
  assert.equal("apiKey" in config, false);
});
