import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTools,
  buildProtocol,
  parseToolCalls,
  repairJson,
  transformMessages,
} from './tools.ts';

const tools = normalizeTools([
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  { type: 'function', function: { name: 'list_dir', description: 'List a directory' } },
]);

test('normalizeTools keeps names and fills missing schemas', () => {
  assert.equal(tools.length, 2);
  assert.deepEqual(tools[1].parameters, { type: 'object', properties: {} });
});

test('buildProtocol lists every tool and the forced choice', () => {
  const p = buildProtocol(tools, 'xml', { type: 'function', function: { name: 'read_file' } });
  assert.match(p, /<tool name="read_file"/);
  assert.match(p, /<tool name="list_dir"/);
  assert.match(p, /must call the tool "read_file"/);
  assert.match(p, /required/);
});

test('parses an xml call and leaves surrounding prose', () => {
  const content = `Let me look.\n<tool_call>{"name":"read_file","arguments":{"path":"src/a.ts"}}</tool_call>`;
  const r = parseToolCalls(content, tools, 'xml');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { path: 'src/a.ts' });
  assert.equal(r.text, 'Let me look.');
  assert.match(r.calls[0].id, /^call_/);
});

test('parses parallel calls in one reply', () => {
  const content =
    '<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>\n' +
    '<tool_call>{"name":"read_file","arguments":{"path":"b"}}</tool_call>';
  const r = parseToolCalls(content, tools, 'xml');
  assert.equal(r.calls.length, 2);
  assert.equal(r.text, '');
});

test('parses fenced calls', () => {
  const content = '```tool_call\n{"name":"list_dir","arguments":{}}\n```';
  const r = parseToolCalls(content, tools, 'fence');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].function.name, 'list_dir');
});

test('parses a json-variant reply with no prose', () => {
  const content = '{"tool_calls":[{"name":"read_file","arguments":"{\\"path\\":\\"x\\"}"}]}';
  const r = parseToolCalls(content, tools, 'json');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { path: 'x' });
});

test('recovers a bare JSON object the model emitted without a wrapper', () => {
  const r = parseToolCalls('{"name": "read_file", "arguments": {"path": "y"}}', tools, 'xml');
  assert.equal(r.calls.length, 1);
  assert.equal(r.text, '');
});

test('drops unknown tools into invalid instead of forwarding them', () => {
  const r = parseToolCalls('<tool_call>{"name":"rm_rf","arguments":{}}</tool_call>', tools, 'xml');
  assert.equal(r.calls.length, 0);
  assert.equal(r.invalid[0].reason, 'unknown tool');
});

test('repairs trailing commas, unquoted keys and single quotes', () => {
  assert.deepEqual(repairJson('{path: \'a\', depth: 2,}'), { path: 'a', depth: 2 });
  assert.deepEqual(repairJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(repairJson('not json at all'), null);
});

test('transformMessages merges system turns and flattens tool results', () => {
  const out = transformMessages(
    [
      { role: 'system', content: 'be terse' },
      { role: 'system', content: 'you can call tools' },
      { role: 'user', content: 'read a' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'contents of a' },
      { role: 'user', content: [{ type: 'text', text: 'thanks' }, { type: 'image_url', image_url: { url: 'x' } }] },
    ],
    'xml',
  );
  assert.equal(out[0].role, 'system');
  assert.match(out[0].content, /be terse\n\nyou can call tools/);
  assert.match(out[2].content, /<tool_call>/);
  assert.match(out[3].content, /<tool_result name="read_file"/);
  assert.match(out[4].content, /image omitted/);
});
