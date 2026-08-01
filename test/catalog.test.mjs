import assert from "node:assert/strict";
import test from "node:test";

import { isServingTextModel, toModel } from "../index.ts";

// A catalog entry that passes every filter; tests override one field at a time.
function catalogModel(overrides = {}) {
  return {
    model_name: "example/model",
    type: "text-generation",
    tags: ["openai", "tools"],
    max_tokens: 131_072,
    pricing: {
      cents_per_input_token: 9e-6,
      cents_per_output_token: 1.8e-5,
      rate_per_input_token_cached: 0.2,
      rate_per_input_token_cache_write: null,
    },
    ...overrides,
  };
}

test("keeps a serving text-generation model with tool calling", () => {
  assert.equal(isServingTextModel(catalogModel()), true);
});

test("drops a deprecated model", () => {
  assert.equal(isServingTextModel(catalogModel({ deprecated: 1717000000 })), false);
});

test("drops a replaced model", () => {
  assert.equal(isServingTextModel(catalogModel({ replaced_by: "example/newer" })), false);
});

test("drops a non-text model", () => {
  assert.equal(isServingTextModel(catalogModel({ type: "text-to-image" })), false);
});

test("drops a model without the openai tag", () => {
  assert.equal(isServingTextModel(catalogModel({ tags: ["tools"] })), false);
});

test("drops a model without tool calling", () => {
  assert.equal(isServingTextModel(catalogModel({ tags: ["openai"] })), false);
});

test("converts cents per token to dollars per million tokens", () => {
  const model = toModel(catalogModel());
  assert.equal(model.cost.input, 0.09);
  assert.equal(model.cost.output, 0.18);
});

test("cache rates are multipliers on the input price", () => {
  const model = toModel(catalogModel());
  assert.equal(model.cost.cacheRead, 0.2 * 0.09);
  assert.equal(model.cost.cacheWrite, 0);
});

test("prices a model with no pricing at zero", () => {
  const model = toModel(catalogModel({ pricing: undefined }));
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("uses max_tokens as the context window", () => {
  const model = toModel(catalogModel());
  assert.equal(model.contextWindow, 131_072);
});

test("falls back to the default context window when max_tokens is null", () => {
  const model = toModel(catalogModel({ max_tokens: null }));
  assert.equal(model.contextWindow, 128_000);
});

test("caps output tokens at the default", () => {
  const model = toModel(catalogModel());
  assert.equal(model.maxTokens, 16_384);
});

test("caps output tokens at the context window when it is smaller", () => {
  const model = toModel(catalogModel({ max_tokens: 8_192 }));
  assert.equal(model.maxTokens, 8_192);
});

test("marks reasoning from the catalog tag", () => {
  assert.equal(toModel(catalogModel()).reasoning, false);
  assert.equal(toModel(catalogModel({ tags: ["openai", "tools", "reasoning"] })).reasoning, true);
});

test("marks image input from the multimodal tag", () => {
  assert.deepEqual(toModel(catalogModel()).input, ["text"]);
  assert.deepEqual(toModel(catalogModel({ tags: ["openai", "tools", "multimodal"] })).input, [
    "text",
    "image",
  ]);
});

test("disables the developer role on every model", () => {
  assert.deepEqual(toModel(catalogModel()).compat, { supportsDeveloperRole: false });
});
