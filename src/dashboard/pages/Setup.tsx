import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Badge, Button, Empty, Field, Panel, statusTone } from '../ui.tsx';
import CustomConnectorForm, { type InstalledConnector } from './CustomConnector.tsx';

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
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [showCustom, setShowCustom] = useState(false);

  useEffect(() => {
    api.get('/plugins').then(setPlugins).catch(() => {});
    api.get('/presets').then((d) => setPresets(d.presets)).catch(() => {});
  }, []);

  const add = (text: string, tone?: Line['tone']) => setLines((l) => [...l, { text, tone }]);

  const customInstalled = (result: InstalledConnector) => {
    add(
      `${result.plugin?.name ?? result.plugin?.id}: installed${result.upstream_id ? ' with an upstream' : ''}; its install command is running`,
      'ok',
    );
    setShowCustom(false);
    api.get('/plugins').then(setPlugins).catch(() => {});
    api.get('/presets').then((d) => setPresets(d.presets)).catch(() => {});
  };
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  };

  // Step 1 and step 2 mirror each other: queueing an upstream must queue the
  // connector it runs on, and queueing a connector must queue its upstream.
  const pickPreset = (preset: any) => {
    setPickedPresets((s) => toggle(s, preset.id));
    if (preset.plugin_id) setPicked((s) => new Set(s).add(preset.plugin_id));
  };

  const pickPlugin = (id: string) => {
    setPicked((s) => toggle(s, id));
    const preset = presets.find((p) => p.plugin_id === id);
    if (preset) setPickedPresets((s) => new Set(s).add(preset.id));
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
    let hadFailure = false;
    try {
      const extraModels = Object.fromEntries(
        Object.entries(extras).map(([id, value]) => [
          id,
          value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ]),
      );
      const res = await api.post('/setup', {
        install: [...picked],
        create: [...pickedPresets],
        models: extraModels,
      });
      add(`queued ${res.installed.length} install(s), prepared ${res.upstreams.length} upstream(s)`, 'ok');

      const unavailable = new Set<string>();
      for (const p of res.installed) {
        add(`waiting for ${p.id} to install…`);
        const done = await waitForPlugin(p.id, ['installed', 'error']);
        if (!done || done.status === 'error') {
          hadFailure = true;
          unavailable.add(p.id);
          add(done ? `${p.id}: ${done.last_error}` : `${p.id}: install still running; check Connectors later`, 'err');
        } else add(`${p.id}: installed`, 'ok');
      }

      const created = new Set<string>(res.upstreams.map((u: any) => u.id));
      const upstreams = await api.get<any[]>('/upstreams');
      for (const up of upstreams.filter((u) => created.has(u.id))) {
        if (up.plugin_id) {
          if (unavailable.has(up.plugin_id)) {
            add(`${up.name}: skipped start and refresh because installation did not complete`, 'err');
            continue;
          }
          add(`starting connector for ${up.name}…`);
          await api.post(`/plugins/${up.plugin_id}/start`).catch((e) => add(`start failed: ${e.message}`, 'err'));
          const started = await waitForPlugin(up.plugin_id, ['running', 'error', 'stopped'], 60);
          if (!started || started.status !== 'running') {
            hadFailure = true;
            add(`${up.plugin_id}: not ready (${started?.last_error ?? 'timeout'})`, 'err');
          } else {
            add(`${up.plugin_id}: running`, 'ok');
          }
        }
        const refresh = await api
          .post(`/upstreams/${up.id}/refresh`, { verify: true })
          .catch((e) => ({ error: e.message, warnings: [e.message] }));
        if (refresh.error) {
          hadFailure = true;
          add(`refresh ${up.name}: ${refresh.error}`, 'err');
          continue;
        }
        if (!refresh.verification?.ok) {
          hadFailure = true;
          add(`${up.name}: no model response verified (${refresh.verification?.error ?? 'response test did not pass'})`, 'err');
        } else {
          add(`${up.name}: verified response from ${refresh.verification.model}: ${refresh.verification.reply}`, 'ok');
        }
        add(
          `${up.name}: ${refresh.discovered.length} discovered · ${refresh.created.length} new · ${refresh.calibrated} calibrated · ${refresh.failed} failed`,
          refresh.failed ? 'err' : 'ok',
        );
        for (const warning of refresh.warnings ?? []) add(`  ${warning}`, 'err');
      }
      add(
        hadFailure
          ? 'setup completed with failures. See the errors above; affected connectors are not ready for chat.'
          : 'setup verified model responses. Review Models and Routing, then send a request from the Playground.',
        hadFailure ? 'err' : 'ok',
      );
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
        <div className="tiny muted" style={{ marginBottom: 10 }}>
          Selecting a connector also queues its upstream in step 2, and the other way round.
        </div>
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
                    onClick={() => pickPlugin(p.id)}
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

        <div className="split-note" style={{ marginTop: 14, marginBottom: 8 }}>
          <Badge tone="idle">custom source</Badge>
          <span>
            Not in the catalog? Point comb at any git repo or release archive; it analyzes the tree and pre-fills a
            connector you can review before installing.
          </span>
        </div>
        <Button onClick={() => setShowCustom((s) => !s)}>{showCustom ? 'close custom source' : 'add custom repo or archive'}</Button>
        {showCustom && (
          <div style={{ marginTop: 10 }}>
            <CustomConnectorForm onInstalled={customInstalled} onCancel={() => setShowCustom(false)} />
          </div>
        )}
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

        {pickedPresets.size > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="split-note" style={{ marginBottom: 8 }}>
              <Badge tone="blue">extra models</Badge>
              <span>
                connectors ship an older model list than the provider serves; add the newer ids here and they are
                created with the upstream
              </span>
            </div>
            <div className="form-grid">
              {presets
                .filter((p) => pickedPresets.has(p.id))
                .map((p) => (
                  <Field key={p.id} label={p.name} hint="comma separated">
                    <input
                      value={extras[p.id] ?? ''}
                      onChange={(e) => setExtras((s) => ({ ...s, [p.id]: e.target.value }))}
                      placeholder="qwen3.5-max"
                    />
                  </Field>
                ))}
            </div>
          </div>
        )}
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
