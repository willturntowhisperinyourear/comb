import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { all, createApiKey, get, nowIso, run, setting, setSetting } from './db.ts';
import { PROVIDER_PRESETS } from './catalog.ts';
import {
  discoverModels,
  installPlugin,
  pluginById,
  pluginLog,
  recalibrateModel,
  runningPlugins,
  startPlugin,
  stopPlugin,
  testModel,
} from './plugins.ts';
import { playgroundChat } from './proxy.ts';
import { modelById, STRATEGIES } from './router.ts';
import type { AdapterKind, AuthMode, Strategy } from '../shared/types.ts';

export const api = Router();

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'upstream';

const bool = (v: unknown) => (v ? 1 : 0);
const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

api.get('/presets', (_req, res) => {
  res.json({ presets: PROVIDER_PRESETS, strategies: STRATEGIES });
});

api.get('/overview', (_req, res) => {
  const dayAgo = Date.now() - 86_400_000;
  const totals = get<any>(
    `select count(*) requests, coalesce(sum(ok),0) ok,
            coalesce(avg(latency_ms),0) avg_latency,
            coalesce(sum(tokens_in + tokens_out),0) tokens
       from usage where ts > ?`,
    dayAgo,
  );
  const models = all<any>(
    `select m.id, m.tools_mode, m.tool_variant, m.enabled, u.name upstream, u.kind,
            coalesce((select count(*) from usage x where x.model = m.id and x.ts > ?), 0) requests,
            coalesce((select sum(ok) from usage x where x.model = m.id and x.ts > ?), 0) ok,
            coalesce((select avg(latency_ms) from usage x where x.model = m.id and x.ts > ?), 0) latency,
            (select until_ms from cooldowns c where c.model_id = m.id) cooldown_until
       from models m join upstreams u on u.id = m.upstream_id
       order by requests desc, m.id`,
    dayAgo,
    dayAgo,
    dayAgo,
  );
  const hourly = all<any>(
    `select strftime('%H', ts / 1000, 'unixepoch') hour, count(*) n, coalesce(sum(ok),0) ok
       from usage where ts > ? group by hour order by hour`,
    dayAgo,
  );
  const upstreams = all<any>('select id, name, kind, status from upstreams');
  res.json({
    totals: {
      requests: Number(totals?.requests ?? 0),
      ok: Number(totals?.ok ?? 0),
      avg_latency: Math.round(Number(totals?.avg_latency ?? 0)),
      tokens: Number(totals?.tokens ?? 0),
    },
    models,
    hourly,
    counts: {
      upstreams: upstreams.length,
      active_upstreams: upstreams.filter((u) => u.status === 'active').length,
      models: models.length,
      emulated: models.filter((m) => m.tools_mode === 'emulate').length,
      chains: Number(get<any>('select count(*) n from chains where enabled = 1')?.n ?? 0),
      running_plugins: runningPlugins().length,
    },
    instance: { data_dir: process.env.COMB_DATA ?? 'data', version: '0.1.0' },
  });
});

// ---------------------------------------------------------------- upstreams

