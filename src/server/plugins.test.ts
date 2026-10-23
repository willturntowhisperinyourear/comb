import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

process.env.COMB_DATA = mkdtempSync(join(tmpdir(), 'comb-plugins-'));
const db = await import('./db.ts');
const plugins = await import('./plugins.ts');
const { api } = await import('./api.ts');

const app = express();
app.use(express.json());
app.use('/api', api);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
test.after(() => server.close());

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const node = quote(process.execPath.replace(/\\/g, '/'));

function plugin(id: string, fields: { repo?: string; install?: string; start?: string; installed?: boolean } = {}) {
  const dir = join(db.PLUGIN_DIR, id);
  db.run(
    `insert into plugins(id, name, kind, repo, dir, install_cmd, run_cmd, status, installed_at)
     values(?,?,'cli2api',?,?,?,?,?,?)`,
    id, id, fields.repo ?? '', dir, fields.install ?? '', fields.start ?? '',
    fields.installed ? 'installed' : 'not_installed', fields.installed ? db.nowIso() : null,
  );
  if (fields.installed) mkdirSync(dir, { recursive: true });
  return dir;
}

async function waitFor(id: string, statuses: string[]) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const row = plugins.pluginById(id)!;
    if (statuses.includes(row.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail(`${id}: ${JSON.stringify(plugins.pluginById(id))}`);
}

test('a connector process spawn failure is reported and the API stays available', async () => {
  plugin('missing-cwd', { installed: true, start: `${node} -e 'setInterval(() => {}, 1000)'` });
  db.run('update plugins set dir = ? where id = ?', join(db.PLUGIN_DIR, 'absent'), 'missing-cwd');
  await fetch(`${base}/plugins/missing-cwd/start`, { method: 'POST' });
  const failed = await waitFor('missing-cwd', ['error']);
  assert.match(failed.last_error!, /start failed.*ENOENT/i);
  assert.equal(plugins.runningPlugins().includes('missing-cwd'), false);
  assert.equal((await fetch(`${base}/plugins`)).status, 200);
});

test('setup clones a local repo with spaces, installs, starts and stops it', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'comb fixture repo '));
  writeFileSync(join(repo, 'install.cjs'), `require('node:fs').writeFileSync('installed.txt', 'ok');\n`);
  writeFileSync(join(repo, 'server.cjs'), 'setInterval(() => {}, 1000);\n');
  for (const args of [
    ['init', repo], ['-C', repo, 'add', '.'],
    ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'],
  ]) execFileSync('git', args, { stdio: 'pipe' });
  const dir = plugin('local-repo', { repo, install: `${node} install.cjs`, start: `${node} server.cjs` });
  const response = await fetch(`${base}/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ install: ['local-repo'] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).installed[0].id, 'local-repo');
  const installed = await waitFor('local-repo', ['installed', 'error']);
  assert.equal(installed.status, 'installed', installed.last_error ?? plugins.pluginLog('local-repo'));
  assert.ok(installed.installed_at);
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(join(dir, 'installed.txt'), 'utf8'), 'ok');
  try {
    await plugins.startPlugin('local-repo');
    assert.equal((await waitFor('local-repo', ['running', 'error'])).status, 'running');
  } finally {
    plugins.stopPlugin('local-repo');
  }
  assert.equal(plugins.runningPlugins().includes('local-repo'), false);
});

test('a failed clone keeps its diagnostic and cannot start an uninstalled connector', async () => {
  plugin('bad-clone', { repo: join(db.DATA_DIR, 'nonexistent-repo'), start: 'echo should-not-start' });
  plugins.installPlugin('bad-clone');
  const failed = await waitFor('bad-clone', ['error']);
  assert.match(failed.last_error!, /git clone failed/);
  const started = await plugins.startPlugin('bad-clone');
  assert.equal(started?.status, 'error');
  assert.equal(started?.last_error, failed.last_error);
  assert.equal(plugins.runningPlugins().includes('bad-clone'), false);
});

test('filesystem failures during install become connector errors', () => {
  const dir = plugin('nonempty');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'existing.txt'), 'preserve this');
  const result = plugins.installPlugin('nonempty');
  assert.equal(result?.status, 'error');
  assert.match(result?.last_error ?? '', /not empty/);
});

test('a live process with failed model discovery never becomes running', async () => {
  const unhealthy = createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Failed to fetch models' } }));
  });
  await new Promise<void>((resolve) => unhealthy.listen(0, '127.0.0.1', resolve));
  plugin('unhealthy', { installed: true, start: `${node} -e 'setInterval(() => {}, 1000)'` });
  db.run('update plugins set port = ? where id = ?', (unhealthy.address() as any).port, 'unhealthy');
  try {
    await plugins.startPlugin('unhealthy', 100);
    const result = await waitFor('unhealthy', ['error', 'running']);
    assert.equal(result.status, 'error');
    assert.match(result.last_error!, /HTTP 500: Failed to fetch models/);
    assert.equal(plugins.runningPlugins().includes('unhealthy'), false);
    assert.equal((await fetch(`${base}/plugins`)).status, 200);
  } finally {
    plugins.stopPlugin('unhealthy');
    unhealthy.close();
  }
});

test('readiness and discovery use configured upstream credentials and headers', async () => {
  const secured = createServer((req, res) => {
    const ok = req.headers.authorization === 'Bearer readiness-key' && req.headers['x-provider'] === 'ready';
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { data: [{ id: 'secured-model' }] } : { error: { message: 'authentication required' } }));
  });
  await new Promise<void>((resolve) => secured.listen(0, '127.0.0.1', resolve));
  plugin('secured', { installed: true, start: `${node} -e 'setInterval(() => {}, 1000)'` });
  const port = (secured.address() as any).port;
  db.run('update plugins set port = ? where id = ?', port, 'secured');
  db.run(`insert into upstreams(id,name,kind,plugin_id,base_url,api_key,headers,created_at) values('secured-up','Secured','api','secured',?,?,?,?)`, `http://127.0.0.1:${port}/v1`, 'readiness-key', '{"x-provider":"ready"}', db.nowIso());
  try {
    await plugins.startPlugin('secured', 100);
    assert.equal((await waitFor('secured', ['running', 'error'])).status, 'running');
    assert.deepEqual((await plugins.discoverModels('secured-up')).discovered, ['secured-model']);
  } finally { plugins.stopPlugin('secured'); secured.close(); }
});

test('rerunning setup returns an existing upstream and adds extra model ids', async () => {
  const setup = async (models: string[]) => {
    const response = await fetch(`${base}/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ create: ['arena-web'], models: { 'arena-web': models } }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await setup([]);
  const retry = await setup(['test-extra-model']);
  assert.equal(retry.upstreams.length, 1);
  assert.equal(retry.upstreams[0].id, first.upstreams[0].id);
  assert.ok(db.get('select id from models where upstream_id = ? and upstream_model = ?', first.upstreams[0].id, 'test-extra-model'));
});
