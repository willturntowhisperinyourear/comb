import { useEffect, useState } from 'react';
import { api, ms, when } from '../api.ts';
import { Badge, Empty, Panel } from '../ui.tsx';

export default function LogsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [usage, setUsage] = useState<any>(null);
  const [limit, setLimit] = useState(100);
  const [auto, setAuto] = useState(true);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    const load = () => {
      api.get(`/logs?limit=${limit}`).then(setRows).catch(() => {});
      api.get('/usage?range=24h').then(setUsage).catch(() => {});
    };
    load();
    if (!auto) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [limit, auto]);

  const visible = rows.filter((r) => (filter === 'all' ? true : filter === 'ok' ? r.ok : !r.ok));

  return (
    <>
      <Panel
        title="requests"
        actions={
          <>
            <label className="checkline">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> live
            </label>
            <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 110 }}>
              <option value="all">all</option>
              <option value="ok">ok</option>
              <option value="fail">failed</option>
            </select>
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ width: 100 }}>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={300}>300</option>
            </select>
          </>
        }
      >
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>time</th>
                <th>model</th>
                <th>upstream</th>
                <th className="num">http</th>
                <th className="num">ms</th>
                <th className="num">tokens</th>
                <th>error</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id}>
                  <td className="tiny muted">{when(r.ts)}</td>
                  <td className="mono-cell">{r.model}</td>
                  <td className="tiny muted">{r.upstream_id?.slice(0, 8) ?? '—'}</td>
                  <td className="num">{r.ok ? <Badge tone="ok">{r.status}</Badge> : <Badge tone="bad">{r.status}</Badge>}</td>
                  <td className="num">{ms(r.latency_ms)}</td>
                  <td className="num tiny muted">{r.tokens_in + r.tokens_out}</td>
                  <td className="tiny" style={{ color: r.error ? 'var(--bad)' : 'var(--dim-2)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.error ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visible.length && <Empty>No requests recorded yet. Send one from the Playground.</Empty>}
        </div>
      </Panel>

      <div className="grid-2">
        <Panel title="by model · 24h">
          <table>
            <thead>
              <tr>
                <th>model</th>
                <th className="num">req</th>
                <th className="num">ok</th>
                <th className="num">avg</th>
              </tr>
            </thead>
            <tbody>
              {(usage?.byModel ?? []).map((m: any) => (
                <tr key={m.model}>
                  <td className="mono-cell">{m.model}</td>
                  <td className="num">{m.requests}</td>
                  <td className="num">{Math.round((Number(m.ok) / Math.max(1, Number(m.requests))) * 100)}%</td>
                  <td className="num">{ms(Number(m.latency))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!usage?.byModel?.length && <Empty>Nothing yet.</Empty>}
        </Panel>
        <Panel title="by status · 24h">
          <div className="chip-list">
            {(usage?.byStatus ?? []).map((s: any) => (
              <span className="chip" key={s.status}>
                <span>{s.status}</span>
                <span className="muted">{s.n}</span>
              </span>
            ))}
          </div>
          {!usage?.byStatus?.length && <Empty>Nothing yet.</Empty>}
        </Panel>
      </div>
    </>
  );
}
