import { useEffect, useState } from 'react';
import { api, ms } from '../api.ts';
import { Badge, Button, Empty, Panel } from '../ui.tsx';

export default function ModelsPage() {
  const [models, setModels] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, any>>({});
  const [tests, setTests] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = () => api.get('/models').then(setModels).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, []);

  async function patch(id: string, body: Record<string, unknown>) {
    await api.patch(`/models/${encodeURIComponent(id)}`, body).catch((e) => setError(e.message));
    load();
  }

  async function recalibrate(id: string) {
    setBusy(id);
    setOpen(id);
    setError('');
    try {
      const report = await api.post(`/models/${encodeURIComponent(id)}/recalibrate`, {});
      setReports((r) => ({ ...r, [id]: report }));
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function test(id: string) {
    setBusy(id);
    try {
      const r = await api.post(`/models/${encodeURIComponent(id)}/test`, { prompt: 'Reply with the word ready.' });
      setTests((t) => ({ ...t, [id]: r }));
      setOpen(id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error && <div className="note bad">{error}</div>}
      <div className="note info">
        Tool mode is per model. <b>native</b> forwards the <code>tools</code> array upstream. <b>emulate</b> injects a
        text protocol and converts the reply back into OpenAI tool calls, using the variant that calibration proved
        this model understands. Recalibrate after installing or updating a connector.
      </div>

      <Panel title="models" actions={<span className="tiny muted">{models.length} routed</span>}>
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>model</th>
                <th>upstream</th>
                <th>tools</th>
                <th>variant</th>
                <th>enabled</th>
                <th style={{ width: 260 }}>actions</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div className="mono-cell">{m.id}</div>
                    {open === m.id && (
                      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {reports[m.id] && (
                          <div>
                            <div className="tiny muted" style={{ marginBottom: 4 }}>
                              calibration trials
                            </div>
                            <table>
                              <thead>
                                <tr>
                                  <th>mode</th>
                                  <th>variant</th>
                                  <th>result</th>
                                  <th className="num">ms</th>
                                  <th>detail</th>
                                </tr>
                              </thead>
                              <tbody>
                                {reports[m.id].trials.map((t: any, i: number) => (
                                  <tr key={i}>
                                    <td>{t.mode}</td>
                                    <td>{t.variant ?? '—'}</td>
                                    <td>{t.ok ? <Badge tone="ok">pass</Badge> : <Badge tone="bad">fail</Badge>}</td>
                                    <td className="num">{t.ms}</td>
                                    <td className="tiny muted">{t.note}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            <div className="tiny" style={{ marginTop: 6 }}>
                              {reports[m.id].winner
                                ? `stored: ${reports[m.id].winner.mode}${reports[m.id].winner.variant ? ':' + reports[m.id].winner.variant : ''}`
                                : 'no variant produced a valid tool call; model left as is'}
                            </div>
                          </div>
                        )}
                        {tests[m.id] && (
                          <div className="msg">
                            {tests[m.id].ok ? (
                              <>
                                {tests[m.id].reply || '(empty reply)'}
                                <div className="tiny muted" style={{ marginTop: 6 }}>
                                  {ms(tests[m.id].ms)} · {tests[m.id].tool_calls?.length ?? 0} tool call(s)
                                </div>
                              </>
                            ) : (
                              <span style={{ color: 'var(--bad)' }}>{tests[m.id].error}</span>
                            )}
                          </div>
                        )}
                        <div className="tiny muted">
                          upstream model: <code>{m.upstream_model}</code> · context {m.context_window}
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="tiny muted">
                    {m.upstream}
                    <div>
                      <Badge tone={m.upstream_status === 'active' ? 'ok' : 'idle'}>{m.upstream_status}</Badge>
                    </div>
                  </td>
                  <td>
                    <select value={m.tools_mode} onChange={(e) => patch(m.id, { tools_mode: e.target.value })}>
                      <option value="emulate">emulate</option>
                      <option value="native">native</option>
                      <option value="off">off</option>
                    </select>
                  </td>
                  <td>
                    <select
                      value={m.tool_variant}
                      disabled={m.tools_mode !== 'emulate'}
                      onChange={(e) => patch(m.id, { tool_variant: e.target.value })}
                    >
                      <option value="xml">xml</option>
                      <option value="fence">fence</option>
                      <option value="json">json</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={!!m.enabled}
                      onChange={(e) => patch(m.id, { enabled: e.target.checked })}
                    />
                  </td>
                  <td>
                    <div className="inline">
                      <Button variant="primary" onClick={() => recalibrate(m.id)} disabled={busy === m.id}>
                        {busy === m.id ? 'probing…' : 'recalibrate'}
                      </Button>
                      <Button onClick={() => test(m.id)} disabled={busy === m.id}>
                        test
                      </Button>
                      <Button variant="ghost" onClick={() => setOpen(open === m.id ? null : m.id)}>
                        {open === m.id ? 'close' : 'detail'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!models.length && <Empty>No models. Add an upstream and discover its models.</Empty>}
        </div>
      </Panel>
    </>
  );
}
