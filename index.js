/**
 * dsh-local-llm — detect, probe and register local OpenAI-compatible LLM
 * servers as DeepSeek Harness model providers.
 *
 * Why this exists: pointing the Harness at a local server looks trivial until
 * it fails. The two failure modes that actually bite are
 *   1. the server's loaded context window is far below the Harness request
 *      (a 8192-token window against a ~30k-token prompt is a hard 400), and
 *   2. the server does not speak the `developer` role or `reasoning_effort`,
 *      which some chat templates reject outright.
 * Both are detectable before writing config, so this plugin probes them.
 */

const DEFAULT_PORTS = [1234, 11434, 8000, 8080, 5000, 3000, 7860, 8888];

const WELL_KNOWN = [
  { id: 'lmstudio', label: 'LM Studio', ports: [1234] },
  { id: 'ollama', label: 'Ollama', ports: [11434] },
  { id: 'vllm', label: 'vLLM', ports: [8000] },
  { id: 'llamacpp', label: 'llama.cpp server', ports: [8080] },
  { id: 'sglang', label: 'SGLang', ports: [30000] },
  { id: 'koboldcpp', label: 'KoboldCpp', ports: [5001] },
  { id: 'textgenwebui', label: 'text-generation-webui', ports: [5000] },
  { id: 'jan', label: 'Jan', ports: [1337] },
  { id: 'localai', label: 'LocalAI', ports: [8080] },
];

/** Servers whose chat template rejects the `developer` role. */
const NO_DEVELOPER_ROLE = ['lmstudio', 'ollama', 'vllm', 'llamacpp', 'sglang', 'koboldcpp', 'textgenwebui', 'localai'];

function timeoutSignal(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

async function getJson(url, headers, ms = 4000) {
  const { signal, clear } = timeoutSignal(ms);
  try {
    const res = await fetch(url, { headers, signal });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, body: await res.json() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clear();
  }
}

async function postJson(url, headers, payload, ms = 60000) {
  const { signal, clear } = timeoutSignal(ms);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 400) };
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clear();
  }
}

/**
 * Probe one endpoint. Returns a descriptor describing what the server can
 * actually do, not merely whether it answered.
 */
async function probeEndpoint(baseUrl, headers, signal) {
  const models = await getJson(`${baseUrl}/models`, headers, 5000);
  if (!models.ok) {
    return { reachable: false, reason: models.error ?? `HTTP ${models.status}` };
  }
  const list = Array.isArray(models.body?.data) ? models.body.data : [];
  if (list.length === 0) return { reachable: false, reason: 'no models exposed' };

  const ids = list.map((m) => m.id).filter((v) => typeof v === 'string');
  // Prefer a chat-ish model; embedding-only servers are not useful here.
  const chatCandidate =
    ids.find((id) => !/embed|rerank/i.test(id)) ?? null;

  return {
    reachable: true,
    baseUrl,
    models: ids,
    chatModel: chatCandidate,
    embeddingOnly: chatCandidate === null,
  };
}

/**
 * Ask the server for the context window it actually loaded. LM Studio exposes
 * this directly; other servers need a probing request whose rejection message
 * states the limit.
 */
async function probeContextLength(baseUrl, headers, model) {
  // LM Studio's native API reports both max and currently loaded context.
  const native = await getJson(`${baseUrl.replace(/\/v1$/, '')}/api/v0/models`, headers, 5000);
  if (native.ok && Array.isArray(native.body?.data)) {
    const hit = native.body.data.find((m) => m.id === model);
    if (hit) {
      return {
        source: 'lmstudio-native',
        maxContext: hit.max_context_length ?? null,
        loadedContext: hit.loaded_context_length ?? null,
        loaded: hit.state === 'loaded',
      };
    }
  }
  return { source: 'unknown', maxContext: null, loadedContext: null, loaded: null };
}

