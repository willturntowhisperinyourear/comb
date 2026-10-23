import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Badge, Button, CopyLine, Empty, Field, Panel } from '../ui.tsx';

export default function KeysPage() {
  const [keys, setKeys] = useState<any[]>([]);
  const [bootstrap, setBootstrap] = useState<{ key: string; active: boolean }>({ key: '', active: false });
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [form, setForm] = useState({ name: 'client', rpm: 0, rpd: 0 });
  const [error, setError] = useState('');

  const load = () => {
    api.get('/keys').then(setKeys).catch(() => {});
    api.get('/bootstrap-key').then(setBootstrap).catch(() => {});
  };
  useEffect(load, []);

  async function create() {
    setError('');
    try {
      const key = await api.post('/keys', form);
      setCreated(key);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <>
      {error && <div className="note bad">{error}</div>}

      <Panel title="bootstrap key" actions={<Badge tone={bootstrap.active ? 'ok' : 'bad'}>{bootstrap.active ? 'active' : 'revoked'}</Badge>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {bootstrap.active ? (
            <CopyLine label="api key" value={bootstrap.key} />
          ) : (
            <div className="note bad">
              The bootstrap key was revoked. Requests that still send it get 401. Only this key's plaintext existed, so
              create a new key below and paste it into your client configuration.
            </div>
          )}
          <div className="tiny muted">
            Created on first start, also written to <code>data/bootstrap-key.txt</code>. The dashboard itself is
            unauthenticated: keep it on loopback or behind your own proxy.
          </div>
        </div>
      </Panel>

      <Panel title="new key">
        <div className="form-row">
          <Field label="name">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="rpm" hint="0 = unlimited">
            <input type="number" value={form.rpm} onChange={(e) => setForm({ ...form, rpm: Number(e.target.value) })} />
          </Field>
          <Field label="rpd">
            <input type="number" value={form.rpd} onChange={(e) => setForm({ ...form, rpd: Number(e.target.value) })} />
          </Field>
          <Button variant="primary" onClick={create}>
            create key
          </Button>
        </div>
        {created && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="note">
              Copy this now. Only the hash is stored, so it cannot be shown again.
            </div>
            <CopyLine label={created.name} value={created.key} />
          </div>
        )}
      </Panel>

      <Panel title="keys" actions={<span className="tiny muted">{keys.filter((k) => !k.revoked).length} active</span>}>
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>name</th>
                <th>prefix</th>
                <th className="num">rpm</th>
                <th className="num">rpd</th>
                <th className="num">requests</th>
                <th>created</th>
                <th>state</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="mono-cell muted">{k.prefix}…</td>
                  <td className="num">{k.rpm || '∞'}</td>
                  <td className="num">{k.rpd || '∞'}</td>
                  <td className="num">{k.requests}</td>
                  <td className="tiny muted">{k.created_at?.slice(0, 16).replace('T', ' ')}</td>
                  <td>{k.revoked ? <Badge tone="bad">revoked</Badge> : <Badge tone="ok">active</Badge>}</td>
                  <td>
                    {!k.revoked && (
                      <Button variant="ghost" onClick={() => api.del(`/keys/${k.id}`).then(load)}>
                        revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!keys.length && <Empty>No keys yet.</Empty>}
        </div>
      </Panel>
    </>
  );
}
