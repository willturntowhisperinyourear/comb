import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';

const { values } = parseArgs({ options: {
  'base-url': { type: 'string' },
  model: { type: 'string', multiple: true },
  'timeout-ms': { type: 'string', default: '90000' },
} });
if (!values['base-url']) {
  console.error('Usage: npm run test:connector -- --base-url http://127.0.0.1:8082/v1 [--model MODEL]');
  process.exit(1);
}
const base = values['base-url'].replace(/\/+$/, '');
const timeoutMs = Number(values['timeout-ms']);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be positive');
const headers = { 'content-type': 'application/json' };
if (process.env.COMB_TEST_API_KEY) headers.authorization = `Bearer ${process.env.COMB_TEST_API_KEY}`;
const results = [];
const report = (result) => {
  results.push(result);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
};
const describe = (error) => {
  if (typeof error === 'string') return error;
  const attempts = Array.isArray(error?.attempts) ? error.attempts.map((attempt) => `${attempt.model}: ${attempt.error}`).join('; ') : '';
  return `${error?.code ? `${error.code}: ` : ''}${error?.message ?? JSON.stringify(error)}${attempts ? ` (${attempts})` : ''}`.slice(0, 2000);
};

let models = [];
try {
  const response = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const json = await response.json();
  if (!response.ok || json?.error) throw new Error(`HTTP ${response.status}: ${describe(json?.error ?? response.statusText)}`);
  models = (Array.isArray(json?.data) ? json.data : []).map((item) => item?.id).filter((id) => typeof id === 'string' && id.trim());
  if (!models.length) throw new Error('No live model ids returned');
  report({ test: 'discovery', ok: true, models });
} catch (error) {
  report({ test: 'discovery', ok: false, error: error.message });
}

for (const model of values.model ?? models.slice(0, 1)) {
  for (const stream of [false, true]) {
    const marker = `COMB_LIVE_${randomUUID().replaceAll('-', '')}`;
    const start = Date.now();
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ model, messages: [{ role: 'user', content: `Reply with exactly ${marker}. No other text.` }], stream }),
      });
      const text = await response.text();
      let content = '';
      if (!response.ok) {
        let detail = text.slice(0, 1000);
        try { detail = describe(JSON.parse(text)?.error ?? detail); } catch {}
        throw new Error(`HTTP ${response.status}: ${detail}`);
      }
      if (stream) {
        if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Expected an SSE response');
        let done = false;
        for (const line of text.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { done = true; continue; }
          const event = JSON.parse(data);
          if (event.error) throw new Error(describe(event.error));
          content += event.choices?.[0]?.delta?.content ?? '';
        }
        if (!done) throw new Error('Stream ended without [DONE]');
      } else {
        const json = JSON.parse(text);
        if (json.error) throw new Error(describe(json.error));
        content = json.choices?.[0]?.message?.content ?? '';
      }
      if (typeof content !== 'string' || !content.includes(marker)) {
        throw new Error(`Expected the test marker in an actual model response; received ${JSON.stringify(content).slice(0, 500)}`);
      }
      report({ test: 'chat', model, stream, ok: true, ms: Date.now() - start, reply: content.slice(0, 500) });
    } catch (error) {
      report({ test: 'chat', model, stream, ok: false, ms: Date.now() - start, error: error.message });
    }
  }
}
console.log(JSON.stringify({ test: 'summary', ok: results.every((r) => r.ok), passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length }));
