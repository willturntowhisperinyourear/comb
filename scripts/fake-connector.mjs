// Minimal stand-in for a web2api connector. Speaks plain text unless the
// request carries comb's tool protocol, in which case it answers in the
// variant's shape. Used to exercise comb without a real provider account.
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8811);

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'gemini-2.5-pro' }, { id: 'gemini-2.5-flash' }] }));
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    const system = String(json.messages?.[0]?.content ?? '');
    const last = String(json.messages?.at(-1)?.content ?? '');
    const isProbe = last.includes('Call ping once');
    let content = 'Recovered session. Here is the short answer: comb routes it.';

    if (isProbe) {
      content = 'Sure.\n<tool_call>{"name":"ping","arguments":{"value":42}}</tool_call>';
    } else if (system.includes('TOOL PROTOCOL')) {
      content =
        'Reading the file now.\n<tool_call>{"name":"read_file","arguments":{"path":"src/main.ts"}}</tool_call>';
    } else if (json.tools?.length) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'native_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/main.ts"}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 32, completion_tokens: 12 },
        }),
      );
      return;
    }

    if (json.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunks = content.match(/.{1,18}/gs) ?? [content];
      for (const c of chunks) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: c }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 28, completion_tokens: 14 },
      }),
    );
  });
});

server.listen(port, '127.0.0.1', () => console.log(`fake connector on :${port}`));
