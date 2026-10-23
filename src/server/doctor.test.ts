import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

process.env.COMB_DATA = mkdtempSync(join(tmpdir(), 'comb-doctor-'));
const db = await import('./db.ts');
const doctor = await import('./doctor.ts');
const plugins = await import('./plugins.ts');
const { api } = await import('./api.ts');

const modelRequests: any[] = [];
const marker = join(db.DATA_DIR, 'must-not-exist.txt');
const server = createServer((req, res) => {
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'real-test-model' }] }));
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const json = JSON.parse(body);
    if (req.url?.includes('/advisor/')) {
      modelRequests.push(json);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        summary: 'Inspect provider validation. secret-upstream-key',
        next_steps: ['Review connector support.'],
        commands: [`node -e "require('fs').writeFileSync('${marker}', 'bad')"`],
        actions: ['execute_shell'],
      }) } }] }));
      return;
    }
    const blocked = req.url?.includes('/blocked/');
    const content = /COMB_DOCTOR_[a-f0-9]+/.exec(json.messages?.[0]?.content)?.[0] ?? '';
    const error = { code: 'FAIL_SYS_USER_VALIDATE', message: 'Provider rejected guest request' };
    if (json.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(blocked ? { error } : { choices: [{ delta: { content } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(blocked ? { error } : { choices: [{ message: { content } }] }));
    }
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}`;
const app = express();
app.use(express.json()); app.use('/api', api);
const admin = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => admin.once('listening', resolve));
const adminBase = `http://127.0.0.1:${(admin.address() as any).port}/api`;
test.after(() => { server.close(); admin.close(); doctor.configureDoctor({ auto_enabled: false }); });

function connector(id: string, route = 'good', wrongPort = false) {
  const dir = join(db.PLUGIN_DIR, id);
  mkdirSync(dir, { recursive: true });
  db.run(`insert into plugins(id,name,kind,repo,port,base_path,dir,status,installed_at) values(?,?,'web2api','fixture',?,?,?,'running',?)`, id, id, port, `/${route}/v1`, dir, db.nowIso());
  const upstreamId = db.randomUUID();
  db.run(`insert into upstreams(id,name,kind,plugin_id,base_url,api_key,cookie,headers,created_at) values(?,?,'web',?,?,?,?,?,?)`,
    upstreamId, id, id, wrongPort ? `http://127.0.0.1:1/${route}/v1` : `${base}/${route}/v1`, 'secret-upstream-key', 'secret-cookie-value', JSON.stringify({ 'x-private': 'secret-header-value' }), db.nowIso());
  return upstreamId;
}

test('doctor verifies normal and streaming replies without requiring a model', async () => {
  connector('healthy');
  const report = await doctor.runDoctor('healthy', { repair: true });
  assert.equal(report.status, 'healthy');
  assert.ok(report.checks.every((check) => check.ok));
  assert.deepEqual(report.repairs, []);
});

test('diagnose only records an available URL repair without applying it', async () => {
  const upstream = connector('diagnose-only', 'good', true);
  const report = await doctor.runDoctor('diagnose-only');
  assert.equal(report.status, 'needs_attention');
  assert.ok(report.available_repairs.includes('sync_url'));
  assert.equal(db.get<any>('select base_url from upstreams where id = ?', upstream).base_url, 'http://127.0.0.1:1/good/v1');
  assert.equal(report.repairs.length, 0);
});

test('repair corrects a stale local port and requires actual chat retests', async () => {
  const upstream = connector('wrong-port', 'good', true);
  const report = await doctor.runDoctor('wrong-port', { repair: true });
  assert.equal(report.status, 'repaired', JSON.stringify(report));
  assert.equal(db.get<any>('select base_url from upstreams where id = ?', upstream).base_url, `${base}/good/v1`);
  assert.ok(report.repairs.some((action) => action.action === 'sync_url' && action.ok));
  assert.ok(report.checks.some((check) => check.name === 'streaming_chat' && check.ok));
});

test('provider validation does not trigger restart or reinstall loops', async () => {
  connector('blocked', 'blocked');
  const report = await doctor.runDoctor('blocked', { repair: true });
  assert.equal(report.status, 'needs_attention');
  assert.equal(report.provider_blocked, true);
  assert.equal(report.repairs.length, 0);
  assert.ok(report.checks.some((check) => check.name === 'chat' && check.detail.includes('FAIL_SYS_USER_VALIDATE')));
  assert.ok(report.checks.some((check) => check.name === 'streaming_chat' && !check.ok));
});

test('model receives redacted diagnostics and cannot execute proposed commands', async () => {
  connector('advised', 'blocked');
  plugins.appendPluginLog('advised', 'Authorization: Bearer unknown-bearer\naccess_token=unknown-token\nCookie: cookie-not-in-db\nsecret-upstream-key secret-cookie-value secret-header-value');
  doctor.configureDoctor({ base_url: `${base}/advisor/v1`, model: 'diagnosis-model', api_key: 'secret-doctor-key' });
  const report = await doctor.runDoctor('advised', { repair: true });
  assert.ok(report.model_advice);
  assert.equal(report.status, 'needs_attention');
  const sent = JSON.stringify(modelRequests.at(-1).messages);
  for (const secret of ['unknown-bearer', 'unknown-token', 'cookie-not-in-db', 'secret-upstream-key', 'secret-cookie-value', 'secret-header-value', 'secret-doctor-key']) {
    assert.equal(sent.includes(secret), false, secret);
    assert.equal(JSON.stringify(report).includes(secret), false, secret);
  }
  assert.equal(existsSync(marker), false);
  assert.equal(doctor.doctorConfig().api_key_set, true);
  assert.equal(JSON.stringify(doctor.doctorConfig()).includes('secret-doctor-key'), false);
  doctor.configureDoctor({ base_url: '', model: '', api_key: '' });
});

test('doctor API returns a background job and exposes its completed report', async () => {
  connector('api-check');
  const response = await fetch(`${adminBase}/plugins/api-check/doctor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).plugin_id, 'api-check');
  const report = await doctor.runDoctor('api-check');
  assert.equal(report.status, 'healthy');
  const saved = await (await fetch(`${adminBase}/plugins/api-check/doctor`)).json();
  assert.equal(saved.report.status, 'healthy');
  assert.equal(saved.busy, false);
});

test('model credentials and reports are excluded from general settings', async () => {
  doctor.configureDoctor({ api_key: 'private-doctor-key' });
  const response = await fetch(`${adminBase}/settings`);
  assert.equal((await response.text()).includes('private-doctor-key'), false);
  doctor.configureDoctor({ api_key: '' });
});

test('automatic diagnosis repairs once and observes the persisted backoff', async () => {
  connector('automatic', 'good', true);
  doctor.configureDoctor({ auto_enabled: true });
  doctor.scheduleDoctor('automatic');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !doctor.doctorReport('automatic')?.finished_at) await new Promise((resolve) => setTimeout(resolve, 30));
  const report = doctor.doctorReport('automatic')!;
  assert.equal(report.status, 'repaired', JSON.stringify(report));
  assert.equal(report.automatic, true);
  doctor.scheduleDoctor('automatic');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(doctor.doctorReport('automatic')!.at, report.at);
  doctor.configureDoctor({ auto_enabled: false });
});

test('invalid model endpoint and active installs are rejected', () => {
  assert.throws(() => doctor.configureDoctor({ base_url: 'file:///tmp/test' }), /HTTP/);
  assert.throws(() => doctor.configureDoctor({ auto_enabled: 'false' }), /boolean/);
  db.run("update plugins set status = 'installing' where id = 'healthy'");
  assert.throws(() => doctor.startDoctor('healthy', { repair: true }), /busy/);
});

test('an unavailable advisor preserves built-in test results', async () => {
  connector('advisor-down');
  doctor.configureDoctor({ base_url: 'http://127.0.0.1:1/v1', model: 'unavailable' });
  const report = await doctor.runDoctor('advisor-down');
  assert.equal(report.status, 'healthy');
  assert.ok(report.model_error);
  assert.ok(report.checks.some((check) => check.name === 'streaming_chat' && check.ok));
  doctor.configureDoctor({ base_url: '', model: '' });
});

test('a connector that becomes busy before an automatic pass is skipped without throwing', async () => {
  connector('became-busy');
  doctor.configureDoctor({ auto_enabled: true });
  doctor.scheduleDoctor('became-busy');
  db.run("update plugins set status = 'installing' where id = 'became-busy'");
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(doctor.doctorReport('became-busy'), null);
  doctor.configureDoctor({ auto_enabled: false });
});
