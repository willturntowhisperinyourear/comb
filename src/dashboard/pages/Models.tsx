import { useEffect, useState } from 'react';
import { api, ms } from '../api.ts';
import { Badge, Button, Empty, Field, Panel } from '../ui.tsx';

export default function ModelsPage() {
  const [models, setModels] = useState<any[]>([]);
  const [upstreams, setUpstreams] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, any>>({});
  const [tests, setTests] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [add, setAdd] = useState({ upstream_id: '', names: '', tools_mode: '', calibrate: true });

  const load = () => {
    api.get('/models').then(setModels).catch((e) => setNotice({ text: e.message, bad: true }));
    api.get('/upstreams').then(setUpstreams).catch(() => {});
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, []);

  const uncalibrated = models.filter(
    (m) => m.tools_mode === 'emulate' && m.calibration_status !== 'calibrated',
  );

  async function patch(id: string, body: Record<string, unknown>) {
    await api.patch(`/models/${encodeURIComponent(id)}`, body).catch((e) => setNotice({ text: e.message, bad: true }));
    load();
  }

  async function recalibrate(id: string) {
    setBusy(id);
    setOpen(id);
    setNotice(null);
    try {
      const report = await api.post(`/models/${encodeURIComponent(id)}/recalibrate`, {});
      setReports((r) => ({ ...r, [id]: report }));
      load();
    } catch (e: any) {
      setNotice({ text: e.message, bad: true });
    } finally {
      setBusy(null);
    }
  }

  async function calibrateUncalibrated() {
    if (!uncalibrated.length) return;
    setBusy('all');
    setNotice(null);
    try {
      const r = await api.post('/models/calibrate', {});
      setNotice({
        text: `calibrated ${r.calibrated}, failed ${r.failed}, skipped ${r.skipped}`,
        bad: r.calibrated === 0,
      });
      load();
    } catch (e: any) {
      setNotice({ text: e.message, bad: true });
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
      setNotice({ text: e.message, bad: true });
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    await api.del(`/models/${encodeURIComponent(id)}`).catch((e) => setNotice({ text: e.message, bad: true }));
    load();
  }

  async function addModels() {
    const names = add.names
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!add.upstream_id || !names.length) {
      setNotice({ text: 'pick an upstream and at least one model id', bad: true });
      return;
    }
    setBusy('add');
    setNotice(null);
    try {
      const r = await api.post('/models', {
        upstream_id: add.upstream_id,
        names,
        tools_mode: add.tools_mode || undefined,
        calibrate: add.calibrate,
      });
      const parts = [`created ${r.created.length}`];
      if (r.existing?.length) parts.push(`${r.existing.length} already present`);
      if (r.invalid?.length) parts.push(`${r.invalid.length} rejected`);
      if (r.calibrations?.length) parts.push(`calibrated ${r.calibrated}/${r.calibrations.length}`);
      setNotice({ text: parts.join(' · '), bad: r.created.length === 0 && !(r.existing?.length > 0) });
      setAdd((a) => ({ ...a, names: '' }));
      load();
    } catch (e: any) {
      setNotice({ text: e.message, bad: true });
    } finally {
      setBusy(null);
    }
  }

  const calibrationBadge = (m: any) => {
    if (m.tools_mode !== 'emulate') return <span className="tiny muted">—</span>;
    if (m.calibration_status === 'calibrated') {
      return (
        <Badge tone="ok" title={m.calibrated_at ?? ''}>
          calibrated
        </Badge>
      );
    }
    if (m.calibration_status === 'failed') return <Badge tone="bad">failed</Badge>;
    return (
      <Badge tone="warn" title={`fallback variant ${m.tool_variant} until calibration passes`}>
        uncalibrated
      </Badge>
    );
  };

  return (
    <>
      {notice && <div className={`note ${notice.bad ? 'bad' : 'info'}`}>{notice.text}</div>}

      <Panel title="add models">
        <div className="form-grid">
          <Field label="upstream">
            <select value={add.upstream_id} onChange={(e) => setAdd({ ...add, upstream_id: e.target.value })}>
              <option value="">pick an upstream…</option>
              {upstreams.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.models.length})
                </option>
              ))}
            </select>
          </Field>
          <Field label="tool mode" hint="empty = connector or preset default">
            <select value={add.tools_mode} onChange={(e) => setAdd({ ...add, tools_mode: e.target.value })}>
              <option value="">inherit</option>
              <option value="emulate">emulate</option>
              <option value="native">native</option>
              <option value="off">off</option>
            </select>
          </Field>
          <Field label="auto-calibrate new models">
            <select
              value={add.calibrate ? 'yes' : 'no'}
              onChange={(e) => setAdd({ ...add, calibrate: e.target.value === 'yes' })}
            >
              <option value="yes">yes</option>
              <option value="no">no</option>
            </select>
          </Field>
        </div>
        <div style={{ marginTop: 10 }}>
          <Field label="model ids" hint="one per line or comma separated; newer ids work even when the connector never listed them">
            <textarea
              value={add.names}
              onChange={(e) => setAdd({ ...add, names: e.target.value })}
              placeholder={'gemini-3-pro\nqwen3.6-max'}
              style={{ minHeight: 70 }}
            />
          </Field>
        </div>
        <div className="inline" style={{ marginTop: 10 }}>
          <Button variant="primary" onClick={addModels} disabled={busy === 'add'}>
            {busy === 'add' ? 'adding…' : 'add models'}
          </Button>
        </div>
      </Panel>

      <div className="note info">
        Tool mode is per model. <b>native</b> forwards the <code>tools</code> array upstream. <b>emulate</b> injects a
        text protocol and converts the reply back into OpenAI tool calls. An emulated model stays{' '}
        <b>uncalibrated</b> until a probe produced a valid call; its variant is only a fallback until then.
      </div>

      <Panel
        title="models"
        actions={
          <>
            <span className="tiny muted">{models.length} routed · {uncalibrated.length} need calibration</span>
            <Button variant="primary" onClick={calibrateUncalibrated} disabled={busy === 'all' || !uncalibrated.length}>
              {busy === 'all' ? 'calibrating…' : 'calibrate uncalibrated'}
            </Button>
          </>
        }
      >
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>model</th>
                <th>upstream</th>
                <th>tools</th>
                <th>variant</th>
                <th>calibration</th>
                <th>enabled</th>
                <th style={{ width: 280 }}>actions</th>
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
                                ? `stored: ${reports[m.id].winner.mode}${
                                    reports[m.id].winner.variant ? ':' + reports[m.id].winner.variant : ''
                                  } (${reports[m.id].status ?? 'native'})`
                                : 'no variant produced a valid tool call; model marked failed'}
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
                          upstream model: <code>{m.upstream_model}</code> · context {m.context_window} ·{' '}
                          {m.calibrated_at ? `calibrated ${m.calibrated_at.slice(0, 16).replace('T', ' ')}` : 'never calibrated'}
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
                      title={m.calibration_status === 'calibrated' ? 'verified variant' : 'fallback until calibrated'}
                      onChange={(e) => patch(m.id, { tool_variant: e.target.value })}
                    >
                      <option value="xml">xml</option>
                      <option value="fence">fence</option>
                      <option value="json">json</option>
                    </select>
                  </td>
                  <td>{calibrationBadge(m)}</td>
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
                      <Button variant="danger" onClick={() => remove(m.id)}>
                        delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!models.length && <Empty>No models. Add an upstream, then discover or type the ids above.</Empty>}
        </div>
      </Panel>
    </>
  );
}
