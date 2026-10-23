import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SchedulerSummary } from './scheduler.ts';

process.env.COMB_DATA = mkdtempSync(join(tmpdir(), 'comb-scheduler-'));

const db = await import('./db.ts');
const refresh = await import('./refresh.ts');
const scheduler = await import('./scheduler.ts');

const server: Server = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
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
test.after(() => {
  scheduler.stopSchedulerTimer();
  server.close();
});

/** A completed pass has a numeric `skipped`; a refused one has a string. */
const completed = (result: any): SchedulerSummary => {
  assert.equal(typeof result.skipped, 'number', 'the pass completed instead of being refused');
  return result as SchedulerSummary;
};

const refusal = (result: any): string => {
  assert.equal(typeof result.skipped, 'string', 'expected a refused pass');
  return String(result.skipped);
};

function upstream(name: string) {
  const id = db.randomUUID();
  db.run(
    `insert into upstreams(id, name, kind, adapter, base_url, status, created_at)
     values(?,?,?,?,?,?,?)`,
    id,
    name,
    'web',
    'openai-http',
    base,
    'active',
    db.nowIso(),
  );
  return id;
}

test('a scheduled pass refreshes upstreams and calibrates uncalibrated models only', async () => {
  const id = upstream('Scheduled Web');

  const first = completed(await scheduler.runSchedulerTick('test'));
  assert.equal(first.upstreams, 1);
  assert.equal(first.refreshed, 1);
  assert.equal(first.calibrated, 2);
  assert.equal(first.failed, 0);

  const before = db.all<any>('select id, tool_variant, calibrated_at from models where upstream_id = ? order by id', id);
  assert.equal(before.length, 2);
  assert.ok(before.every((m) => m.calibration_status !== 'uncalibrated'));

  const second = completed(await scheduler.runSchedulerTick('test'));
  assert.equal(second.calibrated, 0, 'calibrated models are not probed again');

  const after = db.all<any>('select id, tool_variant, calibrated_at from models where upstream_id = ? order by id', id);
  assert.deepEqual(
    after.map((m) => [m.id, m.tool_variant, m.calibrated_at]),
    before.map((m) => [m.id, m.tool_variant, m.calibrated_at]),
  );

  const state = scheduler.schedulerState();
  assert.ok(state.last_run, 'last run timestamp is stored');
  assert.equal(state.last_summary?.upstreams, 1);
});

test('failed models are retried only after the backoff window', async () => {
  const up = upstream('Backoff Web');
  await refresh.refreshUpstream(up);
  const modelId = db.all<any>('select id from models where upstream_id = ? limit 1', up)[0].id as string;

  db.run("update models set calibration_status = 'failed', calibrated_at = ? where id = ?", db.nowIso(), modelId);
  completed(await scheduler.runSchedulerTick('test'));
  assert.equal(
    db.get<any>('select calibration_status from models where id = ?', modelId).calibration_status,
    'failed',
    'a recent failure is left alone inside the backoff window',
  );

  const old = new Date(Date.now() - 7 * 3_600_000).toISOString();
  db.run("update models set calibration_status = 'failed', calibrated_at = ? where id = ?", old, modelId);
  const retried = completed(await scheduler.runSchedulerTick('test'));
  assert.equal(retried.calibrated, 1, 'an expired failure is probed again');
  assert.equal(
    db.get<any>('select calibration_status from models where id = ?', modelId).calibration_status,
    'calibrated',
  );
});

test('a second tick during a running pass is refused instead of overlapping', async () => {
  const first = scheduler.runSchedulerTick('manual');
  const second = await scheduler.runSchedulerTick('manual');
  assert.match(refusal(second), /already in progress/);

  completed(await first);
});

test('configured scheduler reports enabled state, interval and a next run', () => {
  const state = scheduler.configureScheduler({ enabled: true, interval_minutes: 15 });
  assert.equal(state.enabled, true);
  assert.equal(state.interval_minutes, 15);
  assert.ok(state.next_run);

  scheduler.stopSchedulerTimer();
  const off = scheduler.configureScheduler({ enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.next_run, null);

  // Clamping keeps a typo from disabling or hammering the scheduler.
  const clamped = scheduler.configureScheduler({ enabled: true, interval_minutes: 0 });
  assert.equal(clamped.interval_minutes, 1);
  scheduler.stopSchedulerTimer();
  scheduler.configureScheduler({ enabled: false });
});
