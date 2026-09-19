# DeepInfra and benchmark data reference

The details behind the script, including the ones that are easy to get wrong.

## The catalog

`https://api.deepinfra.com/models/list` returns a flat JSON array of every
model DeepInfra lists, with pricing, tags, `max_tokens`, `is_partner`,
`deprecated`, and `replaced_by`. It needs no key and carries no context window
field.

The script keeps a model only when all of these hold:

- `type` is `text-generation`
- not `deprecated` and not `replaced_by` — those entries are gone or broken
- tagged `openai`, meaning the OpenAI chat-completions API
- tagged `tools`, meaning function calling

The `tools` requirement is not optional. pi sends tool definitions on every
request, and DeepInfra rejects a request carrying them with HTTP 405 when the
model cannot call tools. That filter takes about 97 of 377 entries.

## Pricing

Prices arrive in two units, and only one of them is named the way it behaves.

- `cents_per_input_token` and `cents_per_output_token` are the **list** price in
  cents per token. Dollars per million is `value * 10000`.
- `discount` is the **fraction off** the list price, so `0.3` means pay 70%.
  DeepInfra's model pages show both figures side by side, with the discounted
  one as the price today. The GLM-5.3-Flash page renders `$0.075 in $0.25 out
  $0.015 cached` next to `/ 1M tokens $0.15 in $0.50 out $0.03 cached`. The
  script and the provider both register the discounted price.
- `rate_per_input_token_cached` is a **multiplier on the input price**, not a
  price. `0.2` means cache reads cost 20% of input. The multiplier applies to
  the discounted input price, which is what makes the cached figure match the
  page.
- `rate_per_input_token_cache_write` is null on every model, so cache writes
  register as free. `rate_per_explicit_cache_write_token` holds the real cost of
  opt-in explicit caching as a map of TTL to multiplier, `{"5m": 1.25, "1h":
  2.0}`, alongside `explicit_cache_granularity_tokens`. pi's automatic caching
  is not that feature.
- `rate_per_service_tier_priority` (1.5) and `rate_per_service_tier_flex` (0.8)
  are multipliers for DeepInfra's priority and flex tiers. pi has no concept of
  a service tier, so the registered price is the standard one.

A blended price here is 3:1 input:output, matching the convention Artificial
Analysis uses, so a score per dollar figure stays comparable if the score source
changes.

## Tags

| Tag | Meaning |
|---|---|
| `openai` | speaks the OpenAI chat-completions API |
| `tools` | can call functions |
| `reasoning` | supports reasoning |
| `non-reasoning` | answers without reasoning by default |
| `can-disable-reasoning` | accepts `reasoning_effort: "none"` |
| `multimodal` | takes image input; pi maps it to `["text", "image"]` |
| `input-audio`, `input-video` | take audio or video input |
| `json`, `structured-output` | JSON mode and schema-constrained output |
| `ocr` | aimed at OCR |
| `flex`, `priority` | priced by the service tier multipliers above |
| `b200` | served on B200 hardware |
| `no-free-anon` | not on the anonymous free tier; the name is its documentation |

`reasoning` and `non-reasoning` appear together on five models. That is not a
contradiction: it marks a hybrid that reasons on demand. The extension registers
those with the full effort scale, which is the right reading.

`can-disable-reasoning` appears on three models that are *not* tagged
`reasoning`. The extension only builds a thinking level map for models tagged
`reasoning`, so on those the override never reaches pi. Worth checking whether
the API takes `reasoning_effort` there.

## Zero retention

DeepInfra serves partner models from the partner's own infrastructure and
forwards requests to them; its own model pages say so. Non-partner models render
a `Zero retention` chip and partner models do not. That makes `is_partner:
false` the zero-retention set, which is roughly the open-weight catalog.

## Context window

The catalog publishes none. `max_tokens` is the context length, so the extension
uses it and falls back to 128,000 when it is missing. A fallback is a guess, and
the diagnostics report it as one.

## Thinking levels

