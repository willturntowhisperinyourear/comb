import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Badge, Button, Empty, Field, Panel, statusTone } from '../ui.tsx';
import CustomConnectorForm, { type InstalledConnector } from './CustomConnector.tsx';

export default function ConnectorsPage() {
  const [plugins, setPlugins] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [log, setLog] = useState('');
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [showCustom, setShowCustom] = useState(false);
  const [editId, setEditId] = useState('');
  const [notice, setNotice] = useState('');
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

  function installed(result: InstalledConnector) {
    setShowCustom(false);
    setEditId('');
    setNotice(
      `${result.plugin?.name ?? result.plugin?.id} is installed${result.installing ? ' and running its install command' : ''}. ` +
        (result.upstream_id ? 'Its upstream was created and will be refreshed.' : 'No upstream was created.'),
    );
    load();
  }

  return (
    <>
      {error && <div className="note bad">{error}</div>}
      {notice && <div className="note">{notice}</div>}
      <div className="note info">
        A connector is a repo on this host exposing an OpenAI-compatible port. comb stores it under{' '}
        <code>data/plugins/</code>, supervises the process, and keeps the last log. Commands run as your user: only
        install sources you trust.
      </div>

      <Panel
        title="connectors"
        actions={
          <Button
            onClick={() => {
              setEditId('');
              setShowCustom((s) => !s);
            }}
          >
            {showCustom ? 'close' : 'add custom connector'}
          </Button>
        }
        className="panel"
      >
        {showCustom && (
          <div className="note" style={{ marginBottom: 12 }}>
            <div className="tiny" style={{ marginBottom: 8, lineHeight: 1.7 }}>
              Pick a git repository or upload a release archive. comb extracts it into a staging folder, inspects the
              tree, and pre-fills the fields below; nothing lands in <code>data/plugins</code> until you press install.
              Choosing an existing id updates that connector's files in place, then reinstalls and refreshes it.
            </div>
            <CustomConnectorForm
              key={editId || 'new'}
              initialId={editId}
              onInstalled={installed}
              onCancel={() => {
                setShowCustom(false);
                setEditId('');
              }}
            />
          </div>
        )}

        <div className="tiny muted" style={{ marginBottom: 10 }}>
          tools is the connector's capability: <b>native</b> means it forwards OpenAI tool calls, <b>emulate</b>{' '}
          means comb injects the tool protocol and parses the calls back out.
        </div>
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
                  <td className="tiny muted">
                    <Badge tone={p.tools_hint === 'native' ? 'blue' : 'idle'}>{p.tools_hint}</Badge>
                  </td>
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
                      {p.custom && (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setEditId(p.id);
                            setShowCustom(true);
                            document.querySelector('.content')?.scrollTo({ top: 0, behavior: 'smooth' });
                          }}
                          title="upload a new archive or repo for this connector; its files are replaced and install runs again"
                        >
                          replace files
                        </Button>
                      )}
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
