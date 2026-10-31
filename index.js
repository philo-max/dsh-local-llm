/**
 * Host half of the local-LLM bundle.
 *
 * Registers the two agent tools, plus a small HTTP surface the settings panel
 * calls. The HTTP routes exist because the Client module cannot reach Host
 * services directly; a same-origin fetch to a registered route is the supported
 * bridge, and it keeps the panel working without a generated Remote namespace.
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

async function probeEndpoint(baseUrl, headers) {
  const models = await getJson(`${baseUrl}/models`, headers, 5000);
  if (!models.ok) {
    return { reachable: false, reason: models.error ?? `HTTP ${models.status}` };
  }
  const list = Array.isArray(models.body?.data) ? models.body.data : [];
  if (list.length === 0) return { reachable: false, reason: 'no models exposed' };
  const ids = list.map((m) => m.id).filter((v) => typeof v === 'string');
  const chatCandidate = ids.find((id) => !/embed|rerank/i.test(id)) ?? null;
  return {
    reachable: true,
    baseUrl,
    models: ids,
    chatModel: chatCandidate,
    embeddingOnly: chatCandidate === null,
  };
}

async function probeContextLength(baseUrl, headers, model) {
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
    return { supported: true, sampleCall: { name: fn.name, argumentsValid: parsed !== null } };
  }
  return { supported: false, reason: 'model answered without emitting a tool call' };
}

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

function guessVendor(port) {
  return WELL_KNOWN.find((w) => w.ports.includes(port)) ?? null;
}

/** Shared by the tool and the HTTP route so both report identical results. */
async function runScan({ ports, host, probe, apiKey }) {
  const headers = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const results = await Promise.all(
    ports.map(async (port) => {
      const baseUrl = `http://${host}:${port}/v1`;
      const desc = await probeEndpoint(baseUrl, headers);
      return desc.reachable ? { port, baseUrl, desc } : null;
    }),
  );

  const found = [];
  for (const hit of results) {
    if (!hit) continue;
    const { port, baseUrl, desc } = hit;
    const vendor = guessVendor(port);
    const entry = {
      baseUrl,
      port,
      vendor: vendor?.id ?? null,
      vendorLabel: vendor?.label ?? null,
      models: desc.models,
      chatModel: desc.chatModel,
      embeddingOnly: desc.embeddingOnly,
    };

    if (probe && desc.chatModel) {
      const [context, tools, compat] = await Promise.all([
        probeContextLength(baseUrl, headers, desc.chatModel),
        probeToolCalling(baseUrl, headers, desc.chatModel),
        probeCompat(baseUrl, headers, desc.chatModel),
      ]);
      entry.context = context;
      entry.tools = tools;
      entry.compat = compat;
      if (context.loadedContext && context.loadedContext < 16384) {
        entry.warnings = [
          `loaded context is only ${context.loadedContext} tokens; the Harness prompt is roughly 30k tokens, ` +
            'so requests will be rejected. Raise the server context window first.',
        ];
      }
      if (tools.supported === false) {
        (entry.warnings ??= []).push('server did not emit a tool call; agent tool loops will not work.');
      }
    }
    found.push(entry);
  }
  return { endpoints: found, probed: probe };
}

// --- progress anchor ------------------------------------------------------
//
// Compaction rewrites older history into a summary, and a small model's summary
// reliably loses "what I was doing next". A better summary helps, but the
// durable fix is a smaller surface: keep the plan on disk and re-inject it each
// step, so the model re-reads its own intent instead of recalling it. This
// mirrors the file-planning pattern (task_plan.md / progress.md) that agents
// already use, and costs one small context block per request.
//
// Opt-in through Config.anchor.enabled: a deployment that never writes those
// files should not pay for the read.

const ANCHOR_FILES = ['task_plan.md', 'progress.md', 'findings.md'];

