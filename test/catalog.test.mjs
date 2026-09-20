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

// DeepInfra's model pages show the list price and the discounted price side by
// side, with the discounted one as the price a request costs today. These are
// the figures from the GLM-5.3-Flash page: $0.15/$0.50 list at 50% off.
test("applies the discount to input and output prices", () => {
  const model = toModel(
    catalogModel({
      pricing: {
        cents_per_input_token: 1.5e-5,
        cents_per_output_token: 5e-5,
        rate_per_input_token_cached: 0.2,
        discount: 0.5,
      },
    }),
  );
  assert.equal(model.cost.input, 0.075);
  assert.equal(model.cost.output, 0.25);
});

test("multiplies the cache rate by the discounted input price", () => {
  const model = toModel(
    catalogModel({
      pricing: {
        cents_per_input_token: 1.5e-5,
        cents_per_output_token: 5e-5,
        rate_per_input_token_cached: 0.2,
        discount: 0.5,
      },
    }),
  );
  assert.equal(model.cost.cacheRead, 0.015);
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

// DeepInfra tags several reasoning models `non-reasoning` and records the
// capability only as `can-disable-reasoning`. A model that accepts
// `reasoning_effort: "none"` must reason, so the tag alone is proof enough.
test("marks a model that can disable reasoning as reasoning", () => {
  const model = toModel(
    catalogModel({ tags: ["openai", "tools", "non-reasoning", "can-disable-reasoning"] }),
  );
  assert.equal(model.reasoning, true);
});

test("gives a model that only can disable reasoning the full scale with off", () => {
  const model = toModel(catalogModel({ tags: ["openai", "tools", "can-disable-reasoning"] }));
  assert.deepEqual(model.thinkingLevelMap, {
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
    off: "none",
  });
});

test("leaves a model tagged only non-reasoning without thinking levels", () => {
  const model = toModel(catalogModel({ tags: ["openai", "tools", "non-reasoning"] }));
  assert.equal(model.reasoning, false);
  assert.equal(model.thinkingLevelMap, undefined);
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

test("omits the thinking level map on non-reasoning models", () => {
  assert.equal(toModel(catalogModel()).thinkingLevelMap, undefined);
});

test("maps every effort level, off to none when the model can disable reasoning", () => {
  const model = toModel(
    catalogModel({ tags: ["openai", "tools", "reasoning", "can-disable-reasoning"] }),
  );
  assert.deepEqual(model.thinkingLevelMap, {
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
    off: "none",
  });
});

test("keeps every effort level but hides off when the model cannot disable reasoning", () => {
  const model = toModel(catalogModel({ tags: ["openai", "tools", "reasoning"] }));
  assert.deepEqual(model.thinkingLevelMap, {
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
    off: null,
  });
});

// Kimi-K3's catalog entry omits every reasoning tag even though the endpoint
// serves reasoning_effort, so the extension patches the entry with the same tag
// pair the catalog gives Kimi-K2.6.
test("patches a catalog entry known to omit its reasoning tags", () => {
  const model = toModel(catalogModel({ model_name: "moonshotai/Kimi-K3" }));
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.thinkingLevelMap, {
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
    off: "none",
  });
});

test("leaves a model without a patch alone", () => {
  const model = toModel(catalogModel({ model_name: "moonshotai/Kimi-K3-Turbo" }));
  assert.equal(model.reasoning, false);
  assert.equal(model.thinkingLevelMap, undefined);
});
