import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { Badge, Button, Field, Panel } from './ui.tsx';

type Config = { auto_enabled: boolean; base_url: string; model: string; api_key_set: boolean };

export default function DoctorSettings() {
  const [config, setConfig] = useState<Config | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = () => api.get<Config>('/doctor/config').then(setConfig).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function save(test = false) {
    if (!config) return;
    setBusy(true); setError(''); setNotice('');
    try {
      setConfig(await api.patch<Config>('/doctor/config', { ...config, ...(key ? { api_key: key } : {}) }));
      setKey('');
      if (test) {
        const result = await api.post('/doctor/model/test');
        setNotice(`Model responded: ${result.advice.summary}`);
      } else setNotice('Doctor settings saved.');
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function clearKey() {
    setBusy(true); setError(''); setNotice('');
    try { setConfig(await api.patch<Config>('/doctor/config', { api_key: '' })); setKey(''); setNotice('API key cleared.'); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  return <Panel title="connector doctor" actions={<Badge tone={config?.auto_enabled ? 'ok' : 'idle'}>{config?.auto_enabled ? 'automatic' : 'manual'}</Badge>}>
    <p>Checks startup, live model discovery, normal chat and streaming chat. Supported repairs fix local URLs, missing upstreams, catalog commands, dependencies and stopped processes, then repeat the response tests.</p>
    <p>An optional model can explain harder failures. Configure a separate working OpenAI-compatible model endpoint; it receives redacted connector diagnostics and logs. Repairs use the built-in actions, not model-generated shell commands.</p>
    {error && <div className="note bad" role="alert">{error}</div>}
    {notice && <div className="note" role="status">{notice}</div>}
    {!config ? <div className="note">{error ? <Button onClick={load}>retry loading doctor settings</Button> : 'Loading doctor settings...'}</div> : <>
      <div className="form-grid">
        <Field label="automatic diagnosis and repair" hint="runs after failures; at most one pass per connector every 30 minutes">
          <select value={config.auto_enabled ? 'on' : 'off'} onChange={(e) => setConfig({ ...config, auto_enabled: e.target.value === 'on' })} disabled={busy}>
            <option value="off">off</option><option value="on">on</option>
          </select>
        </Field>
        <Field label="doctor model base URL" hint="optional; built-in checks also work without a model">
          <input value={config.base_url} placeholder="http://127.0.0.1:1234/v1" onChange={(e) => setConfig({ ...config, base_url: e.target.value })} disabled={busy} />
        </Field>
        <Field label="doctor model id"><input value={config.model} placeholder="your installed model id" onChange={(e) => setConfig({ ...config, model: e.target.value })} disabled={busy} /></Field>
        <Field label="doctor model API key" hint={config.api_key_set ? 'key is stored; leave blank to keep it' : 'optional for local endpoints'}>
          <input type="password" autoComplete="new-password" value={key} onChange={(e) => setKey(e.target.value)} disabled={busy} />
        </Field>
      </div>
      <div className="inline" style={{ marginTop: 12 }}>
        <Button variant="primary" onClick={() => save()} disabled={busy}>save doctor settings</Button>
        <Button onClick={() => save(true)} disabled={busy || !config.base_url || !config.model}>{busy ? 'working...' : 'save and test model'}</Button>
        <Button onClick={clearKey} disabled={busy || !config.api_key_set}>clear API key</Button>
      </div>
    </>}
  </Panel>;
}
