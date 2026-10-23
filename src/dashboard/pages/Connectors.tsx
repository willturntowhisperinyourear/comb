import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Badge, Button, Empty, Field, Panel, statusTone } from '../ui.tsx';

export default function ConnectorsPage() {
  const [plugins, setPlugins] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [log, setLog] = useState('');
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [custom, setCustom] = useState<any>({ id: '', repo: '', kind: 'web2api', port: 8099, base_path: '/v1' });
  const [showCustom, setShowCustom] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get('/plugins').then(setPlugins).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  async function act(id: string, action: 'install' | 'start' | 'stop') {
    setError('');
    try {
      await api.post(`/plugins/${id}/${action}`);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function showLog(id: string) {
    setOpen(id === open ? null : id);
    const d = await api.get(`/plugins/${id}/log`);
    setLog(d.log || '(empty log)');
  }

  async function save(id: string) {
    const patch = draft[id] ?? {};
    if (!Object.keys(patch).length) return;
    await api.patch(`/plugins/${id}`, patch).catch((e) => setError(e.message));
    setDraft((d) => ({ ...d, [id]: {} }));
    load();
  }

  async function addCustom() {
    if (!custom.id || !custom.repo) return setError('id and repo are required');
    await api
      .post('/plugins', {
        ...custom,
        name: custom.id,
        install_cmd: custom.install_cmd ?? '',
        run_cmd: custom.run_cmd ?? '',
      })
      .catch((e) => setError(e.message));
    setShowCustom(false);
    load();
  }

  return (
    <>
      {error && <div className="note bad">{error}</div>}
      <div className="note info">
        A connector is a repo on this host exposing an OpenAI-compatible port. comb stores it under{' '}
        <code>data/plugins/</code>, supervises the process, and keeps the last log. Commands run as your user: only
        install repos you trust.
      </div>

      <Panel
        title="connectors"
        actions={
          <Button onClick={() => setShowCustom((s) => !s)}>{showCustom ? 'close' : 'add custom repo'}</Button>
        }
        className="panel"
      >
        {showCustom && (
          <div style={{ marginBottom: 12 }}>
            <div className="form-grid">
              <Field label="id">
                <input value={custom.id} onChange={(e) => setCustom({ ...custom, id: e.target.value })} placeholder="my-connector" />
              </Field>
              <Field label="git repo">
                <input value={custom.repo} onChange={(e) => setCustom({ ...custom, repo: e.target.value })} placeholder="https://github.com/…" />
              </Field>
              <Field label="kind">
                <select value={custom.kind} onChange={(e) => setCustom({ ...custom, kind: e.target.value })}>
                  <option value="web2api">web2api</option>
                  <option value="cli2api">cli2api</option>
                  <option value="api2api">api2api</option>
                </select>
              </Field>
              <Field label="port">
                <input type="number" value={custom.port} onChange={(e) => setCustom({ ...custom, port: Number(e.target.value) })} />
              </Field>
              <Field label="install command">
                <input value={custom.install_cmd ?? ''} onChange={(e) => setCustom({ ...custom, install_cmd: e.target.value })} placeholder="npm install" />
              </Field>
              <Field label="run command" hint="PORT is set in the environment">
                <input value={custom.run_cmd ?? ''} onChange={(e) => setCustom({ ...custom, run_cmd: e.target.value })} placeholder="npm start -- --port $PORT" />
              </Field>
            </div>
            <div style={{ marginTop: 8 }}>
              <Button variant="primary" onClick={addCustom}>
                add to catalog
              </Button>
            </div>
          </div>
        )}

        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>connector</th>
                <th>kind</th>
                <th>status</th>
                <th className="num">port</th>
                <th>tools</th>
                <th style={{ width: 300 }}>actions</th>
              </tr>
            </thead>
            <tbody>
              {plugins.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div>{p.name}</div>
                    <div className="tiny muted">{p.repo.replace('https://github.com/', '')}</div>
                    {open === p.id && (
                      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div className="form-grid">
                          <Field label="repo">
                            <input
                              defaultValue={p.repo}
                              onChange={(e) => setDraft((d) => ({ ...d, [p.id]: { ...d[p.id], repo: e.target.value } }))}
                            />
                          </Field>
                          <Field label="install command">
                            <input
                              defaultValue={p.install_cmd}
                              onChange={(e) => setDraft((d) => ({ ...d, [p.id]: { ...d[p.id], install_cmd: e.target.value } }))}
                            />
                          </Field>
                          <Field label="run command">
                            <input
                              defaultValue={p.run_cmd}
                              onChange={(e) => setDraft((d) => ({ ...d, [p.id]: { ...d[p.id], run_cmd: e.target.value } }))}
                            />
                          </Field>
                          <Field label="port">
                            <input
                              type="number"
                              defaultValue={p.port ?? ''}
                              onChange={(e) => setDraft((d) => ({ ...d, [p.id]: { ...d[p.id], port: Number(e.target.value) } }))}
                            />
                          </Field>
                        </div>
                        <div className="inline">
                          <Button onClick={() => save(p.id)}>save</Button>
                          <span className="tiny muted">saving resets the connector to not installed</span>
                        </div>
                        <div className="tiny muted">{p.auth_hint}</div>
                        {p.last_error && <div className="note bad tiny">{p.last_error}</div>}
                        <pre>{log}</pre>
                      </div>
                    )}
                  </td>
                  <td>
                    <Badge tone="blue">{p.kind}</Badge>
                  </td>
                  <td>
                    <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                  </td>
                  <td className="num muted tiny">{p.port ?? '—'}</td>
                  <td className="tiny muted">{p.tools_hint}</td>
                  <td>
                    <div className="inline">
                      <Button onClick={() => act(p.id, 'install')} disabled={p.status === 'installing'}>
                        {p.status === 'not_installed' || p.status === 'error' ? 'install' : 'reinstall'}
                      </Button>
                      <Button onClick={() => act(p.id, 'start')} disabled={p.status === 'not_installed' || p.status === 'running'}>
                        start
                      </Button>
                      <Button onClick={() => act(p.id, 'stop')} disabled={p.status === 'not_installed' || p.status === 'stopped'}>
                        stop
                      </Button>
                      <Button variant="ghost" onClick={() => showLog(p.id)}>
                        {open === p.id ? 'hide' : 'log'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!plugins.length && <Empty>No connectors in the catalog.</Empty>}
        </div>
      </Panel>
    </>
  );
}