async function readAnchorFiles(cwd, maxBytesPerFile, maxAgeDays) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const out = [];
  const now = Date.now();
  for (const name of ANCHOR_FILES) {
    try {
      const full = path.join(cwd, name);
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      // A stale plan is worse than none: it states a finished task as current
      // and sends the model back to work that is already done.
      if (maxAgeDays > 0 && now - stat.mtimeMs > maxAgeDays * 86400000) continue;
      const raw = await fs.readFile(full, 'utf8');
      const text = raw.length > maxBytesPerFile ? raw.slice(-maxBytesPerFile) : raw;
      out.push({
        name,
        text: text.trim(),
        truncated: raw.length > maxBytesPerFile,
        ageDays: Math.floor((now - stat.mtimeMs) / 86400000),
      });
    } catch {
      /* absent or unreadable: skip */
    }
  }
  return out;
}

function formatAnchor(files, cwd) {
  if (files.length === 0) return '';
  const body = files
    .map((f) => {
      const note = f.truncated ? ' (tail, truncated)' : '';
      return `### ${f.name}${note}\n${f.text}`;
    })
    .join('\n\n');
  return [
    `Working notes from ${cwd}. Treat these as the authoritative statement of`,
    'what this task is and where it stands: continue from the "next" items',
    'rather than restarting work already marked done.',
    '',
    body,
  ].join('\n');
}

export function apply(ctx, config = {}) {
  const anchorCfg = config.anchor && typeof config.anchor === 'object' ? config.anchor : {};
  const anchorEnabled = anchorCfg.enabled === true;
  const anchorMaxBytes = Number.isFinite(anchorCfg.maxBytesPerFile) ? anchorCfg.maxBytesPerFile : 4000;
  const anchorOrder = Number.isFinite(anchorCfg.order) ? anchorCfg.order : 60;
  const anchorMaxAgeDays = Number.isFinite(anchorCfg.maxAgeDays) ? anchorCfg.maxAgeDays : 7;
  const defaultPorts =
    Array.isArray(config.ports) && config.ports.length > 0 ? config.ports : DEFAULT_PORTS;
  const defaultHost = typeof config.host === 'string' && config.host ? config.host : '127.0.0.1';
  const defaultProbe = config.probe === true;

  // Progress anchor: re-inject the on-disk plan before each step so a compacted
  // conversation still knows what it was doing.
  if (anchorEnabled) {
    ctx.effect(() => {
      const prompt = ctx.get('systemPrompt');
      const wd = ctx.get('workingDirectory');
      if (!prompt || !wd) return () => {};

      return prompt.context({
        name: 'local-llm/anchor',
        order: anchorOrder,
        async text(assemble) {
          const agent = assemble && assemble.agent;
          if (!agent) return '';
          try {
            const cwd = await wd.ensure(agent);
            const files = await readAnchorFiles(cwd, anchorMaxBytes, anchorMaxAgeDays);
            return formatAnchor(files, cwd);
          } catch {
            return '';
          }
        },
      });
    });
  }

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
            host: { type: 'string', description: 'Host to probe. Defaults to 127.0.0.1.' },
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
                bits.push(`  context: loaded=${e.context.loadedContext ?? '?'} max=${e.context.maxContext ?? '?'}`);
              }
              if (e.tools) bits.push(`  tool-calling: ${e.tools.supported ? 'yes' : 'no'}`);
              return bits.join('\n');
            });
            return [{ type: 'text', text: lines.join('\n') }];
          },
        },
        async execute(args) {
          return runScan({
            ports: Array.isArray(args?.ports) && args.ports.length > 0 ? args.ports : defaultPorts,
            host: typeof args?.host === 'string' && args.host ? args.host : defaultHost,
            probe: args?.probe === true || defaultProbe,
            apiKey: typeof args?.apiKey === 'string' ? args.apiKey : undefined,
          });
        },
      }),
    );

    disposers.push(
      ctx.tools.register({
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
            baseUrl: { type: 'string', description: 'OpenAI-compatible base URL including the /v1 suffix.' },
            modelId: { type: 'string', description: 'Model id exactly as the server reports it.' },
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
            dryRun: { type: 'boolean', description: 'Return the config that would be written without applying it.' },
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
          return applyRegistration(ctx, args);
        },
      }),
    );

    // --- HTTP surface for the settings panel -------------------------------
    const web = ctx.get('webServer');
    if (web) {
      const json = (res, status, body) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(body));
      };

      const readBody = (req) =>
        new Promise((resolve) => {
          let raw = '';
          req.on('data', (c) => {
            raw += c;
            if (raw.length > 1e6) req.destroy();
          });
          req.on('end', () => {
            try {
              resolve(raw ? JSON.parse(raw) : {});
            } catch {
              resolve({});
            }
          });
          req.on('error', () => resolve({}));
        });

      disposers.push(
        web.register({
          kind: 'exact',
          path: '/local-llm/scan',
          async handler(req, res) {
            const body = await readBody(req);
            try {
              const result = await runScan({
                ports: Array.isArray(body.ports) && body.ports.length > 0 ? body.ports : defaultPorts,
                host: typeof body.host === 'string' && body.host ? body.host : defaultHost,
                probe: body.probe !== false,
                apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
              });
              json(res, 200, result);
            } catch (err) {
              json(res, 500, { error: err instanceof Error ? err.message : String(err) });
            }
          },
        }),
      );

      disposers.push(
        web.register({
          kind: 'exact',
          path: '/local-llm/register',
          async handler(req, res) {
            const body = await readBody(req);
            try {
              const result = await applyRegistration(ctx, body);
              json(res, 200, result);
            } catch (err) {
              json(res, 400, { error: err instanceof Error ? err.message : String(err) });
            }
          },
        }),
      );
    }

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
}

