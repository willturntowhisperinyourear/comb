import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.COMB_DATA = mkdtempSync(join(tmpdir(), 'comb-proxy-'));

const db = await import('./db.ts');
const proxy = await import('./proxy.ts');

// Fake web2api connector: plain text unless the request carries the tool
// protocol, in which case it answers in the emulated XML shape.
const seen: any[] = [];
const server: Server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    seen.push(json);
    if (json.model === 'dead-model') {
      res.writeHead(503).end('upstream down');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (json.model === 'native-model') {
      res.end(JSON.stringify({
        choices: [{
          message: { role: 'assistant', content: null, tool_calls: [{ id: 'n1', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      }));
      return;
    }
    const system = String(json.messages?.[0]?.content ?? '');
    const content = system.includes('TOOL PROTOCOL')
      ? 'Reading it.\n<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>'
      : 'plain answer';
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 5 },
    }));
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}/v1`;

function upstream(name: string, toolsMode: string, id = db.randomUUID()) {
  db.run(
    `insert into upstreams(id, name, kind, adapter, base_url, status, created_at, config)
     values(?,?,?,?,?,?,?,?)`,
    id, name, 'web', 'openai-http', base, 'active', db.nowIso(), '{}',
  );
  return id;
}

function model(upstreamId: string, name: string, toolsMode: string, toolsVariant = 'xml') {
  const id = `${upstreamId.slice(0, 4)}/${name}`;
  db.run(
    `insert into models(id, upstream_id, upstream_model, tools_mode, tool_variant, created_at)
     values(?,?,?,?,?,?)`,
    id, upstreamId, name, toolsMode, toolsVariant, db.nowIso(),
  );
  return id;
}

const textUp = upstream('text-up', 'emulate');
const textModel = model(textUp, 'web-model', 'emulate', 'xml');
const deadUp = upstream('dead-up', 'native');
const deadModel = model(deadUp, 'dead-model', 'native');
const nativeUp = upstream('native-up', 'native');
const nativeModel = model(nativeUp, 'native-model', 'native');

db.run(
  'insert into chains(id, name, strategy, members, enabled, created_at) values(?,?,?,?,?,?)',
  db.randomUUID(), 'failover', 'priority', JSON.stringify([deadModel, textModel]), 1, db.nowIso(),
);

const tools = [{
  type: 'function',
  function: {
    name: 'read_file',
    description: 'read',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
}];

test.after(() => server.close());

test('plain text request reaches the upstream and comes back as a completion', async () => {
  const out = await proxy.chatOnce({ model: textModel, messages: [{ role: 'user', content: 'hi' }] }, null);
  assert.equal(out.status, 200);
  assert.equal(out.body.choices[0].message.content, 'plain answer');
  assert.equal(out.body.model, textModel);
  assert.equal(out.body.comb.upstream, 'text-up');
});

test('emulated tools turn text into native tool_calls and strip the protocol block', async () => {
  const out = await proxy.chatOnce(
    { model: textModel, messages: [{ role: 'user', content: 'read a.ts' }], tools },
    null,
  );
  assert.equal(out.status, 200);
  const message = out.body.choices[0].message;
  assert.equal(message.tool_calls.length, 1);
  assert.equal(message.tool_calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { path: 'a.ts' });
  assert.equal(message.content, 'Reading it.');
  assert.equal(out.body.choices[0].finish_reason, 'tool_calls');
  assert.equal(out.body.comb.emulated_tools, true);

  // The upstream must have received the protocol prompt instead of a tools array.
  const sent = seen.at(-1);
  assert.match(sent.messages[0].content, /TOOL PROTOCOL/);
  assert.equal(sent.tools, undefined);
});

test('native upstream tool_calls pass straight through', async () => {
  const out = await proxy.chatOnce({ model: nativeModel, messages: [{ role: 'user', content: 'x' }], tools }, null);
  assert.equal(out.status, 200);
  assert.equal(out.body.choices[0].message.tool_calls[0].id, 'n1');
  assert.equal(seen.at(-1).tools.length, 1);
});

test('a dead upstream fails over to the next chain member', async () => {
  const out = await proxy.chatOnce({ model: 'failover', messages: [{ role: 'user', content: 'hi' }] }, null);
  assert.equal(out.status, 200);
  assert.equal(out.body.comb.attempts, 2);
  assert.equal(out.body.comb.upstream, 'text-up');
  const cd = db.get<any>('select * from cooldowns where model_id = ?', deadModel);
  assert.ok(cd.until_ms > Date.now(), 'failed model should be cooling down');
});

test('an unknown model is a 404, not a 500', async () => {
  const out = await proxy.chatOnce({ model: 'nope', messages: [] }, null);
  assert.equal(out.status, 404);
  assert.equal(out.body.error.type, 'model_not_found');
});

test('every-upstream-failed reports each attempt', async () => {
  db.run('update cooldowns set until_ms = 0');
  db.run('update models set tools_mode = ? where id = ?', 'native', textModel);
  const chain = db.get<any>('select id from chains where name = ?', 'failover');
  db.run('update chains set members = ? where id = ?', JSON.stringify([deadModel]), chain.id);
  const out = await proxy.chatOnce({ model: 'failover', messages: [{ role: 'user', content: 'hi' }] }, null);
  assert.equal(out.status, 502);
  assert.equal(out.body.error.attempts.length, 1);
  db.run('update chains set members = ? where id = ?', JSON.stringify([deadModel, textModel]), chain.id);
});
