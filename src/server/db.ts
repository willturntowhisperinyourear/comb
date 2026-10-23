import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { PLUGIN_CATALOG } from './catalog.ts';

export const DATA_DIR = process.env.COMB_DATA ?? join(process.cwd(), 'data');
export const PLUGIN_DIR = join(DATA_DIR, 'plugins');
mkdirSync(PLUGIN_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'comb.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
create table if not exists settings (
  key text primary key,
  value text not null
);

create table if not exists plugins (
  id text primary key,
  name text not null,
  kind text not null,
  repo text not null,
  description text not null default '',
  port integer,
  base_path text not null default '/v1',
  auth_hint text not null default '',
  install_cmd text not null default '',
  run_cmd text not null default '',
  models_hint text not null default '[]',
  tools_hint text not null default 'native',
  status text not null default 'not_installed',
  dir text not null default '',
  last_error text,
  installed_at text,
  updated_at text
);

create table if not exists upstreams (
  id text primary key,
  name text not null,
  preset text,
  kind text not null,
  plugin_id text,
  adapter text not null default 'openai-http',
  base_url text,
  api_key text,
  cookie text,
  headers text not null default '{}',
  auth_mode text not null default 'none',
  status text not null default 'active',
  weight integer not null default 1,
  cost_per_1k real not null default 0,
  max_rpm integer not null default 0,
  max_rpd integer not null default 0,
  reset_mode text not null default 'none',
  session_reset_at text,
  config text not null default '{}',
  created_at text not null
);

create table if not exists models (
  id text primary key,
  upstream_id text not null references upstreams(id) on delete cascade,
  upstream_model text not null,
  display_name text,
  context_window integer not null default 128000,
  tools_mode text not null default 'emulate',
  tool_variant text not null default 'xml',
  caps text not null default '{}',
  enabled integer not null default 1,
  created_at text not null
);

create table if not exists chains (
  id text primary key,
  name text not null unique,
  strategy text not null default 'priority',
  members text not null default '[]',
  description text,
  enabled integer not null default 1,
  created_at text not null
);

create table if not exists api_keys (
  id text primary key,
  name text not null,
  hash text not null unique,
  prefix text not null,
  rpm integer not null default 0,
  rpd integer not null default 0,
  created_at text not null,
  last_used_at text,
  revoked integer not null default 0
);

create table if not exists usage (
  id integer primary key autoincrement,
  ts integer not null,
  key_id text,
  model text not null,
  upstream_id text,
  status integer not null,
  ok integer not null,
  latency_ms integer not null default 0,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  error text,
  streamed integer not null default 0
);
create index if not exists usage_ts on usage(ts);
create index if not exists usage_model on usage(model, ts);

create table if not exists cooldowns (
  model_id text primary key,
  failures integer not null default 0,
  until_ms integer not null default 0,
  reason text
);
`);

export const nowIso = () => new Date().toISOString();

type Params = (string | number | null)[];
export const all = <T = any>(sql: string, ...params: Params): T[] =>
  db.prepare(sql).all(...params) as unknown as T[];
export const get = <T = any>(sql: string, ...params: Params): T | undefined =>
  db.prepare(sql).get(...params) as unknown as T | undefined;
export const run = (sql: string, ...params: Params) => db.prepare(sql).run(...params);

export function setting(key: string, fallback = ''): string {
  const row = get<{ value: string }>('select value from settings where key = ?', key);
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string) {
  run(
    'insert into settings(key, value) values(?, ?) on conflict(key) do update set value = excluded.value',
    key,
    value,
  );
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Creates a key and returns the plaintext once. Only the hash is kept for auth. */
export function createApiKey(name: string, rpm = 0, rpd = 0) {
  const plaintext = 'comb_' + randomBytes(20).toString('hex');
  const id = randomUUID();
  run(
    'insert into api_keys(id, name, hash, prefix, rpm, rpd, created_at) values(?,?,?,?,?,?,?)',
    id,
    name,
    sha256(plaintext),
    plaintext.slice(0, 12),
    rpm,
    rpd,
    nowIso(),
  );
  return { id, name, key: plaintext };
}

function seed() {
  if (!setting('seeded')) {
    const bootstrap = createApiKey('bootstrap', 0, 0);
    setSetting('bootstrap_api_key', bootstrap.key);
    writeFileSync(join(DATA_DIR, 'bootstrap-key.txt'), bootstrap.key + '\n', { mode: 0o600 });
    setSetting('strategy', 'priority');
    setSetting('max_attempts', '4');
    setSetting('cooldown_base_ms', '30000');
    setSetting('request_timeout_ms', '120000');
    setSetting('default_tool_variant', 'xml');
    setSetting('seeded', nowIso());
  }

  const upsert = db.prepare(`
    insert into plugins (id, name, kind, repo, description, port, base_path, auth_hint,
      install_cmd, run_cmd, models_hint, tools_hint, dir, updated_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    on conflict(id) do nothing
  `);
  for (const p of PLUGIN_CATALOG) {
    upsert.run(
      p.id,
      p.name,
      p.kind,
      p.repo,
      p.description,
      p.port,
      p.base_path,
      p.auth_hint,
      p.install_cmd,
      p.run_cmd,
      JSON.stringify(p.models_hint),
      p.tools_hint,
      join(PLUGIN_DIR, p.id),
      nowIso(),
    );
  }
}
seed();

export { randomUUID };
