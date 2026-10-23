import { useEffect, useState } from 'react';
import { api, ms, pct } from '../api.ts';
import { Badge, CopyLine, Empty, Panel, Stat } from '../ui.tsx';
import type { PageId } from '../App.tsx';

export default function OverviewPage({ go }: { go: (p: PageId) => void }) {
  const [data, setData] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [key, setKey] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.get('/overview').then((d) => alive && setData(d)).catch(() => {});
      api.get('/setup/status').then((d) => alive && setStatus(d)).catch(() => {});
      api.get('/bootstrap-key').then((d) => alive && setKey(d.key)).catch(() => {});
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const base = `${location.origin}/v1`;
  const totals = data?.totals ?? { requests: 0, ok: 0, avg_latency: 0, tokens: 0 };
  const counts = data?.counts ?? {};
  const models: any[] = data?.models ?? [];
  const hourly: any[] = data?.hourly ?? [];
  const peak = Math.max(1, ...hourly.map((h) => Number(h.n)));

  return (
    <>
      {status && !status.has_upstream && (
        <div className="note">
          No upstream yet. <a href="#setup" onClick={() => go('setup')}>Open setup</a> to install a connector repo, create an
          upstream from a preset, then calibrate its tool calling.
        </div>
      )}

      <div className="stats">
        <Stat label="requests 24h" value={totals.requests} hint={`${totals.ok} ok`} />
        <Stat
          label="success rate"
          value={`${pct(totals.ok, totals.requests)}%`}
          tone={totals.requests && pct(totals.ok, totals.requests) < 90 ? 'warn' : 'ok'}
        />
        <Stat label="avg latency" value={ms(totals.avg_latency)} hint="routed calls" />
        <Stat label="tokens" value={totals.tokens.toLocaleString()} hint="in + out, 24h" />
        <Stat
          label="emulated tools"
          value={counts.emulated ?? 0}
          hint={`of ${counts.models ?? 0} models`}
          tone={counts.emulated ? 'ok' : undefined}
        />
        <Stat label="connectors" value={counts.running_plugins ?? 0} hint={`${counts.upstreams ?? 0} upstreams`} />
      </div>

      <div className="grid-side">
        <Panel
          title="models"
          actions={<a href="#models" onClick={() => go('models')} className="tiny">manage</a>}
          className="panel"
        >
          <div className="tbl-scroll">
            <table>
              <thead>
                <tr>
                  <th>model</th>
                  <th>upstream</th>
                  <th>tools</th>
                  <th className="num">req</th>
                  <th className="num">ok</th>
                  <th className="num">p50</th>
                  <th>state</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => {
                  const cooling = m.cooldown_until && m.cooldown_until > Date.now();
                  return (
                    <tr key={m.id}>
                      <td className="mono-cell">{m.id}</td>
                      <td className="muted tiny">{m.upstream}</td>
                      <td>
                        <Badge tone={m.tools_mode === 'native' ? 'blue' : m.tools_mode === 'emulate' ? 'ok' : 'idle'}>
                          {m.tools_mode === 'emulate' ? `emu:${m.tool_variant}` : m.tools_mode}
                        </Badge>
                      </td>
                      <td className="num">{m.requests}</td>
                      <td className="num">{pct(Number(m.ok ?? 0), Number(m.requests ?? 0))}%</td>
                      <td className="num">{Number(m.latency) ? ms(Number(m.latency)) : '—'}</td>
                      <td>{cooling ? <Badge tone="warn">cooling</Badge> : <Badge tone="ok">ready</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!models.length && <Empty>No models yet. Install a connector or point an upstream at any OpenAI-compatible API.</Empty>}
          </div>
        </Panel>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Panel title="quick start">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <CopyLine label="base url" value={base} />
              <CopyLine label="api key" value={key || 'loading'} />
              <pre className="tiny">{`curl ${base}/chat/completions \\
  -H "authorization: Bearer ${key || '<key>'}" \\
  -H "content-type: application/json" \\
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'`}</pre>
              <div className="tiny muted">
                Point any OpenAI SDK at this base URL. Model can be a chain name, a model id, or <code>auto</code>.
              </div>
            </div>
          </Panel>

          <Panel title="traffic 24h">
            {hourly.length ? (
              <div className="bars">
                {hourly.map((h) => (
                  <i
                    key={h.hour}
                    className={Number(h.n) ? 'on' : ''}
                    style={{ height: `${Math.max(6, (Number(h.n) / peak) * 100)}%` }}
                    title={`${h.hour}:00 — ${h.n} requests`}
                  />
                ))}
              </div>
            ) : (
              <div className="tiny muted">No requests recorded in the last 24 hours.</div>
            )}
          </Panel>

          <Panel title="tool emulation">
            <div className="tiny muted" style={{ lineHeight: 1.7 }}>
              Web connectors mostly answer in plain text. comb injects a tool protocol, validates the calls a model
              emits, and returns native <code>tool_calls</code> with parsed arguments. Each model stores the variant
              that actually worked during calibration.
            </div>
            <div className="inline" style={{ marginTop: 10 }}>
              {(status?.tool_variants ?? []).map((v: string) => (
                <Badge key={v} tone="blue">
                  {v}
                </Badge>
              ))}
              <span className="tiny muted">{status?.emulated ?? 0} emulated models</span>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
