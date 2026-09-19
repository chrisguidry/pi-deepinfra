---
name: deepinfra-models
description: Answers questions about which DeepInfra model to use by price, capability, and benchmark score per dollar. Knows DeepInfra's catalog quirks (discount pricing, cache multipliers, ZDR, context window), pulls live benchmark data from keyless sources, and picks the model and thinking level for pi subagents. Use when asked which model is best, cheapest, strongest, or best value, when comparing models, when asked what a model costs, or when choosing a model for a subagent.
---

# Choosing a DeepInfra model

Every question here is answered by one script, `scripts/models.mjs`, which reads
DeepInfra's live catalog and joins it to a live benchmark source. No API key is
involved.

`scripts/models.mjs` is relative to this skill's directory, the one pi reports
as this file's location. Run the commands from there or use the absolute path.
A path built from the repository root does not find the script.

## The three questions

**What exists, and what does it cost?**

```bash
cd /path/to/this/skill    # the directory holding this SKILL.md
node scripts/models.mjs                                  # every serving model
node scripts/models.mjs --vision --max-price 0.3 --sort price
node scripts/models.mjs --reasoning --zdr --min-context 200000
node scripts/models.mjs show deepseek-ai/DeepSeek-V4.1-Flash
```

The blocks below leave out the `cd` and name the script the same way.

**How does this model compare on quality?** Quality comes from a benchmark
source, not from DeepInfra, so it needs the `score` command:

```bash
node scripts/models.mjs score --source arena --limit 15
node scripts/models.mjs score --source epoch --limit 15
node scripts/models.mjs score --source arena --config webdev --limit 15
node scripts/models.mjs score --source epoch --benchmark '*SWE*'
node scripts/models.mjs score --source arena --config vision_style_control --vision
```

Arena configs are separate leaderboards, not categories, and they answer
different questions. `webdev` is the Code Arena and is the best keyless coding
signal available, so reach for it whenever the question is about code.
`vision_style_control` pairs with the `--vision` filter to rank image-capable
models by how well they handle images.

Epoch averages every benchmark it has, which mixes reading comprehension with
terminal work. `--benchmark` narrows that mean to the benchmarks whose names
match a pattern, so a coding-only composite is one command instead of a
hand-built pipeline.

**What is the best capability per dollar?** Same command — the `score/$` column
divides the source's score by DeepInfra's blended price, so it is what *you*
pay rather than what some other provider charges.

## Reading the output

Both sources are keyless and both cover a bit over half the catalog, and they
disagree on which half: Arena indexes human preference, Epoch indexes benchmark
results. Run both before concluding anything is unbenchmarked. When you report
a finding, carry the coverage line with it — "scored 54 of 97" — because the
misses include brand-new models.

The script marks a score shared across a model family with `~`. A dated
snapshot and its base model share one score because no source distinguishes
them, so do not present that score as measured per entry. It marks a score taken
from an effort variant with `^`, which happens when the source measured the
model at one effort level and has no row for its default. That is the same
weights, and the score runs slightly high, so say which variant supplied it.

Prices are DeepInfra's current price, with any temporary discount applied.

Results are cached for a few hours, and the footer says where each number came
from. `--refresh` ignores the cache when you want the bytes fetched again.

## Choosing a model for a subagent

The `spec` field is exactly what pi's `model` parameter wants:

```bash
node scripts/models.mjs show GLM-5.3-Flash      # prints "use as  deepinfra/zai-org/GLM-5.3-Flash"
```

Pass that whole `deepinfra/<id>` string to the Agent tool's `model` parameter.
Fuzzy names are ambiguous across providers — `glm-5.3-flash` may resolve
somewhere else or nowhere — so use the full spec.

Match the model to the job:

- **Coding or multi-step work** — filter `--reasoning --min-context 200000` and
  rank with `--config webdev` or `--source epoch --benchmark '*SWE*'`. Long-context
  work reuses the same prefix every turn, so the `cache $/M` column matters more
  than the input price.
- **Cheap bulk work** (file reads, classification, extraction) — `--non-reasoning
  --sort price`. A small model at a tenth the price is usually right.
- **Anything with images** — `--vision`. The flag comes from DeepInfra's
  `multimodal` tag, which is the only place that capability is recorded.

Set the subagent's `thinking` parameter only to a level the model offers; the
`flags` column shows whether it reasons at all, and `show` lists its exact
levels. Reasoning models on DeepInfra accept `minimal` through `max`. Only
models flagged `d` can turn reasoning off entirely, so do not ask the others
for `off`.

## When a source does not have the model

Neither source carries every leaderboard. For a coding-specific signal, or a
site neither one indexes, fetch the numbers yourself and pipe them in:

```bash
# Any {name: score} object, an array of {name, score}, or a two-column CSV.
node scripts/models.mjs score --scores /tmp/scores.json
curl -s "<url>" | jq -c '<flatten to {name: score}>' | node scripts/models.mjs score --scores -
```

Turn off the network dependence entirely by passing a file. See
[reference.md](reference.md) for the source schemas, the pricing arithmetic, and
the name-matching rules the join depends on.
