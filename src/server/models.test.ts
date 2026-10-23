import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.COMB_DATA = mkdtempSync(join(tmpdir(), 'comb-models-'));

const db = await import('./db.ts');
const { addModels } = await import('./models.ts');

function upstream(name: string, kind: string) {
  const id = db.randomUUID();
  db.run(
    `insert into upstreams(id, name, kind, adapter, base_url, status, created_at)
     values(?,?,?,?,?,?,?)`,
    id, name, kind, 'openai-http', 'http://127.0.0.1:1/v1', 'active', db.nowIso(),
  );
  return id;
}

test('adds the ids a connector does not list yet', () => {
  const id = upstream('Qwen Web', 'web');
  const result = addModels(id, ['qwen3.5-max', 'qwen3.5-coder']);
  assert.deepEqual(result.created, ['qwen-web/qwen3.5-max', 'qwen-web/qwen3.5-coder']);
  const model = db.get<any>('select * from models where id = ?', 'qwen-web/qwen3.5-max');
  assert.equal(model.upstream_model, 'qwen3.5-max');
  assert.equal(model.tools_mode, 'emulate');
  assert.equal(model.calibration_status, 'uncalibrated', 'emulated models start unproven');
  assert.equal(model.tool_variant, 'xml', 'the settings default is used as a fallback variant');
});

test('skips duplicates and reports them instead of failing the request', () => {
  const id = upstream('Qwen Dupe', 'web');
  addModels(id, ['qwen3.5-max']);
  const again = addModels(id, ['qwen3.5-max', 'qwen3.5-max', 'Qwen3.5-Max']);
  assert.deepEqual(again.created, ['qwen-dupe/Qwen3.5-Max']);
  assert.deepEqual(again.existing, ['qwen-dupe/qwen3.5-max']);
});

test('accepts a fully qualified id and rejects whitespace', () => {
  const id = upstream('Gemini Web', 'web');
  const result = addModels(id, ['gemini-web/gemini-3-pro', 'not a model', ' ']);
  assert.deepEqual(result.created, ['gemini-web/gemini-3-pro']);
  assert.deepEqual(result.invalid, ['not a model']);
});

test('defaults to native tools for api upstreams and takes an override', () => {
  const id = upstream('Some API', 'api');
  const result = addModels(id, ['gpt-9', 'gpt-9-mini'], 'emulate');
  assert.equal(result.created.length, 2);
  for (const modelId of result.created) {
    assert.equal(db.get<any>('select tools_mode from models where id = ?', modelId).tools_mode, 'emulate');
  }
  const native = addModels(id, ['gpt-9-nano']);
  const nativeRow = db.get<any>('select tools_mode, calibration_status from models where id = ?', native.created[0]);
  assert.equal(nativeRow.tools_mode, 'native');
  assert.equal(nativeRow.calibration_status, null, 'native models are never queued for emulation calibration');
});

test('an unknown upstream is an error, not a crash', () => {
  const result = addModels('nope', ['x']);
  assert.equal(result.error, 'upstream not found');
  assert.deepEqual(result.created, []);
});
