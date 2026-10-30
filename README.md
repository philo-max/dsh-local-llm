# dsh-local-llm

Detect, probe and register **local OpenAI-compatible LLM servers** as [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) model providers.

Works with LM Studio, Ollama, vLLM, llama.cpp server, SGLang, KoboldCpp, text-generation-webui, Jan and LocalAI — anything speaking the OpenAI chat-completions protocol.

## Why this exists

Pointing the Harness at `http://127.0.0.1:1234/v1` looks trivial and then fails in two specific ways:

**1. The context window is too small.** The Harness system prompt plus tool schemas is roughly **30,000 tokens** before you type anything. A server loaded with the common default of 8192 tokens rejects every request:

```
request (30228 tokens) exceeds the available context size (8192 tokens)
```

**2. The server rejects the `developer` role or `reasoning_effort`.** Many local chat templates do not understand these OpenAI extensions and answer with a 400.

Both are detectable *before* writing configuration. This plugin probes for them and writes only the switches the endpoint actually needs.

## Settings panel

The bundle also adds **Settings → Local LLM**: enter a host and ports, scan, and
each endpoint appears as a card showing its vendor, loaded/max context window,
and tool-calling support. Pick a model and click **Register as provider** — no
hand-written YAML.

The panel talks to the Host through two same-origin routes registered on
`ctx.webServer` (`/local-llm/scan`, `/local-llm/register`), because a plain-JS
Client module cannot call Host services directly.

## Tools

### `local_llm_scan`
Probe well-known ports for reachable servers.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `ports` | integer[] | 1234, 11434, 8000, 8080, 5000, 3000, 7860, 8888 | Ports to probe |
| `host` | string | `127.0.0.1` | Host to probe |
| `probe` | boolean | `false` | Run capability probes |
| `apiKey` | string | — | Bearer token for servers that require one |

With `probe: true` each endpoint is additionally checked for:

- **loaded context window** (via LM Studio's native `/api/v0/models`, which reports `loaded_context_length` separately from `max_context_length`)
- **tool calling** — a real round trip with a `get_weather` schema, verifying the model emits `tool_calls` with parseable arguments
- **`developer` role** and **`reasoning_effort`** acceptance

Endpoints that would fail are flagged with `warnings`.

### `local_llm_register`

Write a working provider entry into the `llm-pi-ai` config.

| Argument | Required | Meaning |
|---|---|---|
| `providerId` | yes | Route name, lowercase-hyphenated (`local-lmstudio`) |
| `baseUrl` | yes | OpenAI-compatible URL including `/v1` |
| `modelId` | yes | Model id exactly as the server reports it |
| `displayName` | no | Label in the model selector |
| `contextWindow` | no | **Use the loaded context, not the model maximum** |
| `maxTokens` | no | Output cap, defaults to 8192 |
| `apiKey` | no | Local servers ignore the value; the client still needs the header |
| `supportsDeveloperRole` | no | `false` writes `compat.supportsDeveloperRole: false` |
| `supportsReasoningEffort` | no | `false` writes `compat.supportsReasoningEffort: false` |
| `supportsImages` | no | Declares `input: ["text", "image"]` |
| `dryRun` | no | Return the config without applying it |

Changes take effect on the **next model request** — no restart.

## Install

```bash
git clone https://github.com/philo-max/dsh-local-llm
```

Then install the directory as a bundle in the Harness profile. The plugin mounts itself through `cordis.patch.yml`; no manual profile editing is required.

## Configuration

```yaml
- id: local-llm
  name: 'dsh-local-llm'
  config:
    host: 127.0.0.1
    ports: [1234, 11434, 8000, 8080]
    probe: true
    timeoutMs: 5000
```

All fields are optional.

## Worked example: LM Studio

```
local_llm_scan { probe: true }
```

```json
{
  "baseUrl": "http://127.0.0.1:1234/v1",
  "vendor": "lmstudio",
  "models": ["gemma-4-12b-it-qat-uncensored-heretic-v3"],
  "context": { "loadedContext": 32768, "maxContext": 262144 },
  "tools": { "supported": true },
  "compat": { "supportsDeveloperRole": true, "supportsReasoningEffort": true }
}
```

```
local_llm_register {
  providerId: "local-lmstudio",
  baseUrl: "http://127.0.0.1:1234/v1",
  modelId: "gemma-4-12b-it-qat-uncensored-heretic-v3",
  contextWindow: 32768
}
```

Note `contextWindow: 32768` uses the **loaded** value. Declaring the 262144 maximum would let the Harness build requests the server then rejects.

## Gotchas worth knowing

**Sliding-window models need far less VRAM than they appear to.** Gemma 4 keeps 40 of 48 layers on a 1024-token sliding window, so KV cache stays small: 128k context measured **7.7 GB** of VRAM on an 8 GB laptop GPU. LM Studio's `--estimate-only` assumes full attention and overestimates by 2–3×. Trust a real load over the estimate.

**Reasoning models can spend the whole budget on the chain of thought.** A Gemma 4 12B test with `max_tokens: 200` returned an empty `content` because all 200 tokens went to `reasoning_content`. Give at least 1000–2000 output tokens or you will see blank replies.

**GGUF cannot be abliterated.** Directional ablation needs full-precision weights; a `.gguf` is already quantized. Download the original safetensors if you intend to modify a model.

## License

MIT
