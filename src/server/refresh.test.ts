import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.COMB_DATA = mkdtempSync(join(tmpdir(), 'comb-refresh-'));

const db = await import('./db.ts');
const refresh = await import('./refresh.ts');
const modelsApi = await import('./models.ts');
const plugins = await import('./plugins.ts');

const server: Server = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    const system = String(json.messages?.[0]?.content ?? '');
    const last = String(json.messages?.at(-1)?.content ?? '');
    let content = 'plain answer';
    if (last.includes('Call ping')) {
      content = '<tool_call>{"name":"ping","arguments":{"value":42}}</tool_call>';
    } else if (system.includes('TOOL PROTOCOL')) {
      content = '<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>';
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}/v1`;
test.after(() => server.close());

function upstream(fields: Record<string, unknown>) {
  const id = db.randomUUID();
  const row = {
    id,
    name: 'Test Web',
    kind: 'web',
    adapter: 'openai-http',
    base_url: base,
    status: 'active',
    plugin_id: null,
    preset: null,
    ...fields,
  };
  db.run(
    `insert into upstreams(id, name, kind, adapter, base_url, status, plugin_id, preset, created_at)
     values(?,?,?,?,?,?,?,?,?)`,
    row.id as string,
    row.name as string,
    row.kind as string,
    row.adapter as string,
    row.base_url as string,
    row.status as string,
    row.plugin_id as string | null,
    row.preset as string | null,
    db.nowIso(),
  );
  return id;
}

test('connector capability wins over upstream kind', () => {
  assert.equal(plugins.defaultToolsMode({ plugin_id: 'gemini-web', preset: 'gemini-web', kind: 'web' }), 'native');
  assert.equal(plugins.defaultToolsMode({ plugin_id: 'qwen-web', preset: 'qwen-web', kind: 'web' }), 'emulate');
  assert.equal(plugins.defaultToolsMode({ kind: 'api' }), 'native');
  assert.equal(plugins.defaultToolsMode({ kind: 'cli' }), 'emulate');
});

test('refresh discovers, creates and calibrates uncalibrated emulated models', async () => {
  const id = upstream({});
  const result = await refresh.refreshUpstream(id);

  assert.deepEqual(result.discovered.sort(), ['model-a', 'model-b']);
  assert.equal(result.created.length, 2);
  assert.equal(result.calibrated, 2);
  assert.equal(result.failed, 0);

  const models = db.all<any>('select * from models where upstream_id = ? order by id', id);
  assert.equal(models.length, 2);
  for (const model of models) {
    assert.equal(model.tools_mode, 'emulate');
    assert.equal(model.calibration_status, 'calibrated');
    assert.ok(['xml', 'fence', 'json'].includes(model.tool_variant));
    assert.ok(model.calibrated_at);
  }
});

test('a second refresh skips calibrated models and keeps their rows', async () => {
  const id = upstream({ name: 'Second Web' });
  await refresh.refreshUpstream(id);
  const before = db.all<any>('select * from models where upstream_id = ? order by id', id);

  const again = await refresh.refreshUpstream(id);
  assert.equal(again.created.length, 0);
  assert.equal(again.calibrated, 0);
  assert.equal(again.skipped, 2);

  const after = db.all<any>('select * from models where upstream_id = ? order by id', id);
  assert.deepEqual(
    after.map((m) => [m.id, m.tool_variant, m.calibrated_at]),
    before.map((m) => [m.id, m.tool_variant, m.calibrated_at]),
  );
});

test('force recalibrates calibrated models', async () => {
  const id = upstream({ name: 'Force Web' });
  await refresh.refreshUpstream(id);
  const forced = await refresh.refreshUpstream(id, { force: true });
  assert.equal(forced.calibrated, 2);
  assert.equal(forced.skipped, 0);
});

test('a stopped connector still seeds preset ids, warns and skips probing', async () => {
  const id = upstream({
    name: 'Gemini Web',
    plugin_id: 'gemini-web',
    preset: 'gemini-web',
    base_url: 'http://127.0.0.1:9/v1',
  });
  const result = await refresh.refreshUpstream(id);

  assert.equal(result.discovered.length, 0);
  assert.ok(result.warnings.some((w) => w.includes('Gemini Web')), 'warns about the stopped connector');
  const models = db.all<any>('select * from models where upstream_id = ?', id);
  const ids = models.map((m) => m.id);
  assert.ok(ids.includes('gemini-web/gemini-3-pro'), 'seeds the current preset ids');
  assert.ok(models.every((m) => m.tools_mode === 'native'), 'native preset stays native and is not calibrated');
  assert.equal(result.skipped, models.length);
  assert.equal(result.failed, 0, 'a down connector is not reported as a failed calibration');
  assert.ok(result.warnings.some((w) => w.includes('calibration skipped')));
});

test('whitespace ids are rejected and existing rows are preserved', async () => {
  const id = upstream({ name: 'Manual Web' });
  const added = modelsApi.addModels(id, ['model-a', 'bad id']);
  assert.deepEqual(added.created, ['manual-web/model-a']);
  assert.deepEqual(added.invalid, ['bad id']);
  const row = db.get<any>('select * from models where id = ?', 'manual-web/model-a');
  assert.equal(row.calibration_status, 'uncalibrated');
  assert.equal(modelsApi.addModels(id, ['model-a']).existing[0], 'manual-web/model-a');
});
