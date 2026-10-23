import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Badge, Button, Empty, Field, Panel } from '../ui.tsx';

const STRATEGIES = [
  ['priority', 'priority — first member that answers wins'],
  ['weighted', 'weighted — random by upstream weight'],
  ['round_robin', 'round robin — rotate across members'],
  ['least_used', 'least used — fewest requests in 24h'],
  ['fastest', 'fastest — lowest average latency'],
  ['cheapest', 'cheapest — lowest cost per 1k'],
  ['quota_headroom', 'quota headroom — most rate limit left'],
];

export default function RoutingPage() {
  const [chains, setChains] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [drafts, setDrafts] = useState<Record<string, any>>({});
  const [form, setForm] = useState({ name: '', strategy: 'priority', description: '' });
  const [error, setError] = useState('');

  const load = () => {
    api.get('/chains').then(setChains).catch((e) => setError(e.message));
    api.get('/models').then(setModels).catch(() => {});
  };
  useEffect(() => {
    load();
  }, []);

  const members = (chain: any): string[] => {
    try {
      return JSON.parse(chain.members || '[]');
    } catch {
      return [];
    }
  };

  const draft = (chain: any) => {
    const d = drafts[chain.id];
    if (d) return d;
    return { members: members(chain), strategy: chain.strategy, name: chain.name };
  };

  const setDraft = (chain: any, patch: Record<string, any>) =>
    setDrafts((d) => ({ ...d, [chain.id]: { ...draft(chain), ...patch } }));

  async function create() {
    setError('');
    const name = form.name.trim();
    if (!name) return setError('give the chain a name');
    if (name === 'auto') return setError('"auto" is reserved for the router automatic ranking');
    if (models.some((m) => m.id === name)) return setError(`a model already uses the id "${name}"`);
    if (chains.some((c) => c.name === name)) return setError('a chain with that name exists');
    await api.post('/chains', { ...form, name }).catch((e) => setError(e.message));
    setForm({ name: '', strategy: 'priority', description: '' });
    load();
  }

  async function save(chain: any) {
    const d = draft(chain);
    await api
      .patch(`/chains/${chain.id}`, { members: d.members, strategy: d.strategy, name: d.name })
      .catch((e) => setError(e.message));
    setDrafts((s) => {
      const next = { ...s };
      delete next[chain.id];
      return next;
    });
    load();
  }

  async function remove(chain: any) {
    await api.del(`/chains/${chain.id}`);
    load();
  }

  function move(chain: any, index: number, delta: number) {
    const list = [...draft(chain).members];
    const next = index + delta;
    if (next < 0 || next >= list.length) return;
    [list[index], list[next]] = [list[next], list[index]];
    setDraft(chain, { members: list });
  }

  function addMember(chain: any, modelId: string) {
    if (!modelId) return;
    const list = [...draft(chain).members, modelId];
    setDraft(chain, { members: list });
  }

  const modelId = (m: any) => m.id;

  return (
    <>
      {error && <div className="note bad">{error}</div>}
      <div className="note info">
        A chain is a model id clients can call. Requests walk the member list using the strategy, failing over on
        errors, rate limits and cooldowns. Call it as <code>model: "&lt;chain name&gt;"</code>, or use{' '}
        <code>auto</code> to rank every enabled model by health. Names <code>auto</code> and existing model ids are
        reserved.
      </div>

      <Panel title="new chain">
        <div className="form-row">
          <Field label="name">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="daily" />
          </Field>
          <Field label="strategy">
            <select value={form.strategy} onChange={(e) => setForm({ ...form, strategy: e.target.value })}>
              {STRATEGIES.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="description">
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="free tier first" />
          </Field>
          <Button variant="primary" onClick={create}>
            create
          </Button>
        </div>
      </Panel>

      {chains.map((chain) => {
        const d = draft(chain);
        const dirty = !!drafts[chain.id];
        return (
          <Panel
            key={chain.id}
            title={
              <span>
                {chain.name} <span className="tiny muted">· {d.members.length} members</span>{' '}
                {dirty && <Badge tone="warn">unsaved</Badge>}
              </span>
            }
            actions={
              <>
                {dirty && (
                  <Button variant="primary" onClick={() => save(chain)}>
                    save
                  </Button>
                )}
                <Button variant="danger" onClick={() => remove(chain)}>
                  delete
                </Button>
              </>
            }
          >
            <div className="form-row" style={{ marginBottom: 10 }}>
              <Field label="strategy">
                <select value={d.strategy} onChange={(e) => setDraft(chain, { strategy: e.target.value })}>
                  {STRATEGIES.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="add model">
                <select value="" onChange={(e) => addMember(chain, e.target.value)}>
                  <option value="">pick a model…</option>
                  {models
                    .filter((m) => !d.members.includes(modelId(m)))
                    .map((m) => (
                      <option key={m.id} value={modelId(m)}>
                        {m.id} ({m.tools_mode})
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="description">
                <input
                  defaultValue={chain.description ?? ''}
                  onBlur={(e) => api.patch(`/chains/${chain.id}`, { description: e.target.value }).then(load)}
                />
              </Field>
            </div>

            {d.members.length ? (
              <div>
                {d.members.map((id: string, i: number) => {
                  const model = models.find((m) => m.id === id);
                  return (
                    <div className="member" key={`${id}-${i}`}>
                      <span className="member-idx">{String(i + 1).padStart(2, '0')}</span>
                      <span>
                        <span className="mono-cell">{id}</span>{' '}
                        {model ? (
                          <Badge tone={model.tools_mode === 'native' ? 'blue' : model.tools_mode === 'emulate' ? 'ok' : 'idle'}>
                            {model.tools_mode}
                          </Badge>
                        ) : (
                          <Badge tone="bad">missing</Badge>
                        )}
                      </span>
                      <span className="inline">
                        <Button variant="ghost" onClick={() => move(chain, i, -1)}>
                          ↑
                        </Button>
                        <Button variant="ghost" onClick={() => move(chain, i, 1)}>
                          ↓
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            setDraft(chain, { members: d.members.filter((_x: string, j: number) => j !== i) })
                          }
                        >
                          ×
                        </Button>
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Empty>No members. Add one above; an empty chain returns model_not_found.</Empty>
            )}
          </Panel>
        );
      })}

      {!chains.length && (
        <Empty>
          No chains yet. Clients can already call individual model ids; a chain adds ordered failover and a friendly
          name.
        </Empty>
      )}
    </>
  );
}
