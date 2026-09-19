import assert from "node:assert/strict";
import test from "node:test";

import { toRow } from "../skills/deepinfra-models/scripts/catalog.mjs";
import { catalogAnomalies, joinAnomalies, summarize } from "../skills/deepinfra-models/scripts/diagnostics.mjs";

function row(overrides = {}) {
  return toRow({
    model_name: "example/model",
    type: "text-generation",
    tags: ["openai", "tools"],
    max_tokens: 131_072,
    pricing: { cents_per_input_token: 9e-6, cents_per_output_token: 1.8e-5 },
    is_partner: false,
    description: "",
    ...overrides,
  });
}

function kinds(findings) {
  return findings.map((finding) => finding.kind);
}

test("reports nothing about a clean catalog", () => {
  assert.deepEqual(catalogAnomalies([row()]), []);
});

test("reports a context window that came from the default", () => {
  const findings = catalogAnomalies([row({ max_tokens: null })]);

  assert.deepEqual(kinds(findings), ["context-fallback"]);
});

test("reports a model priced at zero", () => {
  const findings = catalogAnomalies([row({ pricing: undefined })]);

  assert.deepEqual(kinds(findings), ["zero-price"]);
});

test("groups hybrid reasoning models into one finding", () => {
  const hybrids = [
    row({ model_name: "a/one", tags: ["openai", "tools", "reasoning", "non-reasoning"] }),
    row({ model_name: "a/two", tags: ["openai", "tools", "reasoning", "non-reasoning"] }),
  ];
  const findings = catalogAnomalies(hybrids);

  assert.deepEqual(kinds(findings), ["hybrid-reasoning"]);
  assert.equal(findings[0].subject, "2 models");
});

test("flags a disable-reasoning override the extension never reads", () => {
  const findings = catalogAnomalies([row({ tags: ["openai", "tools", "can-disable-reasoning"] })]);

  assert.deepEqual(kinds(findings), ["thinking-levels-missing"]);
});

test("reports a cache rate above one as unexpected", () => {
  const findings = catalogAnomalies([
    row({ pricing: { cents_per_input_token: 9e-6, rate_per_input_token_cached: 1.5 } }),
  ]);

  assert.deepEqual(kinds(findings), ["cache-costlier-than-input"]);
});

test("reports a discount outside the fraction range", () => {
  const findings = catalogAnomalies([
    row({ pricing: { cents_per_input_token: 9e-6, discount: 30 } }),
  ]);

  assert.deepEqual(kinds(findings), ["discount-out-of-range"]);
});

test("reports nothing when every model joins a score", () => {
  const findings = joinAnomalies([row()], [{ name: "example/model", score: 1 }]);

  assert.deepEqual(findings, []);
});

test("groups a family that shares one benchmark name", () => {
  const models = [row({ model_name: "a/one" }), row({ model_name: "a/one-0731" })];
  const findings = joinAnomalies(models, [{ name: "a-one", score: 1 }]);

  assert.deepEqual(kinds(findings), ["shared-score"]);
  assert.equal(findings[0].subject, "2 models");
});

test("names the source side when only the source has the extra word", () => {
  const findings = joinAnomalies(
    [row({ model_name: "google/gemini-3.1-pro" })],
    [{ name: "gemini-3.1-pro-preview", score: 1 }],
  );

  assert.deepEqual(kinds(findings), ["near-miss"]);
  assert.match(findings[0].subject, /on the source name/);
  assert.match(findings[0].hint, /stripping "preview" from the source name/);
});

test("names the catalog side when only the catalog has the extra word", () => {
  const findings = joinAnomalies(
    [row({ model_name: "google/gemma-4-26B-A4B-it" })],
    [{ name: "gemma-4-26b-a4b", score: 1 }],
  );

  assert.deepEqual(kinds(findings), ["near-miss"]);
  assert.match(findings[0].subject, /on the catalog name/);
});

test("stays quiet when the names are unrelated rather than near", () => {
  const findings = joinAnomalies(
    [row({ model_name: "deepseek-ai/DeepSeek-V4-Flash" })],
    [{ name: "claude-opus-5", score: 1 }],
  );

  assert.deepEqual(findings, []);
});

test("counts findings by kind with the most common first", () => {
  const findings = [{ kind: "a" }, { kind: "b" }, { kind: "a" }];

  assert.deepEqual(summarize(findings), [["a", 2], ["b", 1]]);
});
