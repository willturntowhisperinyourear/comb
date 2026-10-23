import { useEffect, useState } from 'react';
import { api, ms } from '../api.ts';
import { Badge, Button, Field, Panel } from '../ui.tsx';

const sampleTool = JSON.stringify(
  [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from the workspace',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'relative path' } },
          required: ['path'],
        },
      },
    },
  ],
  null,
  2,
);

export default function PlaygroundPage() {
  const [targets, setTargets] = useState<string[]>([]);
  const [model, setModel] = useState('auto');
  const [system, setSystem] = useState('');
  const [prompt, setPrompt] = useState('Read src/main.ts and tell me what it does.');
  const [useTools, setUseTools] = useState(false);
  const [tools, setTools] = useState(sampleTool);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    Promise.all([api.get('/models'), api.get('/chains')])
      .then(([models, chains]) => {
        setTargets(['auto', ...chains.map((c: any) => c.name), ...models.map((m: any) => m.id)]);
      })
      .catch(() => {});
  }, []);

  async function send() {
    setBusy(true);
    setError('');
    setResult(null);
    const started = Date.now();
    try {
      let parsedTools;
      if (useTools) {
        parsedTools = JSON.parse(tools);
        if (!Array.isArray(parsedTools)) throw new Error('tools must be a JSON array');
      }
      const messages = [
        ...(system.trim() ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ];
      const out = await api.post('/playground', { model, messages, tools: parsedTools, tool_choice: useTools ? 'auto' : undefined });
      setResult(out);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setElapsed(Date.now() - started);
      setBusy(false);
    }
  }

  const choice = result?.choices?.[0];
  const message = choice?.message;

  return (
    <div className="grid-side">
      <Panel title="request">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label="model or chain">
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {targets.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="system" hint="merged into the first system turn for emulated upstreams">
            <textarea value={system} onChange={(e) => setSystem(e.target.value)} style={{ minHeight: 60 }} placeholder="optional" />
          </Field>
          <Field label="user">
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </Field>
          <label className="checkline">
            <input type="checkbox" checked={useTools} onChange={(e) => setUseTools(e.target.checked)} /> send tool definitions
          </label>
          {useTools && (
            <Field label="tools json" hint="OpenAI format; emulated when the upstream has no native tools">
              <textarea value={tools} onChange={(e) => setTools(e.target.value)} style={{ minHeight: 160, fontSize: 11 }} />
            </Field>
          )}
          <div className="inline">
            <Button variant="primary" onClick={send} disabled={busy}>
              {busy ? 'routing…' : 'send'}
            </Button>
            {error && <span className="tiny" style={{ color: 'var(--bad)' }}>{error}</span>}
          </div>
        </div>
      </Panel>

      <Panel
        title="response"
        actions={
          result?.comb ? (
            <span className="tiny muted">
              {result.comb.upstream} · {result.comb.attempts} attempt(s) · {ms(result.comb.latency_ms)}
            </span>
          ) : elapsed ? (
            <span className="tiny muted">{ms(elapsed)}</span>
          ) : null
        }
      >
        {result ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="inline">
              <Badge tone="ok">{result.model}</Badge>
              <Badge tone={result.comb?.emulated_tools ? 'blue' : 'idle'}>
                {result.comb?.emulated_tools ? 'emulated tools' : 'native path'}
              </Badge>
              <Badge tone={choice?.finish_reason === 'tool_calls' ? 'warn' : 'ok'}>
                {choice?.finish_reason ?? 'stop'}
              </Badge>
              {result.comb?.routed_model && <span className="tiny muted">→ {result.comb.routed_model}</span>}
            </div>
            <div className={`msg assistant`}>{message?.content || '(no text)'}</div>
            {!!message?.tool_calls?.length && (
              <div>
                <div className="tiny muted" style={{ marginBottom: 4 }}>
                  tool_calls
                </div>
                {message.tool_calls.map((tc: any, i: number) => (
                  <pre key={i}>{`${tc.function.name}(${tc.function.arguments})`}</pre>
                ))}
              </div>
            )}
            <details>
              <summary className="tiny muted" style={{ cursor: 'pointer' }}>
                raw json
              </summary>
              <pre>{JSON.stringify(result, null, 2)}</pre>
            </details>
          </div>
        ) : (
          <div className="empty">Send a request. The response shows the routed model, how tools were handled, and the raw JSON.</div>
        )}
      </Panel>
    </div>
  );
}
