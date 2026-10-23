import { useRef, useState } from 'react';
import { api, postForm } from '../api.ts';
import { Badge, Button, Field } from '../ui.tsx';

// Custom sources: clone a git repo or upload an archive, inspect it on the
// host, then review what the analyzer proposed before anything is installed.

export interface InstalledConnector {
  plugin: any;
  upstream_id: string | null;
  installing: boolean;
}

interface Form {
  id: string;
  name: string;
  kind: string;
  port: number | string;
  base_path: string;
  tools_hint: 'native' | 'emulate';
  install_cmd: string;
  run_cmd: string;
  models: string;
  create_upstream: boolean;
  auto_calibrate: boolean;
  start: boolean;
}

const ACCEPT = '.zip,.tar.gz,.tgz,.tar,.rar,.7z';

const emptyForm = (initialId = ''): Form => ({
  id: initialId,
  name: '',
  kind: 'web2api',
  port: 8095,
  base_path: '/v1',
  tools_hint: 'emulate',
  install_cmd: '',
  run_cmd: '',
  models: '',
  create_upstream: true,
  auto_calibrate: true,
  start: true,
});

export default function CustomConnectorForm({
  initialId = '',
  onInstalled,
  onCancel,
}: {
  initialId?: string;
  onInstalled?: (result: InstalledConnector) => void;
  onCancel?: () => void;
}) {
  const [mode, setMode] = useState<'git' | 'upload'>('git');
  const [gitUrl, setGitUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [prepared, setPrepared] = useState<any>(null);
  const [form, setForm] = useState<Form>(emptyForm(initialId));
  const [busy, setBusy] = useState<'' | 'analyze' | 'install'>('');
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  function applyPrepared(result: any) {
    const a = result.analysis ?? {};
    setPrepared(result);
    setForm({
      id: initialId || String(a.id ?? ''),
      name: String(a.name ?? ''),
      kind: String(a.kind ?? 'web2api'),
      port: Number(a.port ?? 8095),
      base_path: String(a.base_path ?? '/v1'),
      tools_hint: a.tools_hint === 'native' ? 'native' : 'emulate',
      install_cmd: String(a.install_cmd ?? ''),
      run_cmd: String(a.run_cmd ?? ''),
      models: Array.isArray(a.models) ? a.models.join(', ') : '',
      create_upstream: true,
      auto_calibrate: true,
      start: true,
    });
  }

  async function analyze() {
    setError('');
    setPrepared(null);
    setBusy('analyze');
    try {
      if (mode === 'git') {
        if (!gitUrl.trim()) throw new Error('paste a git repository url first');
        applyPrepared(await api.post('/connectors/analyze', { git_url: gitUrl.trim() }));
      } else {
        if (!file) throw new Error('choose an archive file first');
        const data = new FormData();
        data.append('file', file, file.name);
        applyPrepared(await postForm('/connectors/upload', data));
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  async function install() {
    if (!prepared) return;
    setError('');
    setBusy('install');
    try {
      const result = await api.post<InstalledConnector>('/connectors/install', {
        staging_id: prepared.staging_id,
        id: form.id.trim(),
        name: form.name.trim(),
        kind: form.kind,
        port: Number(form.port),
        base_path: form.base_path,
        tools_hint: form.tools_hint,
        install_cmd: form.install_cmd,
        run_cmd: form.run_cmd,
        models: form.models
          .split(/[,\n]/)
          .map((m) => m.trim())
          .filter(Boolean),
        create_upstream: form.create_upstream,
        auto_calibrate: form.auto_calibrate,
        start: form.start,
      });
      setPrepared(null);
      setFile(null);
      setGitUrl('');
      setForm(emptyForm(initialId));
      onInstalled?.(result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div className="inline" style={{ marginBottom: 10 }}>
        <Button variant={mode === 'git' ? 'primary' : 'default'} onClick={() => setMode('git')}>
          git repo url
        </Button>
        <Button variant={mode === 'upload' ? 'primary' : 'default'} onClick={() => setMode('upload')}>
          upload archive
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            close
          </Button>
        )}
      </div>

      {mode === 'git' ? (
        <Field label="git repository" hint="cloned with --depth 1 into a staging folder, never into data/plugins directly">
          <input
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            placeholder="https://github.com/user/connector"
          />
        </Field>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const dropped = e.dataTransfer.files?.[0];
            if (dropped) setFile(dropped);
          }}
          onClick={() => fileInput.current?.click()}
          style={{
            border: `1px dashed ${dragOver ? 'var(--accent)' : 'var(--line)'}`,
            borderRadius: 8,
            padding: '18px 14px',
            cursor: 'pointer',
            textAlign: 'center',
          }}
        >
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            style={{ display: 'none' }}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <div className="tiny">
            {file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : 'drop an archive here or click to choose'}
          </div>
          <div className="tiny muted">.zip · .tar.gz · .tgz · .tar · .rar · .7z (200 MB max)</div>
        </div>
      )}

      <div className="inline" style={{ marginTop: 10 }}>
        <Button variant="primary" onClick={analyze} disabled={busy !== ''}>
          {busy === 'analyze' ? 'analyzing…' : prepared ? 'analyze again' : 'analyze'}
        </Button>
        <span className="tiny muted">
          {mode === 'git' ? 'clones and inspects the repo' : 'extracts safely and inspects the tree'}
        </span>
      </div>

      {error && (
        <div className="note bad tiny" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}

      {prepared && (
        <div style={{ marginTop: 14 }}>
          <div className="split-note" style={{ marginBottom: 8 }}>
            <Badge tone="blue">detected</Badge>
            <span className="tiny muted">
              {prepared.analysis?.runtime ?? 'unknown'} runtime · {prepared.files ?? 0} files · {prepared.source}
            </span>
          </div>
          {prepared.notes?.length ? (
            <div className="note tiny" style={{ marginBottom: 8 }}>
              {prepared.notes.map((n: string, i: number) => (
                <div key={i}>· {n}</div>
              ))}
            </div>
          ) : null}
          {prepared.analysis?.notes?.length ? (
            <div className="note tiny" style={{ marginBottom: 8 }}>
              {prepared.analysis.notes.map((n: string, i: number) => (
                <div key={i}>· {n}</div>
              ))}
            </div>
          ) : null}

          <div className="form-grid">
            <Field label="id" hint="folder name under data/plugins; an existing id is updated in place">
              <input value={form.id} onChange={(e) => set('id', e.target.value)} placeholder="my-connector" />
            </Field>
            <Field label="name">
              <input value={form.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="kind">
              <select value={form.kind} onChange={(e) => set('kind', e.target.value)}>
                <option value="web2api">web2api</option>
                <option value="cli2api">cli2api</option>
                <option value="api2api">api2api</option>
              </select>
            </Field>
            <Field label="port" hint="PORT is set in the environment">
              <input type="number" value={form.port} onChange={(e) => set('port', e.target.value)} />
            </Field>
            <Field label="tool mode" hint="native only if the connector really emits OpenAI tool_calls">
              <select
                value={form.tools_hint}
                onChange={(e) => set('tools_hint', e.target.value as Form['tools_hint'])}
              >
                <option value="emulate">emulate</option>
                <option value="native">native</option>
              </select>
            </Field>
            <Field label="base path">
              <input value={form.base_path} onChange={(e) => set('base_path', e.target.value)} />
            </Field>
            <Field label="install command">
              <input
                value={form.install_cmd}
                onChange={(e) => set('install_cmd', e.target.value)}
                placeholder="npm install"
              />
            </Field>
            <Field label="start command" hint="runs in data/plugins/<id> with PORT set">
              <input value={form.run_cmd} onChange={(e) => set('run_cmd', e.target.value)} placeholder="npm start" />
            </Field>
            <Field label="detected models" hint="comma separated; ids only">
              <input value={form.models} onChange={(e) => set('models', e.target.value)} />
            </Field>
          </div>

          <div className="inline" style={{ marginTop: 10 }}>
            <label className="tiny">
              <input
                type="checkbox"
                checked={form.create_upstream}
                onChange={(e) => set('create_upstream', e.target.checked)}
              />{' '}
              create matching upstream
            </label>
            <label className="tiny">
              <input
                type="checkbox"
                checked={form.auto_calibrate}
                onChange={(e) => set('auto_calibrate', e.target.checked)}
              />{' '}
              calibrate models
            </label>
            <label className="tiny">
              <input type="checkbox" checked={form.start} onChange={(e) => set('start', e.target.checked)} /> start after
              install
            </label>
          </div>

          <div className="inline" style={{ marginTop: 12 }}>
            <Button variant="primary" onClick={install} disabled={busy !== '' || !form.run_cmd.trim()}>
              {busy === 'install' ? 'installing…' : 'install'}
            </Button>
            <span className="tiny muted">
              install runs the install command, starts the connector, then refreshes its upstream
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
