import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const server = createServer((req, res) => {
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'live-model' }] }));
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const json = JSON.parse(body);
    const marker = /COMB_LIVE_[a-f0-9]+/.exec(json.messages[0].content)?.[0];
    const blocked = req.url?.includes('/blocked/');
    const empty = req.url?.includes('/empty/');
    const error = { message: 'Guest validation failed', code: 'FAIL_SYS_USER_VALIDATE' };
    if (json.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (blocked) res.write(`data: ${JSON.stringify({ error })}\n\n`);
      else if (!empty) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: marker } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(blocked ? { error } : { choices: [{ message: { content: empty ? '' : marker } }] }));
    }
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => server.close());

async function run(path: string) {
  return new Promise<{ code: number; results: any[] }>((resolve, reject) => {
    execFile(process.execPath, [fileURLToPath(new URL('../../scripts/test-connector.mjs', import.meta.url)), '--base-url', `${base}/${path}/v1`], {
      env: { ...process.env, COMB_TEST_API_KEY: '' }, timeout: 10_000,
    }, (error, stdout, stderr) => {
      if (stderr) return reject(new Error(stderr));
      resolve({ code: error ? Number(error.code) : 0, results: stdout.trim().split('\n').map((line) => JSON.parse(line)) });
    });
  });
}

test('live test command verifies both normal and streaming model replies', async () => {
  const result = await run('working');
  assert.equal(result.code, 0);
  assert.equal(result.results.filter((r) => r.test === 'chat' && r.ok).length, 2);
  assert.equal(result.results.at(-1).ok, true);
});

test('live test command fails on HTTP 200 error bodies and SSE errors', async () => {
  const result = await run('blocked');
  assert.equal(result.code, 1);
  const failures = result.results.filter((r) => r.test === 'chat');
  assert.equal(failures.length, 2);
  assert.ok(failures.every((r) => !r.ok && r.error.includes('FAIL_SYS_USER_VALIDATE')));
});

test('live test command rejects empty completions and empty streams', async () => {
  const result = await run('empty');
  assert.equal(result.code, 1);
  assert.ok(result.results.filter((r) => r.test === 'chat').every((r) => !r.ok));
});
