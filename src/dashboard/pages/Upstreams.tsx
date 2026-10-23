import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Badge, Button, Empty, Field, Panel, statusTone } from '../ui.tsx';

const blank = {
  preset: '',
  name: '',
  kind: 'api',
  adapter: 'openai-http',
  base_url: '',
  api_key: '',
  cookie: '',
  models: '',
  weight: 1,
  cost_per_1k: 0,
  max_rpm: 0,
  max_rpd: 0,
  reset_mode: 'none',
  cli_command: '',
};

export default function UpstreamsPage() {
  const [upstreams, setUpstreams] = useState<any[]>([]);
  const [presets, setPresets] = useState<any[]>([]);
  const [form, setForm] = useState<any>(blank);
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<Record<string, any>>({});
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = () => api.get('/upstreams').then(setUpstreams).catch(() => {});
  useEffect(() => {
    load();
    api.get('/presets').then((d) => setPresets(d.presets)).catch(() => {});
  }, []);

  function choosePreset(id: string) {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return setForm({ ...blank, preset: '' });
    setForm({
      ...blank,
      preset: id,
      name: preset.name,
      kind: preset.kind,
      adapter: preset.adapter,
      base_url: preset.base_url ?? '',
      models: preset.models.join(', '),
      cost_per_1k: preset.cost_per_1k,
      reset_mode: preset.reset_mode,
    });
  }

  async function create() {
    setNotice(null);
    try {
      const created = await api.post('/upstreams', {
        ...form,
        models: form.models
          .split(',')
          .map((m: string) => m.trim())
          .filter(Boolean),
        config: form.adapter === 'cli-spawn' ? { cli_command: form.cli_command } : {},
      });
      setNotice({ text: `created ${created.models.length} model(s)` });
      setForm(blank);
      load();
    } catch (e: any) {
      setNotice({ text: e.message, bad: true });
    }
  }

  async function discover(id: string) {
    const r = await api.post(`/upstreams/${id}/discover`).catch((e) => ({ error: e.message, created: [] }));
    setNotice(
      r.error
        ? { text: `discovery failed: ${r.error}`, bad: true }
        : { text: `discovered ${r.discovered?.length ?? 0} model(s), ${r.created?.length ?? 0} new` },
    );
    load();
  }

  async function test(id: string) {
    const r = await api.post(`/upstreams/${id}/test`, { prompt: 'Say hello in four words.' });
    setNotice(r.ok ? { text: `reply: ${r.reply || '(empty)'} · ${r.ms}ms` } : { text: r.error ?? 'failed', bad: true });
  }

  async function reset(id: string) {
    const r = await api.post(`/upstreams/${id}/reset-session`).catch((e) => ({ message: e.message, bad: true }));
    setNotice({ text: r.message, bad: (r as any).bad });
    load();
  }

  async function save(id: string) {
    const patch = edit[id] ?? {};
    await api.patch(`/upstreams/${id}`, patch).catch((e) => setNotice({ text: e.message, bad: true }));
    setEdit((e) => ({ ...e, [id]: {} }));
    load();
  }

  async function remove(id: string) {
    await api.del(`/upstreams/${id}`);
    load();
  }

  return (
    <>
      {notice && <div className={`note ${notice.bad ? 'bad' : 'info'}`}>{notice.text}</div>}

      <Panel title="add upstream">
        <div className="form-grid">
          <Field label="preset" hint="fills the fields below">
            <select value={form.preset} onChange={(e) => choosePreset(e.target.value)}>
              <option value="">custom</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="name">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Gemini Web" />
          </Field>
          <Field label="kind">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="web">web</option>
              <option value="cli">cli</option>
              <option value="api">api</option>
            </select>
          </Field>
          <Field label="adapter">
            <select value={form.adapter} onChange={(e) => setForm({ ...form, adapter: e.target.value })}>
              <option value="openai-http">openai-http</option>
              <option value="cli-spawn">cli-spawn</option>
            </select>
          </Field>
          <Field label="base url" hint="…/v1 of the connector or API">
            <input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="http://127.0.0.1:8081/v1" />
          </Field>
          <Field label="api key">
            <input value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder="sk-…" />
          </Field>
          <Field label="cookie" hint="web sessions">
            <input value={form.cookie} onChange={(e) => setForm({ ...form, cookie: e.target.value })} placeholder="__Secure-1PSID=…" />
          </Field>
          <Field label="models" hint="comma separated">
            <input value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} placeholder="gemini-2.5-pro, gemini-2.5-flash" />
          </Field>
          <Field label="weight">
            <input type="number" value={form.weight} onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })} />
          </Field>
          <Field label="cost / 1k">
            <input type="number" step="0.01" value={form.cost_per_1k} onChange={(e) => setForm({ ...form, cost_per_1k: Number(e.target.value) })} />
          </Field>
          <Field label="max rpm" hint="0 = unlimited">
            <input type="number" value={form.max_rpm} onChange={(e) => setForm({ ...form, max_rpm: Number(e.target.value) })} />
          </Field>
          <Field label="max rpd">
            <input type="number" value={form.max_rpd} onChange={(e) => setForm({ ...form, max_rpd: Number(e.target.value) })} />
          </Field>
          <Field label="session reset">
            <select value={form.reset_mode} onChange={(e) => setForm({ ...form, reset_mode: e.target.value })}>
              <option value="none">none</option>
              <option value="cookie_reset">cookie reset</option>
            </select>
          </Field>
          {form.adapter === 'cli-spawn' && (
            <Field label="cli command" hint="$COMB_PROMPT and $COMB_MODEL are set">
              <input
                value={form.cli_command ?? ''}
                onChange={(e) => setForm({ ...form, cli_command: e.target.value })}
                placeholder='gemini -p "$COMB_PROMPT"'
              />
            </Field>
          )}
        </div>
        <div style={{ marginTop: 10 }}>
          <Button variant="primary" onClick={create} disabled={!form.name}>
            add upstream
          </Button>
        </div>
      </Panel>

      <Panel title="upstreams" actions={<span className="tiny muted">{upstreams.length} configured</span>}>
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>name</th>
                <th>endpoint</th>
                <th>models</th>
                <th>state</th>
                <th style={{ width: 330 }}>actions</th>
              </tr>
            </thead>
            <tbody>
              {upstreams.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div>
                      {u.name} {u.plugin_id ? <Badge tone="blue">{u.kind}</Badge> : null}
                    </div>
                    <div className="tiny muted">
                      {u.adapter} · weight {u.weight} · {u.cost_per_1k}/1k
                      {u.max_rpm ? ` · ${u.max_rpm} rpm` : ''}
                    </div>
                    {open === u.id && (
                      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div className="form-grid">
                          <Field label="base url">
                            <input
                              defaultValue={u.base_url ?? ''}
                              onChange={(e) => setEdit((s) => ({ ...s, [u.id]: { ...s[u.id], base_url: e.target.value } }))}
                            />
                          </Field>
                          <Field label="api key" hint={u.api_key ? `stored ${u.api_key}` : 'none'}>
                            <input
                              placeholder="replace key"
                              onChange={(e) => setEdit((s) => ({ ...s, [u.id]: { ...s[u.id], api_key: e.target.value } }))}
                            />
                          </Field>
                          <Field label="cookie" hint={u.cookie ? `stored ${u.cookie}` : 'none'}>
                            <input
                              placeholder="replace cookie"
                              onChange={(e) => setEdit((s) => ({ ...s, [u.id]: { ...s[u.id], cookie: e.target.value } }))}
                            />
                          </Field>
                          <Field label="status">
                            <select
                              defaultValue={u.status}
                              onChange={(e) => setEdit((s) => ({ ...s, [u.id]: { ...s[u.id], status: e.target.value } }))}
                            >
                              <option value="active">active</option>
                              <option value="disabled">disabled</option>
                            </select>
                          </Field>
                          <Field label="weight">
                            <input
                              type="number"
                              defaultValue={u.weight}
                              onChange={(e) => setEdit((s) => ({ ...s, [u.id]: { ...s[u.id], weight: Number(e.target.value) } }))}
                            />
                          </Field>
                          <Field label="cost / 1k">
                            <input
                              type="number"
                              step="0.01"
                              defaultValue={u.cost_per_1k}
                              onChange={(e) => setEdit((s) => ({ ...s, [u.id]: { ...s[u.id], cost_per_1k: Number(e.target.value) } }))}
                            />
                          </Field>
                          <Field label="max rpm">
                            <input
                              type="number"
                              defaultValue={u.max_rpm}
                              onChange={(e) => setEdit((s) => ({ ...s, [u.id]: { ...s[u.id], max_rpm: Number(e.target.value) } }))}
                            />
                          </Field>
                          <Field label="reset mode">
                            <select
                              defaultValue={u.reset_mode}
                              onChange={(e) => setEdit((s) => ({ ...s, [u.id]: { ...s[u.id], reset_mode: e.target.value } }))}
                            >
                              <option value="none">none</option>
                              <option value="cookie_reset">cookie reset</option>
                            </select>
                          </Field>
                        </div>
                        <div className="inline">
                          <Button onClick={() => save(u.id)}>save changes</Button>
                          <Button variant="danger" onClick={() => remove(u.id)}>
                            delete upstream
                          </Button>
                        </div>
                        <div className="tiny muted">
                          models: {u.models.length ? u.models.map((m: any) => m.id).join(', ') : 'none discovered yet'}
                        </div>
                        {u.plugin && (
                          <div className="tiny muted">
                            connector: {u.plugin.name} · {u.plugin.status}
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="tiny mono-cell">{u.base_url ?? '—'}</td>
                  <td className="num">{u.models.length}</td>
                  <td>
                    <Badge tone={u.status === 'active' ? 'ok' : 'idle'}>{u.status}</Badge>
                    {u.session_reset_at && <div className="tiny muted">reset {u.session_reset_at.slice(11, 19)}</div>}
                  </td>
                  <td>
                    <div className="inline">
                      <Button onClick={() => discover(u.id)}>discover</Button>
                      <Button onClick={() => test(u.id)}>test</Button>
                      {u.reset_mode === 'cookie_reset' && (
                        <Button variant="ghost" onClick={() => reset(u.id)} title="drop the cookie jar for a fresh guest session">
                          reset session
                        </Button>
                      )}
                      <Button variant="ghost" onClick={() => setOpen(open === u.id ? null : u.id)}>
                        {open === u.id ? 'close' : 'edit'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!upstreams.length && <Empty>No upstreams. Add one above, or run the setup wizard.</Empty>}
        </div>
      </Panel>
    </>
  );
}
