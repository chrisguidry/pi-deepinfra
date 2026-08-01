# pi-deepinfra

A [pi](https://pi.dev) extension that registers [DeepInfra](https://deepinfra.com) as a model provider. The catalog is discovered live, so there are no hard-wired model entries.

## Install

```bash
pi install npm:pi-deepinfra
```

Or from this repository:

```bash
pi install git:github.com/chrisguidry/pi-deepinfra
```

Restart pi, or run `/reload`, after installing.

## Setup

Set the API key in `~/.pi/agent/models.json` under the `deepinfra` provider. DeepInfra calls it a token. The value uses pi's built-in config resolution, so any of these work:

- An environment variable: `"apiKey": "$DEEPINFRA_TOKEN"`
- A leading command, whose stdout is the key. This is how you pull a secret from a vault, for example 1Password CLI:

```jsonc
{
  "providers": {
    "deepinfra": {
      "apiKey": "!op read 'op://Applications/DeepInfra/credential'"
    }
  }
}
```

The extension registers no apiKey of its own, so everything here wins through to the provider.

## Use

Open the model picker with `/model` (or `Ctrl+P`). Pi refreshes catalogs, and the DeepInfra models appear. With no key configured the models load but stay hidden, like other providers.

## What gets registered

The extension keeps only serving text-generation models that can call tools, and drops the rest: deprecated and replaced entries, models without tool calling, and every non-chat model (image, video, audio, embeddings). Pi sends tool definitions on every request, so a model without tool calling fails on DeepInfra. The filter keeps roughly 85 models from a catalog of 350.

On each model refresh the extension fetches `https://api.deepinfra.com/models/list`, converts DeepInfra's per-token pricing into pi's per-million-token cost fields, and persists the result to pi's model store. The catalog is available offline after the first refresh.

Every model is registered with `supportsDeveloperRole: false`. DeepInfra's OpenAI-compatible endpoint accepts only the `system`, `user`, `assistant`, and `tool` roles, and without the override pi sends the system prompt as a `developer` message on reasoning models, which DeepInfra rejects with HTTP 422.

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