Reasoning models on DeepInfra accept the whole OpenAI-style scale: `none`,
`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and anything else is
rejected with HTTP 422. pi leaves `xhigh` and `max` out of the level cycle
unless the map pins them to a non-null string, and hides a level pinned to
`null`. `off` therefore maps to `none` only on models tagged
`can-disable-reasoning`; on the others the model reasons regardless of the
request, so offering `off` would be a lie.

## Benchmark sources

Both built-in sources are keyless, and neither stores a number in this repo: the
script fetches them and caches the result for a few hours.

**Arena** — `https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=<config>&split=latest&offset=<n>&length=100`

The published leaderboard dataset, paginated 100 rows per request. Configs are
separate leaderboards rather than categories, and each one answers a different
question:

| Config | What it ranks |
|---|---|
| `text_style_control` | general chat, and the default |
| `vision_style_control` | image input |
| `webdev` | the Code Arena, and the best keyless coding signal |
| `agent` | agentic work, scored by IPS rather than by rating |
| `document`, `search` | long-document and search-grounded work |

`--category` selects within a config (`overall`, `coding`, `math`, `chinese`)
and is not how you reach another leaderboard.

Every config but `agent` reports `rating`, a Bradley-Terry score on the old Elo
scale, plus `vote_count`, `rank`, and `leaderboard_publish_date`. `agent`
reports an IPS `score` and an `observation_count` instead. That score is centred
near zero, so it is a signed offset rather than a magnitude: it orders models,
and a ratio of it to a price means nothing, which is why the script leaves the
value column out for that config. Cite <https://arena.ai/leaderboard>.

**Epoch AI** — `https://epoch.ai/data/eci_benchmarks.csv`

One row per benchmark result in long format: `model_id`, `benchmark_id`,
`performance`, `benchmark`, `benchmark_release_date`, `model`, `model_version`,
`date`, `source`. `performance` is normalized to 0–1 per benchmark. The script's
score is the unweighted mean of a model's results times 100, which is a coarse
composite — Epoch's own dashboards weight the benchmarks — but it needs no
maintained list of which benchmarks matter.

`--benchmark` narrows the mean to benchmark names matching a pattern, where `*`
is a wildcard and the match ignores case and anchors both ends. `--benchmark
'*SWE*'` averages just the software-engineering benchmarks, which is how you get
a coding composite without this repo deciding which benchmarks count. A pattern
that matches nothing fails with the list of names it has, rather than reporting
a source with no data. Licensed CC BY; credit Epoch AI.

The Arena dataset server answers 502 while it loads an index and 429 when it is
busy, so both fetches retry those a few times with a short backoff. Other status
codes fail at once, because those are real errors.

Both cover a bit over half of DeepInfra's catalog and disagree on which half:
Arena indexes human preference and has a vision split, Epoch indexes benchmark
results and reaches models Arena has never heard of. Run both.

### Adding a source

`--scores` takes any `{name: score}` object, an array of `{name, score}`, or a
two-column CSV, from a file or stdin, so a leaderboard neither source carries
needs no code change:

```bash
curl -s "<url>" | jq -c '<flatten to {name: score}>' | node scripts/models.mjs score --scores -
```

For a site that renders client-side, the numbers are usually sitting in an
embedded JSON payload rather than in the HTML text. Fetch the page, find the
payload, then flatten it — parsing the rendered markup is the fragile path, and
anything computed from it is only as good as the day the layout held still.

## The join, and where it fails

Sources spell models differently. `deepseek-ai/DeepSeek-V4-Flash` in the
catalog is `deepseek-v4-flash` in the Arena and `DeepSeek V4 Flash 0731` in
Epoch.

`normalizeName` takes the last path segment, lowercases it, strips release dates
(`-0731`, `-2407`, `-2025-09-23`), and strips packaging and quantization
suffixes repeatedly so stacked ones like `-Instruct-Turbo` both come off. It
deliberately leaves words that distinguish models: `preview`, `thinking`,
`max`, `flash`, and the size tiers. A missed match costs a data point; a wrong
match ranks a model that was never measured.

A consequence is that several catalog entries can collapse onto one benchmark
name — a dated snapshot and its base model, or a plain and a Turbo build. They
share a score, marked `~` in the output, because no source distinguishes them.
Do not present a family score as measured per entry.