/** Build the provider entry and persist it through configEditor. */
async function applyRegistration(ctx, args) {
  const providerId = String(args.providerId ?? '');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(providerId)) {
    throw new Error('providerId must be lowercase alphanumeric with hyphens, e.g. "local-lmstudio"');
  }

  const modelId = String(args.modelId ?? '');
  const baseUrl = String(args.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('baseUrl is required');
  if (!modelId) throw new Error('modelId is required');

  const maxTokens = Number.isFinite(args.maxTokens) ? args.maxTokens : 8192;
  const contextWindow = Number.isFinite(args.contextWindow) ? args.contextWindow : null;

  const provider = {
    displayName: args.displayName ?? `${providerId} (local)`,
    api: 'openai-completions',
    baseURL: baseUrl,
    headers: { Authorization: `Bearer ${args.apiKey ?? 'local'}` },
  };

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
}

export const inject = ['tools'];

/**
 * The Config surface the Loader and Settings read.
 *
 * The Host projects this as JSON Schema: `listConfigs` returns it verbatim
 * alongside `status: "schema"`. A schemastery-style `dict`/`refs` node set
 * reads as `status: "unsupported"` instead, and the row's config stops being
 * editable — so this stays plain JSON Schema.
 *
 * `~standard.validate` must exist and must never throw: a rejected config here
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
    probe: { type: 'boolean', description: 'Run capability probes by default instead of listing models only.' },
    timeoutMs: { type: 'integer', minimum: 100, description: 'Per-request timeout for probes.' },
    anchor: {
      type: 'object',
      description:
        'Re-inject the workspace plan files (task_plan.md, progress.md, findings.md) into the prompt ' +
        'before every step, so a compacted conversation still knows what it was doing.',
      properties: {
        enabled: { type: 'boolean', description: 'Turn the progress anchor on.' },
        maxBytesPerFile: {
          type: 'integer',
          minimum: 200,
          description: 'Keep only the tail of a file longer than this. Defaults to 4000.',
        },
        order: { type: 'integer', description: 'Prompt context ordering. Defaults to 60.' },
        maxAgeDays: {
          type: 'integer',
          minimum: 0,
          description:
            'Skip files older than this many days, so a finished task is not presented as current. ' +
            'Defaults to 7; 0 disables the check.',
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export const Config = {
  ...CONFIG_SCHEMA,
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
