window.__ModuleLoader__.load({
  id: 'dsh-local-llm',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useCallback, useEffect, useMemo } = React;

    // --- styles -------------------------------------------------------------
    // Theme tokens only: a renamed token degrades appearance but never breaks
    // rendering, and light/dark follow the host automatically.
    const S = {
      page: { padding: '4px 0 24px', display: 'flex', flexDirection: 'column', gap: 16 },
      hint: { fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-text-secondary)', margin: 0 },
      row: { display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' },
      field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 120 },
      label: { fontSize: 12, color: 'var(--dsw-alias-text-secondary)' },
      input: {
        padding: '6px 8px',
        fontSize: 13,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-default)',
        background: 'var(--dsw-alias-bg-default)',
        color: 'var(--dsw-alias-text-primary)',
        outline: 'none',
      },
      button: {
        padding: '7px 14px',
        fontSize: 13,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-default)',
        background: 'var(--dsw-alias-bg-default)',
        color: 'var(--dsw-alias-text-primary)',
        cursor: 'pointer',
      },
      primary: {
        padding: '7px 14px',
        fontSize: 13,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-accent-default)',
        background: 'var(--dsw-alias-accent-default)',
        color: 'var(--dsw-alias-text-on-accent)',
        cursor: 'pointer',
      },
      buttonDisabled: { opacity: 0.5, cursor: 'default' },
      card: {
        border: '1px solid var(--dsw-alias-border-default)',
        borderRadius: 8,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: 'var(--dsw-alias-bg-elevated)',
      },
      cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
      url: { fontFamily: 'var(--dsw-alias-font-mono, monospace)', fontSize: 13, fontWeight: 600 },
      badge: {
        fontSize: 11,
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-default)',
        color: 'var(--dsw-alias-text-secondary)',
      },
      kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 12 },
      kvKey: { color: 'var(--dsw-alias-text-secondary)' },
      warn: {
        fontSize: 12,
        lineHeight: 1.5,
        padding: '8px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-warning-border, var(--dsw-alias-border-default))',
        background: 'var(--dsw-alias-warning-bg, transparent)',
        color: 'var(--dsw-alias-text-primary)',
      },
      error: {
        fontSize: 12,
        padding: '8px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-danger-border, var(--dsw-alias-border-default))',
        color: 'var(--dsw-alias-text-primary)',
      },
      ok: { fontSize: 12, color: 'var(--dsw-alias-success-text, var(--dsw-alias-text-secondary))' },
      empty: { fontSize: 13, color: 'var(--dsw-alias-text-secondary)', padding: '12px 0' },
      select: {
        padding: '6px 8px',
        fontSize: 13,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-default)',
        background: 'var(--dsw-alias-bg-default)',
        color: 'var(--dsw-alias-text-primary)',
        minWidth: 200,
      },
    };

    async function postJson(url, body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    }

    function Field({ label, children }) {
      return h('label', { style: S.field }, h('span', { style: S.label }, label), children);
    }

    function EndpointCard({ ep, onRegistered }) {
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState(null);
      const [err, setErr] = useState(null);
      const [modelId, setModelId] = useState(ep.chatModel || (ep.models && ep.models[0]) || '');

      const suggested = useMemo(() => {
        const vendor = ep.vendor || 'local';
        return `${vendor}-${String(ep.port)}`;
      }, [ep.vendor, ep.port]);

      const ctxWindow = ep.context && ep.context.loadedContext ? ep.context.loadedContext : null;

      const register = useCallback(async () => {
        setBusy(true);
        setErr(null);
        setMsg(null);
        try {
          const out = await postJson('/local-llm/register', {
            providerId: suggested,
            baseUrl: ep.baseUrl,
            modelId,
            displayName: `${ep.vendorLabel || suggested} · ${modelId}`,
            contextWindow: ctxWindow || undefined,
            supportsDeveloperRole: ep.compat ? ep.compat.supportsDeveloperRole : undefined,
            supportsReasoningEffort: ep.compat ? ep.compat.supportsReasoningEffort : undefined,
          });
          setMsg(`已注册为 "${out.providerId}"，下一条消息即可在模型选择器中看到。`);
          onRegistered && onRegistered(out);
        } catch (e) {
          setErr(e.message);
        } finally {
          setBusy(false);
        }
      }, [suggested, ep, modelId, ctxWindow, onRegistered]);

      const ctxLabel = ep.context
        ? `loaded ${ep.context.loadedContext ?? '?'} / max ${ep.context.maxContext ?? '?'}`
        : '未探测';

      return h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.cardHead },
          h('span', { style: S.url }, ep.baseUrl),
          ep.vendorLabel ? h('span', { style: S.badge }, ep.vendorLabel) : null,
        ),
        h(
          'div',
          { style: S.kv },
          h('span', { style: S.kvKey }, '上下文'),
          h('span', null, ctxLabel),
          h('span', { style: S.kvKey }, '工具调用'),
          h(
            'span',
            null,
            ep.tools ? (ep.tools.supported ? '支持' : '不支持') : '未探测',
          ),
          h('span', { style: S.kvKey }, '模型'),
          h('span', null, (ep.models || []).join(', ') || '(none)'),
        ),
        (ep.warnings || []).map((w, i) => h('div', { key: i, style: S.warn }, w)),
        h(
          'div',
          { style: S.row },
          h(
            Field,
            { label: '要注册的模型' },
            h(
              'select',
              {
                style: S.select,
                value: modelId,
                onChange: (e) => setModelId(e.target.value),
              },
              (ep.models || []).map((m) => h('option', { key: m, value: m }, m)),
            ),
          ),
          h(
            'button',
            {
              style: busy ? { ...S.primary, ...S.buttonDisabled } : S.primary,
              disabled: busy || !modelId,
              onClick: register,
            },
            busy ? '注册中…' : '注册为提供商',
          ),
        ),
        err ? h('div', { style: S.error }, err) : null,
        msg ? h('div', { style: S.ok }, msg) : null,
      );
    }

    function LocalLlmPanel() {
      const [host, setHost] = useState('127.0.0.1');
      const [ports, setPorts] = useState('1234, 11434, 8000, 8080');
      const [probe, setProbe] = useState(true);
      const [busy, setBusy] = useState(false);
      const [result, setResult] = useState(null);
      const [err, setErr] = useState(null);

      const scan = useCallback(async () => {
        setBusy(true);
        setErr(null);
        setResult(null);
        try {
          const parsed = ports
            .split(/[,\s]+/)
            .map((s) => parseInt(s, 10))
            .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
          const out = await postJson('/local-llm/scan', {
            host: host.trim() || '127.0.0.1',
            ports: parsed.length > 0 ? parsed : undefined,
            probe,
          });
          setResult(out);
        } catch (e) {
          setErr(e.message);
        } finally {
          setBusy(false);
        }
      }, [host, ports, probe]);

      const endpoints = result && Array.isArray(result.endpoints) ? result.endpoints : [];

      return h(
        'div',
        { style: S.page },
        h(
          'p',
          { style: S.hint },
          '扫描本机的 OpenAI 兼容模型服务（LM Studio、Ollama、vLLM、llama.cpp 等），' +
            '探测其实际加载的上下文长度与工具调用能力，然后一键注册为 Harness 提供商。',
        ),
        h(
          'div',
          { style: S.row },
          h(Field, { label: '主机' }, h('input', {
            style: { ...S.input, width: 150 },
            value: host,
            onChange: (e) => setHost(e.target.value),
          })),
          h(Field, { label: '端口（逗号分隔）' }, h('input', {
            style: { ...S.input, width: 260 },
            value: ports,
            onChange: (e) => setPorts(e.target.value),
          })),
          h(
            'label',
            { style: { ...S.row, alignItems: 'center', gap: 6, paddingBottom: 6 } },
            h('input', {
              type: 'checkbox',
              checked: probe,
              onChange: (e) => setProbe(e.target.checked),
            }),
            h('span', { style: S.label }, '深度探测（较慢）'),
          ),
          h(
            'button',
            {
              style: busy ? { ...S.primary, ...S.buttonDisabled } : S.primary,
              disabled: busy,
              onClick: scan,
            },
            busy ? '扫描中…' : '扫描',
          ),
        ),
        err ? h('div', { style: S.error }, err) : null,
        busy
          ? h('div', { style: S.empty }, '正在探测，深度探测通常需要 10–30 秒…')
          : null,
        result && endpoints.length === 0
          ? h('div', { style: S.empty }, '在探测的端口上没有发现可用的模型服务。')
          : null,
        endpoints.map((ep, i) => h(EndpointCard, { key: ep.baseUrl + i, ep })),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const label = () => '本地模型';

        // ctx.slots.inject already owns the effect lifetime: it disposes the
        // registration when the slot declaration collapses and reinstalls it
        // when the declaration returns. Wrapping it in ctx.effect adds a
        // second owner for the same registration, and ctx.effect takes only one
        // argument, so the label string would be ignored anyway.
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'local-llm', order: 12, label },
            LocalLlmPanel,
          ),
        );
      },
    };
  },
});
