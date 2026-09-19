import assert from "node:assert/strict";
import test from "node:test";

import { blendedPrice, toRow } from "../skills/deepinfra-models/scripts/catalog.mjs";
import { matchScores, normalizeName, rankByValue } from "../skills/deepinfra-models/scripts/match.mjs";
import { parseCsv, scoresFromJson } from "../skills/deepinfra-models/scripts/sources.mjs";

// A catalog entry that survives the serving filter; tests override one field at
// a time.
function catalogModel(overrides = {}) {
  return {
    model_name: "example/model",
    type: "text-generation",
    tags: ["openai", "tools"],
    max_tokens: 131_072,
    pricing: { cents_per_input_token: 9e-6, cents_per_output_token: 1.8e-5 },
    is_partner: false,
    description: "",
    ...overrides,
  };
}

const NAME_CASES = [
  { name: "deepseek-ai/DeepSeek-V4-Flash", expected: "deepseekv4flash" },
  { name: "deepseek-ai/DeepSeek-V4-Flash-0731", expected: "deepseekv4flash" },
  { name: "DeepSeek V4 Flash 0731", expected: "deepseekv4flash" },
  { name: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo", expected: "metallama318b" },
  { name: "Mistral-Nemo-Instruct-2407", expected: "mistralnemo" },
  { name: "claude-opus-4-7-high", expected: "claudeopus47high" },
];

test("normalizes names across sources to one key", async (t) => {
  for (const { name, expected } of NAME_CASES) {
    await t.test(name, () => {
      assert.equal(normalizeName(name), expected);
    });
  }
});

test("keeps words that distinguish one model from another", () => {
  assert.notEqual(normalizeName("qwen3-max-preview"), normalizeName("qwen3-max-thinking"));
  assert.notEqual(normalizeName("GLM-5.3"), normalizeName("GLM-5.3-Flash"));
  assert.notEqual(normalizeName("gpt-oss-120b"), normalizeName("gpt-oss-20b"));
});

test("blends input and output price 3:1", () => {
  assert.equal(blendedPrice({ input: 1, output: 5 }), 2);
});

test("reads zero-retention from the partner flag", () => {
  assert.equal(toRow(catalogModel()).zdr, true);
  assert.equal(toRow(catalogModel({ is_partner: true })).zdr, false);
});

test("reads capabilities from the catalog tags", () => {
  const row = toRow(catalogModel({ tags: ["openai", "tools", "multimodal", "input-video"] }));
  assert.equal(row.vision, true);
  assert.equal(row.video, true);
  assert.equal(row.audio, false);
});

test("lists the thinking levels a model actually offers", () => {
  const reasoning = toRow(catalogModel({ tags: ["openai", "tools", "reasoning"] }));
  assert.deepEqual(reasoning.efforts, ["minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(toRow(catalogModel()).efforts, []);
});

test("adds off to the levels when the model can disable reasoning", () => {
  const row = toRow(catalogModel({ tags: ["openai", "tools", "reasoning", "can-disable-reasoning"] }));
  assert.equal(row.efforts.at(-1), "off");
});

test("builds the spec a subagent takes", () => {
  assert.equal(toRow(catalogModel()).spec, "deepinfra/example/model");
});

test("matches a model to its score under a different spelling", () => {
  const models = [toRow(catalogModel({ model_name: "deepseek-ai/DeepSeek-V4-Flash" }))];
  const { pairs, unscored, shared } = matchScores(models, [{ name: "deepseek-v4-flash", score: 74.2 }]);

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].score, 74.2);
  assert.equal(pairs[0].shared, false);
  assert.deepEqual(unscored, []);
  assert.deepEqual(shared, []);
});

// The join is rules only, with no alias table, so a model that did not exist
// when this was written still matches. The names below appear nowhere in the
// script, which is the point.
test("matches a model name it has never seen", () => {
  const models = [toRow(catalogModel({ model_name: "future-lab/Future-Model-9-Vision-Exp" }))];
  const { pairs } = matchScores(models, [{ name: "Future-Model-9-Vision-Exp-1123", score: 1 }]);

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].matchedName, "Future-Model-9-Vision-Exp-1123");
});

test("reports a model no source scored instead of dropping it", () => {
  const models = [toRow(catalogModel({ model_name: "example/unscored" }))];
  const { pairs, unscored } = matchScores(models, [{ name: "something-else", score: 1 }]);

  assert.deepEqual(pairs, []);
  assert.equal(unscored[0].id, "example/unscored");
});

test("shares one score across a dated snapshot and its base model", () => {
  const models = [
    toRow(catalogModel({ model_name: "deepseek-ai/DeepSeek-V4-Flash" })),
    toRow(catalogModel({ model_name: "deepseek-ai/DeepSeek-V4-Flash-0731" })),
  ];
  const { pairs, shared } = matchScores(models, [{ name: "deepseek-v4-flash", score: 74.2 }]);

  assert.equal(pairs.length, 2);
  assert.equal(pairs.every((pair) => pair.shared), true);
  assert.deepEqual(shared[0].models, ["deepseek-ai/DeepSeek-V4-Flash", "deepseek-ai/DeepSeek-V4-Flash-0731"]);
});

test("prefers the entry with more votes when a source repeats a name", () => {
  const models = [toRow(catalogModel({ model_name: "example/model" }))];
  const { pairs } = matchScores(models, [
    { name: "example/model", score: 10, votes: 5 },
    { name: "example/model", score: 20, votes: 900 },
  ]);

  assert.equal(pairs[0].score, 20);
});

test("ranks by score per blended dollar", () => {
  const cheap = { cost: { input: 0.1, output: 0.1 }, id: "cheap" };
  const dear = { cost: { input: 10, output: 10 }, id: "dear" };
  const ranked = rankByValue([
    { model: dear, score: 50 },
    { model: cheap, score: 50 },
  ]);

  assert.deepEqual(ranked.map((pair) => pair.model.id), ["cheap", "dear"]);
  assert.equal(ranked[0].value, 500);
});

test("parses a quoted CSV field containing a comma", () => {
  const rows = parseCsv('name,score\n"a, b",1.5\nplain,2\n');

  assert.deepEqual(rows, [
    { name: "a, b", score: "1.5" },
    { name: "plain", score: "2" },
  ]);
});

test("parses a long-format CSV into records keyed by header", () => {
  const rows = parseCsv("model,benchmark,performance\nGPT-5,MMLU,0.9\n");

  assert.equal(rows[0].model, "GPT-5");
  assert.equal(rows[0].performance, "0.9");
});

test("reads scores from an object or an array", () => {
  assert.deepEqual(scoresFromJson('{"GPT-5": 0.9}'), [{ name: "GPT-5", score: 0.9 }]);
  assert.deepEqual(scoresFromJson('[{"name": "GPT-5", "score": 0.9}]'), [{ name: "GPT-5", score: 0.9 }]);
});