/** Verify the server accepts a minimal tool-calling round trip. */
async function probeToolCalling(baseUrl, headers, model) {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      },
    },
  ];
  const r = await postJson(
    `${baseUrl}/chat/completions`,
    headers,
    {
      model,
      messages: [{ role: 'user', content: 'What is the weather in Beijing? Use the tool.' }],
      tools,
      max_tokens: 256,
      temperature: 0,
    },
    90000,
  );
  if (!r.ok) {
    return { supported: false, reason: r.body?.error?.message ?? r.error ?? `HTTP ${r.status}` };
  }
  const calls = r.body?.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(calls) && calls.length > 0) {
    const fn = calls[0].function;
    let parsed = null;
    try {
      parsed = JSON.parse(fn.arguments);
    } catch {
      /* leave null */
    }
    return {
      supported: true,
      sampleCall: { name: fn.name, argumentsValid: parsed !== null },
    };
  }
  return { supported: false, reason: 'model answered without emitting a tool call' };
}

/** Detect whether the endpoint rejects `developer` role or `reasoning_effort`. */
async function probeCompat(baseUrl, headers, model) {
  const out = { supportsDeveloperRole: true, supportsReasoningEffort: true };
  const dev = await postJson(
    `${baseUrl}/chat/completions`,
    headers,
    {
      model,
      messages: [
        { role: 'developer', content: 'Be terse.' },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 16,
      temperature: 0,
    },
    45000,
  );
  if (!dev.ok) out.supportsDeveloperRole = false;

  const eff = await postJson(
    `${baseUrl}/chat/completions`,
    headers,
    {
      model,
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
      max_tokens: 16,
      temperature: 0,
    },
    45000,
  );
  if (!eff.ok) out.supportsReasoningEffort = false;
  return out;
}

function guessVendor(port, baseUrl) {
  const hit = WELL_KNOWN.find((w) => w.ports.includes(port));
  if (hit) return hit;
  if (/11434/.test(baseUrl)) return WELL_KNOWN[1];
  return null;
}

export function apply(ctx, config = {}) {
  const ports = Array.isArray(config.ports) && config.ports.length > 0 ? config.ports : DEFAULT_PORTS;
  const host = typeof config.host === 'string' && config.host ? config.host : '127.0.0.1';
  const probe = config.probe === true;
  const requestTimeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 5000;

  ctx.effect(() => {
    const disposers = [];

    disposers.push(
      ctx.tools.register({
        name: 'local_llm_scan',
        description:
          'Probe local OpenAI-compatible LLM servers (LM Studio, Ollama, vLLM, llama.cpp, SGLang, LocalAI) ' +
          'on well-known ports. Reports each reachable endpoint, its models, and — when probe is true — the ' +
          'loaded context window, tool-calling support, and wire-compatibility switches needed to register it.',
        parameters: {
          type: 'object',
          properties: {
            ports: {
              type: 'array',
              items: { type: 'integer', minimum: 1, maximum: 65535 },
              description: `Ports to probe. Defaults to ${DEFAULT_PORTS.join(', ')}.`,
            },
            host: {
              type: 'string',
              description: "Host to probe. Defaults to 127.0.0.1.",
            },
            probe: {
              type: 'boolean',
              description:
                'Run capability probes (context length, tool calling, developer role, reasoning_effort). ' +
                'Slower but detects the two common failure modes before config is written. Defaults to false.',
            },
            apiKey: {
              type: 'string',
              description:
                'Bearer token for servers that require one. Most local servers ignore it, but the ' +
                'OpenAI-compatible client still expects an Authorization header.',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              endpoints: { type: 'array', items: { type: 'object' } },
              probed: { type: 'boolean' },
            },
          },
          render: (_args, value) => {
            const eps = Array.isArray(value?.endpoints) ? value.endpoints : [];
            if (eps.length === 0) {
              return [{ type: 'text', text: 'No local LLM server answered on the probed ports.' }];
            }
            const lines = eps.map((e) => {
              const bits = [`- ${e.baseUrl}`, `  models: ${(e.models ?? []).join(', ') || '(none)'}`];
              if (e.vendor) bits.push(`  vendor: ${e.vendor}`);
              if (e.context) {
                bits.push(
                  `  context: loaded=${e.context.loadedContext ?? '?'} max=${e.context.maxContext ?? '?'}`,
                );
              }
              if (e.tools) bits.push(`  tool-calling: ${e.tools.supported ? 'yes' : 'no'}`);
              return bits.join('\n');
            });
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        async execute(args) {
          const usePorts =
            Array.isArray(args?.ports) && args.ports.length > 0 ? args.ports : ports;
          const useHost = typeof args?.host === 'string' && args.host ? args.host : host;
          const doProbe = args?.probe === true || probe;
          const headers = {};
          if (typeof args?.apiKey === 'string' && args.apiKey) {
            headers.authorization = `Bearer ${args.apiKey}`;
          }

          const found = [];
          // Probe every port concurrently; each probe has its own short timeout,
          // so unreachable ports cost one timeout rather than a serial chain.
          const results = await Promise.all(
            usePorts.map(async (port) => {
              const baseUrl = `http://${useHost}:${port}/v1`;
              const desc = await probeEndpoint(baseUrl, headers);
              return desc.reachable ? { port, baseUrl, desc } : null;
            }),
          );

          for (const hit of results) {
            if (!hit) continue;
            const { port, baseUrl, desc } = hit;

            const vendor = guessVendor(port, baseUrl);
            const entry = {
              baseUrl,
              port,
              vendor: vendor?.id ?? null,
              vendorLabel: vendor?.label ?? null,
              models: desc.models,
              chatModel: desc.chatModel,
              embeddingOnly: desc.embeddingOnly,
            };

            if (doProbe && desc.chatModel) {
              // Run the three capability probes concurrently: they are
              // independent, and serially they dominate scan time.
              const [context, tools, compat] = await Promise.all([
                probeContextLength(baseUrl, headers, desc.chatModel),
                probeToolCalling(baseUrl, headers, desc.chatModel),
                probeCompat(baseUrl, headers, desc.chatModel),
              ]);
              entry.context = context;
              entry.tools = tools;
              entry.compat = compat;
              if (entry.context.loadedContext && entry.context.loadedContext < 16384) {
                entry.warnings = [
                  `loaded context is only ${entry.context.loadedContext} tokens; the Harness prompt is ` +
                    'roughly 30k tokens, so requests will be rejected. Raise the server context window first.',
                ];
              }
              if (entry.tools.supported === false) {
                (entry.warnings ??= []).push(
                  'server did not emit a tool call; agent tool loops will not work against it.',
                );
              }
            }
            found.push(entry);
          }

          return { endpoints: found, probed: doProbe };
        },
      }),
    );

    return () => {
      for (const d of disposers.reverse()) {
        try {
          d();
        } catch {
          /* ignore cleanup errors */
        }
      }
    };
  });

  ctx.effect(() => {
    const disposer = ctx.tools.register({
      name: 'local_llm_register',
      description:
        'Register a probed local endpoint as a Harness model provider by editing the llm-pi-ai plugin config. ' +
        'Writes only fields the endpoint actually supports, so a server that rejects the developer role or ' +
        'reasoning_effort does not fail after registration. Takes effect on the next model request.',
      parameters: {
        type: 'object',
        properties: {
          providerId: {
            type: 'string',
            description: 'Route name to create, e.g. "local-lmstudio". Lowercase, hyphenated.',
          },
          baseUrl: {
            type: 'string',
            description: 'OpenAI-compatible base URL including the /v1 suffix.',
          },
          modelId: {
            type: 'string',
            description: 'Model id exactly as the server reports it.',
          },
          displayName: { type: 'string', description: 'Label shown in the model selector.' },
          contextWindow: {
            type: 'integer',
            minimum: 1,
            description:
              'Context window to declare. Use the loaded context from a scan, not the model maximum, ' +
              'because the server rejects requests above what it actually loaded.',
          },
          maxTokens: { type: 'integer', minimum: 1, description: 'Output cap. Defaults to 8192.' },
          apiKey: {
            type: 'string',
            description: 'Bearer token. Local servers ignore the value but the client requires the header.',
          },
          supportsDeveloperRole: { type: 'boolean' },
          supportsReasoningEffort: { type: 'boolean' },
          supportsImages: { type: 'boolean' },
          dryRun: {
            type: 'boolean',
            description: 'Return the config that would be written without applying it.',
          },
        },
        required: ['providerId', 'baseUrl', 'modelId'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            applied: { type: 'boolean' },
            providerId: { type: 'string' },
            config: { type: 'object' },
          },
        },
        render: (_args, value) => {
          const head = value?.applied
            ? `Registered provider "${value.providerId}". It appears in the model selector on the next request.`
            : `Dry run — this config would be written for "${value?.providerId}":`;
          return [
            { type: 'text', text: head },
            { type: 'text', text: '```json\n' + JSON.stringify(value?.config ?? {}, null, 2) + '\n```' },
          ];
        },
      },
      async execute(args) {
        const providerId = String(args.providerId);
        if (!/^[a-z0-9][a-z0-9-]*$/.test(providerId)) {
          throw new Error(
            'providerId must be lowercase alphanumeric with hyphens, e.g. "local-lmstudio"',
          );
        }

        const modelId = String(args.modelId);
        const baseUrl = String(args.baseUrl).replace(/\/+$/, '');
        const maxTokens = Number.isFinite(args.maxTokens) ? args.maxTokens : 8192;
        const contextWindow = Number.isFinite(args.contextWindow) ? args.contextWindow : null;

        const provider = {
          displayName: args.displayName ?? `${providerId} (local)`,
          api: 'openai-completions',
          baseURL: baseUrl,
        };

        // The OpenAI-compatible client requires an Authorization header even when
        // the local server ignores it, so always supply one.
        provider.headers = { Authorization: `Bearer ${args.apiKey ?? 'local'}` };

        if (contextWindow) {
          provider.defaultContextWindow = contextWindow;
          provider.defaultMaxTokens = maxTokens;
        }

        const model = { id: modelId };
        if (contextWindow) {
          model.contextWindow = contextWindow;
          model.maxTokens = maxTokens;
        }
        if (args.supportsImages === true) model.input = ['text', 'image'];
        provider.models = [model];

        // Only declare compat switches that were actually observed to matter.
        const compat = {};
        if (args.supportsDeveloperRole === false) compat.supportsDeveloperRole = false;
        if (args.supportsReasoningEffort === false) compat.supportsReasoningEffort = false;
        if (Object.keys(compat).length > 0) provider.compat = compat;

        const nextProviders = { [providerId]: provider };

        if (args.dryRun === true) {
          return { applied: false, providerId, config: nextProviders };
        }

        const editor = ctx.get('configEditor');
        if (!editor) {
          throw new Error(
            'configEditor service is unavailable, so the provider cannot be persisted. ' +
              'Use dryRun to obtain the config and add it to cordis.patch.yml manually.',
          );
        }

        const entry = editor.entries().find((e) => e.id === 'llm-pi-ai');
        if (!entry) {
          throw new Error(
            'no llm-pi-ai entry in this profile. Mount @deepseek-ai/dsh-llm-pi-ai first, ' +
              'then retry (or use dryRun to copy the config by hand).',
          );
        }

        await editor.edit(entry, (current) => {
          const providers = { ...(current?.providers ?? {}), ...nextProviders };
          return { ...current, providers };
        });

        return { applied: true, providerId, config: nextProviders };
      },
    });
    return disposer;
  });
}

export const inject = ['tools'];

/**
 * Standard-Schema config surface. The Loader calls `~standard.validate` before
 * activation, so this must exist and must never throw: a rejected config here
 * would take the whole entry down at boot.
 */
const CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    ports: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Default ports to probe when a scan omits them.',
    },
    host: { type: 'string', description: 'Default host to probe.' },
    probe: {
      type: 'boolean',
      description: 'Run capability probes by default instead of listing models only.',
    },
    timeoutMs: { type: 'integer', minimum: 100, description: 'Per-request timeout for probes.' },
  },
  additionalProperties: false,
};

export const Config = {
  ...CONFIG_SCHEMA,
  dict: CONFIG_SCHEMA.properties,
  meta: { default: {} },
  toJSON() {
    return CONFIG_SCHEMA;
  },
  '~standard': {
    version: 1,
    vendor: 'dsh-local-llm',
    validate(value) {
      const source = value !== null && typeof value === 'object' ? value : {};
      return { value: source };
    },
  },
};
