# pi-deepinfra

[![CI](https://github.com/chrisguidry/pi-deepinfra/actions/workflows/ci.yml/badge.svg)](https://github.com/chrisguidry/pi-deepinfra/actions/workflows/ci.yml)

A [pi](https://pi.dev) extension that registers [DeepInfra](https://deepinfra.com) as a model provider. The catalog is discovered live, so there are no hard-wired model entries — only a small patch table for catalog gaps, described under [Thinking levels](#thinking-levels).

## Install

```bash
pi install git:github.com/chrisguidry/pi-deepinfra
```

Restart pi, or run `/reload`, after installing.

## Setup

Set the `DEEPINFRA_API_KEY` environment variable to your DeepInfra token, and you are done:

```bash
export DEEPINFRA_API_KEY=...
```

If you prefer to keep the key out of the environment, set it in `~/.pi/agent/models.json` under the `deepinfra` provider instead. The value uses pi's built-in config resolution: a literal, an env var reference, or a leading command whose stdout is the key. This is how you pull a secret from a vault, for example 1Password CLI:

```jsonc
{
  "providers": {
    "deepinfra": {
      "apiKey": "!op read 'op://Applications/DeepInfra/credential'"
    }
  }
}
```

If `DEEPINFRA_API_KEY` is set, it wins over the `models.json` entry, because extension-registered config takes precedence in pi. Unset the variable to use the `models.json` key.

## Use

Open the model picker with `/model` (or `Ctrl+P`). Pi refreshes catalogs, and the DeepInfra models appear. With no key configured the models load but stay hidden, like other providers.

## Choosing a model

The package ships a [skill](skills/deepinfra-models/SKILL.md) for questions about which model to use. Ask pi "what's the cheapest model here with vision?" or "which model is the best value for coding right now?", or ask it to pick the model for a subagent, and it runs the bundled script rather than guessing from stale memory:

```bash
node skills/deepinfra-models/scripts/models.mjs --vision --max-price 0.3 --sort price
node skills/deepinfra-models/scripts/models.mjs score --source arena --limit 15
node skills/deepinfra-models/scripts/models.mjs show GLM-5.3-Flash
```

Everything is read from DeepInfra and from keyless benchmark sources: scores come from the Arena's published leaderboard and from Epoch AI's benchmark CSV, while prices always come from DeepInfra, so an intelligence-per-dollar figure reflects what you actually pay. Each source covers a bit over half the catalog and they disagree on which half, so the script names the models it could not score instead of quietly ranking a shorter list.

The provider and the skill share a cache in `$XDG_CACHE_HOME/pi-deepinfra`. The extension writes the raw catalog there on every model refresh, so a question asked after a refresh downloads nothing, and the skill caches each benchmark source beside it for six hours. Epoch's copy is revalidated with an ETag rather than refetched. Each run says where its numbers came from; `--refresh` ignores the cache.

A run also reports any data ambiguity it hit — a join that nearly happened, a context window that came from a default, a price that looks wrong — because those reports are how the script gets better. `--diagnose` prints each one with the evidence and a suggested fix:

```bash
node skills/deepinfra-models/scripts/models.mjs score --source epoch --diagnose
```

Neither the script nor the skill keeps a list of model names or aliases. Joining DeepInfra's ids to another site's names is done by rule at query time, so a model released tomorrow needs no change here. [The reference](skills/deepinfra-models/reference.md) covers the pricing arithmetic, the tag semantics, and the source schemas.

## What gets registered

The extension keeps only serving text-generation models that can call tools, and drops the rest: deprecated and replaced entries, models without tool calling, and every non-chat model (image, video, audio, embeddings). Pi sends tool definitions on every request, so a model without tool calling fails on DeepInfra. The filter keeps roughly 85 models from a catalog of 350.

On each model refresh the extension fetches `https://api.deepinfra.com/models/list`, converts DeepInfra's per-token pricing into pi's per-million-token cost fields, and persists the result to pi's model store. The catalog is available offline after the first refresh.

DeepInfra publishes a list price per token and a `discount` that is the fraction off it, and its model pages show both figures with the discounted one as the price today. The extension registers the discounted price, and multiplies the cache rate by that discounted input price, which is how DeepInfra computes it.

Every model is registered with `supportsDeveloperRole: false`. DeepInfra's OpenAI-compatible endpoint accepts only the `system`, `user`, `assistant`, and `tool` roles, and without the override pi sends the system prompt as a `developer` message on reasoning models, which DeepInfra rejects with HTTP 422.

## Thinking levels

Pi's thinking levels map to the OpenAI-style `reasoning_effort` parameter, which DeepInfra validates against the full scale: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, each measurably different. Every reasoning model gets all of them in the picker. A model counts as reasoning when the catalog tags it `reasoning` or `can-disable-reasoning`: DeepInfra records some models only as the latter, sometimes beside a stale `non-reasoning`, and those still take the full scale. Models tagged `can-disable-reasoning` in the catalog also get an explicit `off` level that sends `reasoning_effort: "none"` and turns reasoning off. Other reasoning models produce reasoning output no matter what the request asks for, so the extension hides `off` on those models.

DeepInfra sometimes omits a capability tag its endpoint still serves, and the extension reads capabilities from tags alone, so the gap would register the model as not having the capability. A small patch table keyed by model id adds the missing tags for the gaps observed so far — currently Kimi-K3, which serves `reasoning_effort` including `none` but ships with no reasoning tag. The table lists nothing else about those models, and the skill's diagnostics report a patch whose model left the catalog or whose tags the catalog has since added, so it gets deleted rather than maintained.

The catalog does not publish a context window. The extension uses each model's `max_tokens` as its context window, because DeepInfra sets `max_tokens` to the model's context length. That is the only size signal the endpoint exposes.

## Tuning individual models

The default output cap is 16,384 tokens and the context window comes from the catalog. To correct a specific model, add a `modelOverrides` entry keyed by `deepinfra/<model-id>` in `models.json`. For example, to raise the output cap on a long-context model:

```jsonc
{
  "modelOverrides": {
    "deepinfra/deepseek-ai/DeepSeek-R1": {
      "maxTokens": 32768
    }
  }
}
```

## Development

```bash
npm install
npm run check   # type-check
npm test        # unit tests (Node 24+)
```

Install the local checkout for a quick test:

```bash
pi install /path/to/pi-deepinfra
```

## License

MIT
