import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Badge, Button, Empty, Panel, statusTone } from '../ui.tsx';

type Line = { text: string; tone?: 'ok' | 'err' };

const KINDS: { id: string; label: string; note: string }[] = [
  { id: 'web2api', label: 'web2api', note: 'reverse-engineered consumer web sessions' },
  { id: 'cli2api', label: 'cli2api', note: 'a logged-in CLI as an HTTP endpoint' },
  { id: 'api2api', label: 'api2api', note: 'key or OAuth account pools' },
];

const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

export default function SetupPage({ done }: { done: () => void }) {
  const [plugins, setPlugins] = useState<any[]>([]);
  const [presets, setPresets] = useState<any[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickedPresets, setPickedPresets] = useState<Set<string>>(new Set());
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/plugins').then(setPlugins).catch(() => {});
    api.get('/presets').then((d) => setPresets(d.presets)).catch(() => {});
  }, []);

  const add = (text: string, tone?: Line['tone']) => setLines((l) => [...l, { text, tone }]);
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  };

  const pickPreset = (preset: any) => {
    setPickedPresets((s) => toggle(s, preset.id));
    if (preset.plugin_id) setPicked((s) => new Set(s).add(preset.plugin_id));
  };

  async function waitForPlugin(id: string, wanted: string[], seconds = 150) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      const list = await api.get<any[]>('/plugins');
      const p = list.find((x) => x.id === id);
      if (p && wanted.includes(p.status)) return p;
      await sleep(1800);
    }
    return null;
  }

  async function run() {
    setBusy(true);
    setLines([]);
    add(`install queue: ${[...picked].join(', ') || 'none'}`);
    add(`upstreams to create: ${[...pickedPresets].join(', ') || 'none'}`);
    try {
      const res = await api.post('/setup', { install: [...picked], create: [...pickedPresets] });
      add(`queued ${res.installed.length} install(s), created ${res.upstreams.length} upstream(s)`, 'ok');

      for (const p of res.installed) {
        add(`waiting for ${p.id} to install…`);
        const done = await waitForPlugin(p.id, ['installed', 'error']);
        if (!done) add(`${p.id}: install still running; check Connectors later`, 'err');
        else if (done.status === 'error') add(`${p.id}: ${done.last_error}`, 'err');
        else add(`${p.id}: installed`, 'ok');
      }

      const upstreams = await api.get<any[]>('/upstreams');
      for (const up of upstreams) {
        if (!up.plugin_id) continue;
        add(`starting connector for ${up.name}…`);
        await api.post(`/api/plugins/${up.plugin_id}/start`).catch((e) => add(`start failed: ${e.message}`, 'err'));
        const run = await waitForPlugin(up.plugin_id, ['running', 'error', 'stopped'], 60);
        if (!run || run.status === 'error') {
          add(`${up.plugin_id}: not running (${run?.last_error ?? 'timeout'}) — check its log`, 'err');
          continue;
        }
        add(`${up.plugin_id}: running`, 'ok');
        const discovery = await api
          .post(`/api/upstreams/${up.id}/discover`)
          .catch((e) => ({ error: e.message, created: [] as string[] }));
        if (discovery.error) add(`discover ${up.name}: ${discovery.error}`, 'err');
        else add(`discover ${up.name}: ${discovery.created.length} new model(s)`, 'ok');
      }

      const models = await api.get<any[]>('/models');
      const emulated = models.filter((m) => m.tools_mode === 'emulate');
      add(`calibrating tool emulation for ${emulated.length} model(s)…`);
      for (const m of emulated) {
        const report = await api.post(`/api/models/${encodeURIComponent(m.id)}/recalibrate`).catch((e) => null);
        if (!report) {
          add(`${m.id}: calibration failed`, 'err');
          continue;
        }
        const winner = report.winner;
        if (winner) add(`${m.id}: tools via ${winner.mode}${winner.variant ? ':' + winner.variant : ''}`, 'ok');
        else add(`${m.id}: no variant produced a valid tool call`, 'err');
      }
      add('setup finished. Review Models and Routing, then send a request from the Playground.', 'ok');
    } catch (err: any) {
      add(`setup failed: ${err.message}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  const connectorPresets = presets.filter((p) => p.plugin_id);
  const hostPresets = presets.filter((p) => !p.plugin_id);

  return (
    <>
      <div className="note info">
        Installs run on this host with git, npm, python and go: comb clones each repo into{' '}
        <code>data/plugins/&lt;id&gt;</code> and runs its install command. Repos are third-party and unofficial, so a
        failed install or a connector that stops working after a provider change is normal. Read the log before
        assuming comb is broken.
      </div>

      <Panel
        title="1 · connectors to install"
        actions={
          <span className="tiny muted">
            {picked.size} selected · {plugins.filter((p) => p.status === 'running').length} running
          </span>
        }
      >
        {KINDS.map((kind) => {
          const rows = plugins.filter((p) => p.kind === kind.id);
          if (!rows.length) return null;
          return (
            <div key={kind.id} style={{ marginBottom: 14 }}>
              <div className="split-note" style={{ marginBottom: 8 }}>
                <Badge tone="blue">{kind.label}</Badge>
                <span>{kind.note}</span>
              </div>
              <div className="cards">
                {rows.map((p) => (
                  <div
                    key={p.id}
                    className={`connector ${picked.has(p.id) ? 'selected' : ''}`}
                    onClick={() => setPicked((s) => toggle(s, p.id))}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className="connector-head">
                      <div>
                        <div className="connector-name">{p.name}</div>
                        <div className="tiny muted">{p.repo.replace('https://github.com/', '')}</div>
                      </div>
                      <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                    </div>
                    <div className="connector-desc">{p.description}</div>
                    <div className="connector-foot">
                      <Badge tone={p.tools_hint === 'native' ? 'blue' : 'idle'}>tools: {p.tools_hint}</Badge>
                      {p.port ? <span className="tiny muted">:{p.port}</span> : null}
                      {picked.has(p.id) ? <span className="tiny" style={{ color: 'var(--accent)' }}>queued</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        {!plugins.length && <Empty>Loading connector catalog…</Empty>}
      </Panel>

      <Panel title="2 · upstreams to create">
        <div className="cards">
          {connectorPresets.map((p) => (
            <div
              key={p.id}
              className={`connector ${pickedPresets.has(p.id) ? 'selected' : ''}`}
              onClick={() => pickPreset(p)}
              style={{ cursor: 'pointer' }}
            >
              <div className="connector-head">
                <div className="connector-name">{p.name}</div>
                <Badge tone={p.tools_mode === 'native' ? 'blue' : 'ok'}>
                  {p.tools_mode === 'emulate' ? 'emulated tools' : p.tools_mode}
                </Badge>
              </div>
              <div className="connector-desc">{p.credential_hint}</div>
              <div className="connector-foot">
                <span className="tiny muted">{p.models.join(' · ')}</span>
              </div>
            </div>
          ))}
          {hostPresets.map((p) => (
            <div
              key={p.id}
              className={`connector ${pickedPresets.has(p.id) ? 'selected' : ''}`}
              onClick={() => pickPreset(p)}
              style={{ cursor: 'pointer' }}
            >
              <div className="connector-head">
                <div className="connector-name">{p.name}</div>
                <Badge tone="idle">no install</Badge>
              </div>
              <div className="connector-desc">{p.credential_hint}</div>
              <div className="connector-foot">
                <span className="tiny muted">{p.kind === 'cli' ? 'needs the CLI on this host' : 'base url + key'}</span>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel
        title="3 · run"
        actions={
          <>
            <Button variant="primary" onClick={run} disabled={busy || (!picked.size && !pickedPresets.size)}>
              {busy ? 'running…' : 'run setup'}
            </Button>
            <Button onClick={done} disabled={busy}>
              skip to dashboard
            </Button>
          </>
        }
      >
        {lines.length ? (
          <div className="log">
            {lines.map((l, i) => (
              <div key={i} className={l.tone}>
                {l.tone === 'err' ? '✗ ' : l.tone === 'ok' ? '✓ ' : '· '}
                {l.text}
              </div>
            ))}
          </div>
        ) : (
          <Empty>
            Nothing queued yet. Pick connectors above; each upstream you select installs the repo it needs, starts it,
            discovers models, then calibrates how that model emits tool calls.
          </Empty>
        )}
      </Panel>
    </>
  );
}
