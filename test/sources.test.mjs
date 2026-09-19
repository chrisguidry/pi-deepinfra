import assert from "node:assert/strict";
import test from "node:test";

import { arenaScores, epochScores } from "../skills/deepinfra-models/scripts/sources.mjs";

function stubFetch(t, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => {
    globalThis.fetch = original;
  });
}

const EPOCH_CSV = `model_id,benchmark_id,performance,benchmark,benchmark_release_date,model,model_version,Model,date,source
m1,b1,0.5,DeepSWE,2025-01-01,Model A,v1,Model A,2025-01-01,src
m1,b2,0.7,SWE-Bench verified,2025-01-01,Model A,v1,Model A,2025-01-01,src
m1,b3,0.1,MMLU,2025-01-01,Model A,v1,Model A,2025-01-01,src
m2,b1,0.3,DeepSWE,2025-01-01,Model B,v1,Model B,2025-01-01,src
`;

function epochFetch(csv) {
  return async () => ({ ok: true, text: async () => csv });
}

function scoreFor(scores, name) {
  return scores.find((entry) => entry.name === name)?.score;
}

test("averages every Epoch benchmark when no pattern is given", async (t) => {
  stubFetch(t, epochFetch(EPOCH_CSV));

  const { scores, benchmarks } = await epochScores();

  assert.equal(benchmarks.length, 3);
  assert.equal(scoreFor(scores, "Model A"), (50 + 70 + 10) / 3);
});

test("narrows the Epoch mean to the benchmarks matching a pattern", async (t) => {
  stubFetch(t, epochFetch(EPOCH_CSV));

  const { scores, benchmarks } = await epochScores({ benchmark: "*SWE*" });

  assert.deepEqual(benchmarks, ["DeepSWE", "SWE-Bench verified"]);
  assert.equal(scoreFor(scores, "Model A"), 60);
  assert.equal(scoreFor(scores, "Model B"), 30);
});

test("a pattern that matches nothing fails instead of reporting no data", async (t) => {
  stubFetch(t, epochFetch(EPOCH_CSV));

  await assert.rejects(epochScores({ benchmark: "not-a-benchmark" }), /no Epoch benchmark matched/);
});

const ARENA_AGENT_PAGE = {
  num_rows_total: 2,
  rows: [
    { row: { model_name: "glm-5.3-flash", score: 0.0115, observation_count: 900, rank: 1, category: "overall" } },
    { row: { model_name: "v4-pro", score: -0.0071, observation_count: 100, rank: 2, category: "overall" } },
  ],
};

const ARENA_TEXT_PAGE = {
  num_rows_total: 2,
  rows: [
    { row: { model_name: "glm-5.3-flash", rating: 1475.4, vote_count: 500, rank: 1, category: "overall" } },
    { row: { model_name: "v4-pro", rating: 1400.1, vote_count: 300, rank: 2, category: "overall" } },
  ],
};

test("reads the rating and vote count the text leaderboards publish", async (t) => {
  stubFetch(t, async () => ({ ok: true, json: async () => ARENA_TEXT_PAGE }));

  const { scores, centered } = await arenaScores();

  assert.equal(scoreFor(scores, "glm-5.3-flash"), 1475.4);
  assert.equal(scores[0].votes, 500);
  assert.equal(centered, false);
});

// The agent leaderboard publishes an IPS `score` and an `observation_count`
// instead, and a zero there means the leaderboard has not placed the model.
test("reads the score and observation count the agent leaderboard publishes", async (t) => {
  stubFetch(t, async () => ({ ok: true, json: async () => ARENA_AGENT_PAGE }));

  const { scores, centered } = await arenaScores({ config: "agent" });

  assert.equal(scoreFor(scores, "glm-5.3-flash"), 0.0115);
  assert.equal(scores[0].votes, 900);
  assert.equal(centered, true);
});

test("drops rows from a category other than the one asked for", async (t) => {
  const mixed = {
    num_rows_total: 2,
    rows: [
      { row: { model_name: "wanted", rating: 1500, vote_count: 1, category: "overall" } },
      { row: { model_name: "ignored", rating: 1500, vote_count: 1, category: "chinese" } },
    ],
  };
  stubFetch(t, async () => ({ ok: true, json: async () => mixed }));

  const { scores } = await arenaScores({ category: "overall" });

  assert.deepEqual(scores.map((entry) => entry.name), ["wanted"]);
});

// The dataset server returns 429 when it has had enough traffic, and 502 while
// it loads an index. Both are worth waiting out rather than failing the run.
test("retries a rate-limited response and succeeds", async (t) => {
  let calls = 0;
  stubFetch(t, async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429 };
    return { ok: true, json: async () => ARENA_TEXT_PAGE };
  });

  const { scores } = await arenaScores();

  assert.equal(calls, 2);
  assert.equal(scoreFor(scores, "glm-5.3-flash"), 1475.4);
});

test("fails at once on a status that will not improve", async (t) => {
  let calls = 0;
  stubFetch(t, async () => {
    calls += 1;
    return { ok: false, status: 404 };
  });

  await assert.rejects(arenaScores(), /HTTP 404/);
  assert.equal(calls, 1);
});