function createUpstream(input: any) {
  const preset = PROVIDER_PRESETS.find((p) => p.id === input.preset);
  const id = randomUUID();
  const name = String(input.name ?? preset?.name ?? 'Upstream').trim();
  const adapter: AdapterKind = (input.adapter ?? preset?.adapter ?? 'openai-http') as AdapterKind;
  const auth_mode: AuthMode = (input.auth_mode ?? preset?.auth_mode ?? 'none') as AuthMode;
  const base_url = input.base_url ?? preset?.base_url ?? null;
  const config =
    typeof input.config === 'string'
      ? input.config
      : JSON.stringify({
          ...(input.config ?? {}),
          ...(preset?.cli_command ? { cli_command: preset.cli_command } : {}),
        });

  run(
    `insert into upstreams(id, name, preset, kind, plugin_id, adapter, base_url, api_key, cookie, headers,
       auth_mode, status, weight, cost_per_1k, max_rpm, max_rpd, reset_mode, config, created_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    name,
    input.preset ?? preset?.id ?? null,
    input.kind ?? preset?.kind ?? 'api',
    input.plugin_id ?? preset?.plugin_id ?? null,
    adapter,
    base_url,
    input.api_key ?? null,
    input.cookie ?? null,
    typeof input.headers === 'string' ? input.headers : JSON.stringify(input.headers ?? {}),
    auth_mode,
    'active',
    num(input.weight, 1),
    num(input.cost_per_1k, preset?.cost_per_1k ?? 0),
    num(input.max_rpm, 0),
    num(input.max_rpd, 0),
    input.reset_mode ?? preset?.reset_mode ?? 'none',
    config,
    nowIso(),
  );

  const modelNames: string[] = Array.isArray(input.models) && input.models.length
    ? input.models.map((m: any) => String(m?.name ?? m))
    : (preset?.models ?? []);
  const slug = slugify(name);
  const created: string[] = [];
  for (const raw of modelNames) {
    // Same normalisation as addModels: accept a full id, reject whitespace.
    const modelName = String(raw).trim().replace(new RegExp(`^${slug}/`), '');
    if (!modelName || /\s/.test(modelName)) continue;
    const modelId = `${slug}/${modelName}`;
    if (created.includes(modelId)) continue;
    run(
      `insert into models(id, upstream_id, upstream_model, display_name, context_window, tools_mode, tool_variant, caps, created_at)
       values(?,?,?,?,?,?,?,?,?) on conflict(id) do nothing`,
      modelId,
      id,
      modelName,
      modelName,
      128000,
      input.tools_mode ?? preset?.tools_mode ?? 'emulate',
      setting('default_tool_variant', 'xml'),
      '{}',
      nowIso(),
    );
    created.push(modelId);
  }
  return { id, models: created };
}

api.get('/upstreams', (_req, res) => {
  const rows = all<any>('select * from upstreams order by created_at');
  res.json(
    rows.map((u) => ({
      ...u,
      api_key: u.api_key ? '••••' + String(u.api_key).slice(-4) : null,
      cookie: u.cookie ? '••••' + String(u.cookie).slice(-6) : null,
      models: all<any>('select * from models where upstream_id = ? order by id', u.id),
      plugin: u.plugin_id ? pluginById(u.plugin_id) : null,
    })),
  );
});

api.post('/upstreams', (req, res) => {
  const created = createUpstream(req.body ?? {});
  res.status(201).json(created);
});

api.patch('/upstreams/:id', (req, res) => {
  const current = get<any>('select * from upstreams where id = ?', req.params.id);
  if (!current) return res.status(404).json({ error: 'upstream not found' });
  const b = req.body ?? {};
  const fields: Record<string, unknown> = {};
  for (const key of [
    'name', 'kind', 'adapter', 'base_url', 'auth_mode', 'status', 'weight', 'cost_per_1k',
    'max_rpm', 'max_rpd', 'reset_mode', 'plugin_id', 'headers', 'config',
  ]) {
    if (b[key] !== undefined) fields[key] = b[key];
  }
  // Secrets are only replaced when a new value is sent, never by the masked list.
  if (typeof b.api_key === 'string' && !b.api_key.startsWith('••••')) fields.api_key = b.api_key;
  if (typeof b.cookie === 'string' && !b.cookie.startsWith('••••')) fields.cookie = b.cookie;
  if (b.api_key === null) fields.api_key = null;
  if (b.cookie === null) fields.cookie = null;

  const keys = Object.keys(fields);
  if (keys.length) {
    run(
      `update upstreams set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`,
      ...keys.map((k) => fields[k] as string | number | null),
      req.params.id,
    );
  }
  res.json({ ok: true });
});

api.delete('/upstreams/:id', (req, res) => {
  run('delete from upstreams where id = ?', req.params.id);
  res.json({ ok: true });
});

api.post('/upstreams/:id/discover', async (req, res) => {
  const result = await discoverModels(req.params.id);
  res.status(result.error ? 502 : 200).json(result);
});

api.post('/upstreams/:id/test', async (req, res) => {
  const models = all<any>('select id from models where upstream_id = ? limit 1', req.params.id);
  if (!models.length) return res.status(400).json({ error: 'upstream has no models yet; discover them first' });
  res.json(await testModel(models[0].id, String(req.body?.prompt ?? 'Say hello in five words.')));
});

/**
 * Providers such as chat.qwen.ai hand a guest session its own quota. Dropping
 * the cookie jar makes the connector mint a fresh session on the next call.
 */
api.post('/upstreams/:id/reset-session', (req, res) => {
  const up = get<any>('select * from upstreams where id = ?', req.params.id);
  if (!up) return res.status(404).json({ error: 'upstream not found' });
  if (up.reset_mode !== 'cookie_reset') {
    return res.status(400).json({ error: 'this upstream is not configured for cookie reset' });
  }
  run('update upstreams set cookie = null, session_reset_at = ? where id = ?', nowIso(), up.id);
  run(
    'update cooldowns set failures = 0, until_ms = 0, reason = null where model_id in (select id from models where upstream_id = ?)',
    up.id,
  );
  res.json({
    ok: true,
    message: 'session cookie cleared and cooldowns reset. The connector starts a fresh guest session on the next request.',
  });
});

// ------------------------------------------------------------------- models

api.get('/models', (_req, res) => {
  res.json(
    all<any>(
      `select m.*, u.name upstream, u.kind, u.status upstream_status, u.base_url
         from models m join upstreams u on u.id = m.upstream_id order by u.name, m.id`,
    ),
  );
});

/**
 * Adds model ids by hand. Connectors lag behind the provider: a web2api repo
 * may still list last quarter's ids, while the web app already serves a new
 * one. Nothing upstream has to know the model name, so the operator can just
 * type it in and comb will route to it.
 */
export function addModels(upstreamId: string, names: unknown, toolsMode?: string) {
  const up = get<any>('select * from upstreams where id = ?', upstreamId);
  if (!up) return { created: [] as string[], existing: [] as string[], invalid: [] as string[], error: 'upstream not found' };
  const slug = slugify(up.name);
  const mode = ['native', 'emulate', 'off'].includes(String(toolsMode))
    ? String(toolsMode)
    : up.kind === 'api'
      ? 'native'
      : 'emulate';
  const created: string[] = [];
  const existing: string[] = [];
  const invalid: string[] = [];

  const list = Array.isArray(names) ? names : [names];
  for (const raw of list) {
    const name = String(raw ?? '').trim().replace(new RegExp(`^${slug}/`), '');
    if (!name || /\s/.test(name)) {
      if (String(raw ?? '').trim()) invalid.push(String(raw));
      continue;
    }
    const id = `${slug}/${name}`;
    if (modelById(id)) {
      if (!existing.includes(id)) existing.push(id);
      continue;
    }
    run(
      `insert into models(id, upstream_id, upstream_model, display_name, context_window, tools_mode, tool_variant, caps, created_at)
       values(?,?,?,?,?,?,?,?,?)`,
      id,
      up.id,
      name,
      name,
      128000,
      mode,
      setting('default_tool_variant', 'xml'),
      JSON.stringify({ added_manually: true }),
      nowIso(),
    );
    created.push(id);
  }
  return { created, existing, invalid };
}

api.post('/models', (req, res) => {
  const b = req.body ?? {};
  const names = b.names ?? b.name;
  if (!b.upstream_id) return res.status(400).json({ error: 'upstream_id is required' });
  if (!names || (Array.isArray(names) && !names.length)) return res.status(400).json({ error: 'names is required' });
  const result = addModels(b.upstream_id, names, b.tools_mode);
  if (result.error) return res.status(404).json({ error: result.error });
  res.status(201).json(result);
});

api.patch('/models/:id', (req, res) => {
  const b = req.body ?? {};
  const fields: Record<string, unknown> = {};
  if (['native', 'emulate', 'off'].includes(b.tools_mode)) fields.tools_mode = b.tools_mode;
  if (['xml', 'fence', 'json'].includes(b.tool_variant)) fields.tool_variant = b.tool_variant;
  if (b.enabled !== undefined) fields.enabled = bool(b.enabled);
  if (b.context_window !== undefined) fields.context_window = num(b.context_window, 128000);
  if (b.display_name !== undefined) fields.display_name = b.display_name;
  const keys = Object.keys(fields);
  if (!keys.length) return res.json({ ok: true });
  run(
    `update models set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`,
    ...keys.map((k) => fields[k] as string | number | null),
    req.params.id,
  );
  res.json({ ok: true });
});

api.delete('/models/:id', (req, res) => {
  run('delete from models where id = ?', req.params.id);
  res.json({ ok: true });
});

api.post('/models/:id/recalibrate', async (req, res) => {
  const report = await recalibrateModel(req.params.id);
  res.json(report);
});

api.post('/models/:id/test', async (req, res) => {
  res.json(await testModel(req.params.id, String(req.body?.prompt ?? 'Say hello in five words.')));
});

// ------------------------------------------------------------------- chains

api.get('/chains', (_req, res) => {
  res.json(all<any>('select * from chains order by created_at'));
});

api.post('/chains', (req, res) => {
  const b = req.body ?? {};
  const name = String(b.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (get('select id from chains where name = ?', name)) {
    return res.status(409).json({ error: 'a chain with that name exists' });
  }
  const strategy: Strategy = STRATEGIES.includes(b.strategy) ? b.strategy : 'priority';
  const id = randomUUID();
  run(
    'insert into chains(id, name, strategy, members, description, enabled, created_at) values(?,?,?,?,?,?,?)',
    id,
    name,
    strategy,
    JSON.stringify(Array.isArray(b.members) ? b.members : []),
    b.description ?? null,
    1,
    nowIso(),
  );
  res.status(201).json({ id });
});

api.patch('/chains/:id', (req, res) => {
  const b = req.body ?? {};
  const fields: Record<string, unknown> = {};
  if (b.name !== undefined) fields.name = b.name;
  if (b.strategy !== undefined && STRATEGIES.includes(b.strategy)) fields.strategy = b.strategy;
  if (b.members !== undefined) fields.members = JSON.stringify(b.members);
  if (b.description !== undefined) fields.description = b.description;
  if (b.enabled !== undefined) fields.enabled = bool(b.enabled);
  const keys = Object.keys(fields);
  if (!keys.length) return res.json({ ok: true });
  run(
    `update chains set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`,
    ...keys.map((k) => fields[k] as string | number | null),
    req.params.id,
  );
  res.json({ ok: true });
});

api.delete('/chains/:id', (req, res) => {
  run('delete from chains where id = ?', req.params.id);
  res.json({ ok: true });
});

// --------------------------------------------------------------------- keys

api.get('/keys', (_req, res) => {
  res.json(
    all<any>(
      `select k.id, k.name, k.prefix, k.rpm, k.rpd, k.created_at, k.revoked, k.last_used_at,
              coalesce((select count(*) from usage u where u.key_id = k.id), 0) requests
         from api_keys k order by k.created_at`,
    ),
  );
});

api.post('/keys', (req, res) => {
  const name = String(req.body?.name ?? 'client').trim() || 'client';
  const key = createApiKey(name, num(req.body?.rpm, 0), num(req.body?.rpd, 0));
  res.status(201).json(key);
});

api.delete('/keys/:id', (req, res) => {
  run('update api_keys set revoked = 1 where id = ?', req.params.id);
  res.json({ ok: true });
});

api.get('/bootstrap-key', (_req, res) => {
  res.json({ key: setting('bootstrap_api_key', '') });
});

// ------------------------------------------------------------------ plugins

api.get('/plugins', (_req, res) => {
  res.json(
    all<any>('select * from plugins order by kind, name').map((p) => ({
      ...p,
      running: runningPlugins().includes(p.id),
    })),
  );
});

api.post('/plugins/:id/install', (req, res) => {
  const plugin = installPlugin(req.params.id);
  if (!plugin) return res.status(404).json({ error: 'plugin not found' });
  res.json(plugin);
});

api.post('/plugins/:id/start', async (req, res) => {
  const plugin = await startPlugin(req.params.id);
  if (!plugin) return res.status(404).json({ error: 'plugin not found' });
  res.json(plugin);
});

api.post('/plugins/:id/stop', (req, res) => {
  const plugin = stopPlugin(req.params.id);
  if (!plugin) return res.status(404).json({ error: 'plugin not found' });
  res.json(plugin);
});

api.get('/plugins/:id/log', (req, res) => {
  res.json({ log: pluginLog(req.params.id, 200) });
});

api.patch('/plugins/:id', (req, res) => {
  const b = req.body ?? {};
  const fields: Record<string, unknown> = {};
  for (const key of ['name', 'repo', 'description', 'port', 'base_path', 'auth_hint', 'install_cmd', 'run_cmd', 'kind']) {
    if (b[key] !== undefined) fields[key] = b[key];
  }
  const keys = Object.keys(fields);
  if (!keys.length) return res.json({ ok: true });
  run(
    `update plugins set ${keys.map((k) => `${k} = ?`).join(', ')}, status = 'not_installed' where id = ?`,
    ...keys.map((k) => fields[k] as string | number | null),
    req.params.id,
  );
  res.json({ ok: true });
});

api.post('/plugins', (req, res) => {
  const b = req.body ?? {};
  if (!b.id || !b.repo) return res.status(400).json({ error: 'id and repo are required' });
  run(
    `insert into plugins(id, name, kind, repo, description, port, base_path, auth_hint, install_cmd, run_cmd, updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?)`,
    String(b.id),
    String(b.name ?? b.id),
    String(b.kind ?? 'web2api'),
    String(b.repo),
    String(b.description ?? ''),
    b.port ? num(b.port, 0) : null,
    String(b.base_path ?? '/v1'),
    String(b.auth_hint ?? ''),
    String(b.install_cmd ?? ''),
    String(b.run_cmd ?? ''),
    nowIso(),
  );
  res.status(201).json({ ok: true });
});

// -------------------------------------------------------------------- usage

api.get('/usage', (req, res) => {
  const range = String(req.query.range ?? '24h');
  const hours = range === '7d' ? 168 : range === '30d' ? 720 : 24;
  const since = Date.now() - hours * 3_600_000;
  const byModel = all<any>(
    `select model, count(*) requests, coalesce(sum(ok),0) ok,
            coalesce(avg(latency_ms),0) latency, coalesce(sum(tokens_in+tokens_out),0) tokens
       from usage where ts > ? group by model order by requests desc limit 40`,
    since,
  );
  const byHour = all<any>(
    `select strftime('%Y-%m-%dT%H', ts / 1000, 'unixepoch') bucket, count(*) requests, coalesce(sum(ok),0) ok
       from usage where ts > ? group by bucket order by bucket`,
    since,
  );
  const byStatus = all<any>(
    'select status, count(*) n from usage where ts > ? group by status order by n desc',
    since,
  );
  res.json({ range, byModel, byHour, byStatus });
});

api.get('/logs', (req, res) => {
  const limit = Math.min(num(req.query.limit, 100), 500);
  res.json(all<any>('select * from usage order by ts desc limit ?', limit));
});

// ----------------------------------------------------------------- settings

const EDITABLE_SETTINGS = new Set([
  'strategy', 'max_attempts', 'cooldown_base_ms', 'request_timeout_ms', 'default_tool_variant', 'allow_anonymous',
]);

api.get('/settings', (_req, res) => {
  res.json(Object.fromEntries(all<any>('select key, value from settings').map((r) => [r.key, r.value])));
});

api.patch('/settings', (req, res) => {
  for (const [key, value] of Object.entries(req.body ?? {})) {
    if (!EDITABLE_SETTINGS.has(key)) continue;
    if (key === 'default_tool_variant' && !['xml', 'fence', 'json'].includes(String(value))) continue;
    setSetting(key, String(value));
  }
  res.json({ ok: true });
});

api.post('/playground', async (req, res) => {
  const body = req.body ?? {};
  if (!body.model || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: 'model and messages are required' });
  }
  const outcome = await playgroundChat({
    model: body.model,
    messages: body.messages,
    tools: body.tools,
    tool_choice: body.tool_choice,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    stream: false,
  });
  res.status(outcome.status).json(outcome.body);
});

api.post('/setup', async (req, res) => {
  const install: string[] = Array.isArray(req.body?.install) ? req.body.install : [];
  const create: string[] = Array.isArray(req.body?.create) ? req.body.create : [];
  // Extra ids per preset: connectors often ship an older model list than the
  // provider actually serves today.
  const extras = (req.body?.models ?? {}) as Record<string, unknown>;
  const plugins = install.map((id) => installPlugin(id)).filter(Boolean);
  const upstreams: any[] = [];
  for (const presetId of create) {
    const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
    if (!preset) continue;
    const exists = get<any>('select id from upstreams where name = ?', preset.name);
    if (exists) continue;
    const extra = Array.isArray(extras[presetId]) ? (extras[presetId] as unknown[]).map(String) : [];
    const models = [...preset.models, ...extra].filter((m, i, list) => m && list.indexOf(m) === i);
    upstreams.push({ preset: preset.id, ...createUpstream({ preset: preset.id, models }) });
  }
  res.json({
    installed: plugins.map((p: any) => ({ id: p.id, status: p.status })),
    upstreams,
    next: [
      'start each installed connector',
      'discover models from the connector',
      'run tool recalibration so emulated tool calls match what the model really emits',
    ],
  });
});

api.get('/setup/status', (_req, res) => {
  const upstreams = all<any>('select id, name, status from upstreams');
  const models = all<any>('select id, tools_mode from models');
  const plugins = all<any>('select id, status from plugins');
  res.json({
    has_upstream: upstreams.length > 0,
    upstreams: upstreams.length,
    models: models.length,
    emulated: models.filter((m) => m.tools_mode === 'emulate').length,
    installed_plugins: plugins.filter((p) => p.status !== 'not_installed').length,
    running_plugins: plugins.filter((p) => p.status === 'running').length,
    tool_variants: [...new Set(models.filter((m) => m.tools_mode === 'emulate').map((m: any) => m.tool_variant))],
  });
});

