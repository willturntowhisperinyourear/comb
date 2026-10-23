import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Badge, Button, Field, Panel } from '../ui.tsx';

const STRATEGIES = [
  'priority',
  'weighted',
  'round_robin',
  'least_used',
  'fastest',
  'cheapest',
  'quota_headroom',
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/settings').then(setSettings).catch((e) => setError(e.message));
  }, []);

  const set = (k: string, v: string) => setSettings((s) => ({ ...s, [k]: v }));

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
