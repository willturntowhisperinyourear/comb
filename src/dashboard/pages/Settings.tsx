import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Badge, Button, Field, Panel } from '../ui.tsx';
import DoctorSettings from '../DoctorSettings.tsx';

const STRATEGIES = [
  'priority',
  'weighted',
  'round_robin',
  'least_used',
  'fastest',
  'cheapest',
  'quota_headroom',
];

interface SchedulerState {
  enabled: boolean;
  interval_minutes: number;
  running: boolean;
  last_run: string | null;
  next_run: string | null;
  last_summary: null | {
    at: string;
    trigger: string;
    upstreams: number;
    refreshed: number;
    calibrated: number;
    failed: number;
    healthy: number;
    skipped: number;
    warnings: string[];
  };
}

const stamp = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');

const until = (value: string | null) => {
  if (!value) return 'not scheduled';
  const diff = Date.parse(value) - Date.now();
  if (!Number.isFinite(diff)) return '—';
  if (diff <= 0) return 'due now';
  const mins = Math.round(diff / 60_000);
  return mins >= 60 ? `in ${Math.round(mins / 60)}h` : `in ${Math.max(1, mins)}m`;
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [sched, setSched] = useState<SchedulerState | null>(null);
  const [intervalMin, setIntervalMin] = useState('60');
  const [schedNote, setSchedNote] = useState('');
  const [schedBusy, setSchedBusy] = useState(false);

  useEffect(() => {
    api.get('/settings').then(setSettings).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<SchedulerState>('/scheduler')
        .then((s) => {
          if (!alive) return;
          setSched(s);
          setIntervalMin((cur) => (cur === '60' ? String(s.interval_minutes) : cur));
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const set = (k: string, v: string) => setSettings((s) => ({ ...s, [k]: v }));

  async function patchScheduler(body: Record<string, unknown>) {
    setSchedBusy(true);
    setSchedNote('');
    try {
      setSched(await api.patch<SchedulerState>('/scheduler', body));
    } catch (e: any) {
      setSchedNote(e.message);
    } finally {
      setSchedBusy(false);
    }
  }

  async function runSchedulerNow() {
    setSchedBusy(true);
    setSchedNote('');
    try {
      const res = await api.post('/scheduler/run');
      setSched((s) => (s ? { ...s, running: true, ...res.state } : res.state));
      setSchedNote('started; results appear here when the pass finishes');
    } catch (e: any) {
      setSchedNote(e.message);
    } finally {
      setSchedBusy(false);
    }
  }

  const last = sched?.last_summary;

  async function save() {
    setError('');
    try {
      await api.patch('/settings', {
        strategy: settings.strategy,
        max_attempts: settings.max_attempts,
        cooldown_base_ms: settings.cooldown_base_ms,
        request_timeout_ms: settings.request_timeout_ms,
        default_tool_variant: settings.default_tool_variant,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <>
      {error && <div className="note bad">{error}</div>}

      <Panel title="router defaults">
        <div className="form-grid">
          <Field label="default strategy" hint="used when a chain does not set its own">
            <select value={settings.strategy ?? 'priority'} onChange={(e) => set('strategy', e.target.value)}>
              {STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="max attempts" hint="upstreams tried per request">
            <input
              type="number"
              min={1}
              max={10}
              value={settings.max_attempts ?? '4'}
              onChange={(e) => set('max_attempts', e.target.value)}
            />
          </Field>
          <Field label="cooldown base (ms)" hint="doubles per consecutive failure, capped at 15 min">
            <input
              type="number"
              value={settings.cooldown_base_ms ?? '30000'}
              onChange={(e) => set('cooldown_base_ms', e.target.value)}
            />
          </Field>
          <Field label="request timeout (ms)">
            <input
              type="number"
              value={settings.request_timeout_ms ?? '120000'}
              onChange={(e) => set('request_timeout_ms', e.target.value)}
            />
          </Field>
          <Field label="default tool variant" hint="fallback for new emulated models until calibration picks one">
            <select
              value={settings.default_tool_variant ?? 'xml'}
              onChange={(e) => set('default_tool_variant', e.target.value)}
            >
              <option value="xml">xml</option>
              <option value="fence">fence</option>
              <option value="json">json</option>
            </select>
          </Field>
        </div>
        <div className="inline" style={{ marginTop: 12 }}>
          <Button variant="primary" onClick={save}>
            save settings
          </Button>
          {saved && <Badge tone="ok">saved</Badge>}
        </div>
      </Panel>

      <Panel
        title="background scheduler"
        actions={
          <span className="inline">
            <Badge tone={sched?.running ? 'warn' : sched?.enabled ? 'ok' : 'idle'}>
              {sched?.running ? 'running' : sched?.enabled ? 'on' : 'off'}
            </Badge>
          </span>
        }
      >
        <div className="tiny muted" style={{ marginBottom: 10, lineHeight: 1.7 }}>
          Each pass refreshes every active upstream, re-discovers its models and calibrates only the emulated models
          that are still uncalibrated. Calibrated models are left alone, and a pass never overlaps a manual refresh
          or another pass.
        </div>
        <div className="form-grid">
          <Field label="enabled" hint="runs in the background while comb is up">
            <select
              value={sched?.enabled ? 'on' : 'off'}
              onChange={(e) => patchScheduler({ enabled: e.target.value === 'on', interval_minutes: Number(intervalMin) })}
              disabled={schedBusy}
            >
              <option value="off">off</option>
              <option value="on">on</option>
            </select>
          </Field>
          <Field label="interval (minutes)" hint="1 to 1440">
            <input
              type="number"
              min={1}
              max={1440}
              value={intervalMin}
              onChange={(e) => setIntervalMin(e.target.value)}
            />
          </Field>
          <Field label="">
            <div className="inline">
              <Button
                onClick={() => patchScheduler({ interval_minutes: Number(intervalMin) })}
                disabled={schedBusy}
              >
                save interval
              </Button>
              <Button variant="primary" onClick={runSchedulerNow} disabled={schedBusy || sched?.running}>
                run scheduler now
              </Button>
            </div>
          </Field>
        </div>
        {schedNote && <div className="note tiny">{schedNote}</div>}
        <table style={{ marginTop: 10 }}>
          <tbody>
            <tr>
              <td className="muted tiny">last run</td>
              <td className="mono-cell">{stamp(sched?.last_run ?? null)}</td>
            </tr>
            <tr>
              <td className="muted tiny">next run</td>
              <td className="mono-cell">
                {sched?.enabled ? `${stamp(sched?.next_run ?? null)} (${until(sched?.next_run ?? null)})` : 'disabled'}
              </td>
            </tr>
            {last && (
              <tr>
                <td className="muted tiny">last summary</td>
                <td className="tiny">
                  {last.trigger} · {last.upstreams} upstreams · {last.refreshed} refreshed · {last.healthy} healthy ·{' '}
                  {last.calibrated} calibrated · {last.failed} failed · {last.skipped} skipped
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {last?.warnings?.length ? (
          <div className="note tiny" style={{ marginTop: 8 }}>
            {last.warnings.slice(0, 6).map((w, i) => (
              <div key={i}>· {w}</div>
            ))}
            {last.warnings.length > 6 && <div className="muted">… and {last.warnings.length - 6} more</div>}
          </div>
        ) : null}
      </Panel>

      <DoctorSettings />

      <Panel title="runtime">
        <table>
          <tbody>
            <tr>
              <td className="muted tiny">openai base url</td>
              <td className="mono-cell">{location.origin}/v1</td>
            </tr>
            <tr>
              <td className="muted tiny">endpoints</td>
              <td className="mono-cell">POST /v1/chat/completions · GET /v1/models · GET /v1/health</td>
            </tr>
            <tr>
              <td className="muted tiny">not routed yet</td>
              <td className="mono-cell">/v1/embeddings returns 501 by design</td>
            </tr>
            <tr>
              <td className="muted tiny">data</td>
              <td className="mono-cell">data/comb.db · data/plugins/ · data/bootstrap-key.txt</td>
            </tr>
          </tbody>
        </table>
      </Panel>
    </>
  );
}