### Effort variants

The Arena logs one row per reasoning effort, as `glm-5.3-max` or
`deepseek-v4-flash-high`, and it often has no row for the model at its default
effort. Those rows used to be dropped, which made the leaderboard look sparse
rather than wrong: `DeepSeek-V4.1-Flash` reported as unmeasured while
`deepseek-v4.1-flash-max` sat above every model that did score.

So the join runs a second lookup. When no exact row exists, `matchScores` strips
an effort suffix from the source name and looks up the base model. Every effort
level is tried, longest suffix first so `-xhigh` does not strip as `-high`. When
one model has several effort rows, the one with the most votes supplies the
score.

The stripping applies to source names only, never to catalog names. `max` names
an effort level in a source name and a tier in some catalog ids, so stripping
both sides would collapse `Qwen3.8-Max`, a model of its own, onto whatever row
happens to be named `qwen3.8`. An effort suffix on the source side is the only
thing separating it from the model it varies, which makes that side the safe one
to strip.

An effort-derived score is marked `^` and listed under the table, because it is
the model at one effort level rather than at the default. It is a real
measurement of the same weights, and it inflates the number slightly.

### No alias table

Nothing here maps one model's name to another's. There is no entry saying
`qwen3-max-thinking` equals anything, and a model released tomorrow joins
without touching this repo: the rules run against whatever the source happens to
call it. The `PACKAGING_SUFFIXES` list is packaging and quantization words, not
model names.

The near-miss diagnostics are what takes the place of a hand-maintained list.
They derive candidate suffixes from whatever the live data contains, group them
by suffix and by which side carries it, and print the rule that would join them.
When a source changes its naming convention, the report says which suffix
appeared and where, and whether to strip it stays a judgment call instead of a
silent guess.

## Diagnostics

Every run ends with a summary of anything ambiguous it saw, and `--diagnose`
prints each finding with the evidence and the fix it suggests. `--json` includes
the same findings under `diagnostics`, which is the form to collect across runs.

| Kind | What it means |
|---|---|
| `near-miss` | an unscored model and a source name differ by one word, grouped by suffix and by which side carries it. A normalization rule is probably missing, and this is the report that found the effort variants |
| `shared-score` | several catalog models collapse onto one benchmark name |
| `context-fallback` | no `max_tokens`, so the context window is the default |
| `zero-price` | input and output both priced at zero |
| `cache-costlier-than-input` | cache multiplier above 1 |
| `discount-out-of-range` | discount is not a fraction between 0 and 1 |
| `discount-expiring` | the discount has an end date, so a registered price will be too low later |
| `hybrid-reasoning` | tagged reasoning and non-reasoning together |
| `thinking-levels-missing` | `can-disable-reasoning` on a model the extension does not treat as reasoning |
| `duplicate-id` | the catalog lists an id twice |

A run that finds nothing prints nothing.

## Caching

The provider and the skill share one cache directory, `$XDG_CACHE_HOME/pi-deepinfra`
(else `~/Library/Caches` on macOS, else `~/.cache`). The extension writes
`catalog.json` on every model refresh, because pi keeps only the converted model
list and that conversion drops the tags, the `is_partner` flag, and the discount
fields the skill filters and ranks on. The skill reads that file, so a question
asked after a refresh costs no download at all.

The skill caches its own two sources beside it, keyed by the Arena config and
category, and holds the whole Epoch CSV rather than one pattern's result because
any pattern can be derived from the CSV and the CSV is the download worth
avoiding. Entries live six hours, which matches how often a model catalog or a
leaderboard actually changes.

Epoch serves an `ETag`, so an entry whose window has lapsed is revalidated with
`If-None-Match` and a `304` restarts the window without moving any bytes. The
DeepInfra catalog and the Arena dataset server send no validator, so those are
refetched when the window lapses.

Every run reports where its numbers came from, as `data: catalog cached, 20 min
ago, arena fetched now`. `--refresh` ignores the cache, and `--catalog <file>`
replaces the catalog question entirely.
