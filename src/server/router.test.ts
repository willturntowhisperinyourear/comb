import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.COMB_DATA = mkdtempSync(join(tmpdir(), 'comb-router-'));

const db = await import('./db.ts');
const router = await import('./router.ts');

function seedUpstream(name: string, opts: { cost?: number; rpm?: number } = {}) {
  const id = db.randomUUID();
  db.run(
    `insert into upstreams(id, name, kind, adapter, base_url, status, weight, cost_per_1k, max_rpm, created_at)
     values(?,?,?,?,?,?,?,?,?,?)`,
    id, name, 'web', 'openai-http', 'http://127.0.0.1:1/v1', 'active', 1, opts.cost ?? 0, opts.rpm ?? 0, db.nowIso(),
  );
  return id;
}

function seedModel(upstreamId: string, upstreamModel: string) {
  const id = `${upstreamId.slice(0, 4)}/${upstreamModel}`;
  db.run(
    `insert into models(id, upstream_id, upstream_model, display_name, tools_mode, created_at)
     values(?,?,?,?,?,?)`,
    id, upstreamId, upstreamModel, upstreamModel, 'emulate', db.nowIso(),
  );
  return id;
}

const cheep = seedUpstream('cheap', { cost: 0 });
const pricey = seedUpstream('pricey', { cost: 12 });
const mCheap = seedModel(cheep, 'flash');
const mPricey = seedModel(pricey, 'pro');

db.run(
  'insert into chains(id, name, strategy, members, enabled, created_at) values(?,?,?,?,?,?)',
  db.randomUUID(), 'daily', 'priority', JSON.stringify([mPricey, mCheap]), 1, db.nowIso(),
);
db.run(
  'insert into chains(id, name, strategy, members, enabled, created_at) values(?,?,?,?,?,?)',
  db.randomUUID(), 'cheap-first', 'cheapest', JSON.stringify([mPricey, mCheap]), 1, db.nowIso(),
);

test('a chain resolves to its members in declared order under priority', () => {
  const cands = router.candidatesFor('daily');
  assert.deepEqual(cands.map((c) => c.model.id), [mPricey, mCheap]);
});

test('a bare model id resolves and unknown ids resolve to nothing', () => {
  assert.equal(router.candidatesFor(mCheap).length, 1);
  assert.equal(router.candidatesFor('does-not-exist').length, 0);
});

test('cheapest strategy reorders a chain by cost', () => {
  const chain = router.chainByName('cheap-first')!;
  const ordered = router.orderCandidates(router.candidatesFor('cheap-first'), chain.strategy);
  assert.equal(ordered[0].model.id, mCheap);
});

test('a cooling model is pushed behind a healthy one', () => {
  router.markFailure(mPricey, '429', 60_000);
  assert.equal(router.inCooldown(mPricey), true);
  const ordered = router.orderCandidates(router.candidatesFor('daily'), 'priority');
  assert.equal(ordered[0].model.id, mCheap);
  assert.equal(ordered[1].model.id, mPricey);
  router.markSuccess(mPricey);
  assert.equal(router.inCooldown(mPricey), false);
});

test('auto sorts enabled models by health score', () => {
  db.run(
    `insert into usage(ts, model, upstream_id, status, ok, latency_ms, tokens_in, tokens_out)
     values(?,?,?,?,?,?,?,?)`,
    Date.now(), mCheap, cheep, 200, 1, 300, 10, 10,
  );
  const auto = router.autoCandidates();
  assert.ok(auto.length >= 2);
  assert.equal(auto[0].model.id, mCheap);
});

test('usage recording powers the per-model stats', () => {
  router.recordUsage({
    keyId: null, model: mPricey, upstreamId: pricey, status: 200, ok: true, latencyMs: 1200, tokensIn: 5, tokensOut: 7,
  });
  const stats = router.statsFor(mPricey, pricey);
  assert.equal(stats.total, 1);
  assert.equal(stats.ok, 1);
});
