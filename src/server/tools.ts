import { randomBytes } from 'node:crypto';
import type { ToolVariant } from '../shared/types.ts';

// Tool emulation for upstreams that only speak plain text (every web2api
// connector, most CLI wrappers). The goal is that a client with native tool
// definitions cannot tell the difference: it gets OpenAI tool_calls back, with
// valid names, parsed arguments and a finish_reason of "tool_calls".

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ParseResult {
  text: string;
  calls: ToolCall[];
  invalid: { name?: string; reason: string; raw: string }[];
}

export const VARIANTS: ToolVariant[] = ['xml', 'fence', 'json'];

const callId = () => 'call_' + randomBytes(9).toString('base64url');

export function normalizeTools(tools: unknown): ToolDef[] {
  if (!Array.isArray(tools)) return [];
  const out: ToolDef[] = [];
  for (const t of tools) {
    const fn = (t as any)?.function ?? t;
    const name = typeof fn?.name === 'string' ? fn.name.trim() : '';
    if (!name) continue;
    out.push({
      name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters:
        fn.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} },
    });
  }
  return out;
}

/** Flattens OpenAI content parts down to text for text-only upstreams. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content
    .map((p: any) => {
      if (typeof p === 'string') return p;
      if (p?.type === 'text') return p.text ?? '';
      if (p?.type === 'image_url') return '[image omitted: upstream has no vision]';
      return '';
    })
    .join('\n');
}

function protocolBody(variant: ToolVariant): { open: string; close: string; rule: string } {
  if (variant === 'fence') {
    return {
      open: '```tool_call\n',
      close: '\n```',
      rule: 'Wrap the call in a ```tool_call fenced block.',
    };
  }
  if (variant === 'json') {
    return {
      open: '',
      close: '',
      rule:
        'When you call a tool, reply with only this JSON object and nothing else:\n' +
        '{"tool_calls":[{"name":"<tool_name>","arguments":{...}}]}',
    };
  }
  return {
    open: '<tool_call>',
    close: '</tool_call>',
    rule:
      'When you call a tool, emit one block per call, on its own line:\n' +
      '<tool_call>{"name":"<tool_name>","arguments":{...}}</tool_call>',
  };
}

export function buildProtocol(
  tools: ToolDef[],
  variant: ToolVariant = 'xml',
  toolChoice: unknown = 'auto',
  parallel = true,
): string {
  if (!tools.length) return '';
  const { rule } = protocolBody(variant);
  const forced = forcedToolName(toolChoice);
  const choiceRule = forced
    ? `You must call the tool "${forced}" now, before writing any prose.`
    : toolChoice === 'required'
      ? 'You must call at least one tool now, before writing any prose.'
      : 'Call a tool only when it is needed to answer or to act. Otherwise answer normally.';

  const lines = [
    'TOOL PROTOCOL',
    'You are connected to a tool runner through a text channel. The client executes the calls you emit and sends the results back.',
    rule,
    '- "arguments" is always a JSON object that matches the parameter schema. Use {} when the tool takes no arguments.',
    '- Never invent tool names, never add fields the schema does not define.',
    '- Do not describe a call in prose. Do not use any other fence or tag for a call.',
    parallel
      ? '- Several adjacent blocks in one reply are executed in parallel.'
      : '- Emit at most one call per reply.',
    '- After a tool result comes back, use it and either call another tool or answer the user.',
    choiceRule,
    '',
    'AVAILABLE TOOLS',
    ...tools.map(
      (t) =>
        `<tool name="${t.name}" description="${t.description.replace(/"/g, "'")}">\n${JSON.stringify(t.parameters)}\n</tool>`,
    ),
  ];
  return lines.join('\n');
}

export function forcedToolName(toolChoice: unknown): string | null {
  const tc = toolChoice as any;
  if (tc && typeof tc === 'object') {
    if (tc.type === 'function' && typeof tc.function?.name === 'string') return tc.function.name;
    if (typeof tc.name === 'string') return tc.name;
  }
  return null;
}

/** Rewrites a conversation into the text protocol, so history stays coherent. */
export function transformMessages(
  messages: unknown,
  variant: ToolVariant = 'xml',
): { role: string; content: string }[] {
  const list = Array.isArray(messages) ? messages : [];
  const { open, close } = protocolBody(variant);
  const system: string[] = [];
  const out: { role: string; content: string }[] = [];

  const renderCalls = (calls: any[]) =>
    calls
      .map((c) => {
        const name = c?.function?.name ?? c?.name ?? '';
        const args = parseArgsLoose(c?.function?.arguments ?? c?.arguments ?? {});
        return open + JSON.stringify({ name, arguments: args }) + close;
      })
      .join('\n');

  for (const m of list as any[]) {
    const role = m?.role ?? 'user';
    if (role === 'system' || role === 'developer') {
      // Most web backends reject a mid-conversation system turn, so merge them.
      const text = textOf(m.content).trim();
      if (text) system.push(text);
      continue;
    }
    if (role === 'tool' || role === 'function') {
      out.push({
        role: 'user',
        content: `<tool_result name="${m.name ?? 'tool'}" id="${m.tool_call_id ?? ''}">\n${textOf(m.content)}\n</tool_result>`,
      });
      continue;
    }
    if (role === 'assistant') {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      const body = [textOf(m.content).trim(), calls.length ? renderCalls(calls) : '']
        .filter(Boolean)
        .join('\n');
      out.push({ role: 'assistant', content: body });
      continue;
    }
    out.push({ role: role === 'assistant' ? 'assistant' : 'user', content: textOf(m.content) });
  }

  // Drop tool turns with no preceding assistant turn; some backends 400 on those.
  return system.length ? [{ role: 'system', content: system.join('\n\n') }, ...out] : out;
}

function parseArgsLoose(args: unknown): Record<string, unknown> {
  if (typeof args === 'string') {
    const parsed = repairJson(args);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  }
  if (args && typeof args === 'object') return args as Record<string, unknown>;
  return {};
}

/** JSON.parse with the usual model mistakes patched: fences, trailing commas, quotes. */
export function repairJson(raw: unknown): any | null {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/^```(?:json|tool_call)?\s*/i, '').replace(/```$/, '').trim();
  if (!s) return null;
  const candidates = [s];
  const start = s.search(/[[{]/);
  const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (start >= 0 && end > start) candidates.push(s.slice(start, end + 1));

  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {}
  }
  const c = candidates[candidates.length - 1]
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)'([^'\\]*)'\s*:/g, '$1"$2":')
    .replace(/:\s*'([^'\\]*)'/g, ': "$1"')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
  try {
    return JSON.parse(c);
  } catch {
    return null;
  }
}

/** Balanced-brace scan, used when a model ignores the requested wrapper. */
function scanJsonObjects(text: string): { raw: string; start: number; end: number }[] {
  const found: { raw: string; start: number; end: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        found.push({ raw: text.slice(i, j + 1), start: i, end: j + 1 });
        i = j;
        break;
      }
    }
  }
  return found;
}

function asCallList(value: any): any[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.tool_calls)) return value.tool_calls;
  if (value.function || value.name) return [value];
  return [];
}

export function parseToolCalls(
  content: string,
  tools: ToolDef[],
  variant: ToolVariant = 'xml',
): ParseResult {
  const text = typeof content === 'string' ? content : '';
  const calls: ToolCall[] = [];
  const invalid: ParseResult['invalid'] = [];
  const spans: [number, number][] = [];
  const byName = new Map(tools.map((t) => [t.name.toLowerCase(), t.name]));

  const accept = (value: any, raw: string) => {
    for (const c of asCallList(value)) {
      const name = String(c?.name ?? c?.function?.name ?? c?.tool ?? '').trim();
      const args = c?.arguments ?? c?.function?.arguments ?? c?.parameters ?? c?.args ?? {};
      if (!name) {
        invalid.push({ reason: 'missing name', raw });
        continue;
      }
      const canonical = byName.get(name.toLowerCase());
      if (!canonical) {
        invalid.push({ name, reason: 'unknown tool', raw });
        continue;
      }
      const parsed = parseArgsLoose(args);
      if (typeof args === 'string' && Object.keys(parsed).length === 0 && args.trim() && args.trim() !== '{}') {
        invalid.push({ name, reason: 'unparsable arguments', raw });
        continue;
      }
      calls.push({
        id: callId(),
        type: 'function',
        function: { name: canonical, arguments: JSON.stringify(parsed) },
      });
    }
  };

  // 1. Explicit wrappers: <tool_call> and ```tool_call fences.
  const wrapped = [
    /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi,
    /```(?:tool_call|tool|json)\s*\n([\s\S]*?)```/gi,
  ];
  for (const re of wrapped) {
    for (const m of text.matchAll(re)) {
      const raw = m[1].trim();
      const parsed = repairJson(raw);
      if (parsed) {
        accept(parsed, raw);
        spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
      } else {
        invalid.push({ reason: 'unparsable block', raw });
      }
    }
  }

  // 2. Bare JSON, for models that ignore the wrapper entirely.
  if (!calls.length) {
    for (const c of scanJsonObjects(text)) {
      const parsed = repairJson(c.raw);
      if (!parsed) continue;
      const list = asCallList(parsed);
      if (!list.length) continue;
      const before = calls.length;
      accept(parsed, c.raw);
      if (calls.length > before) spans.push([c.start, c.end]);
    }
  }

  // 3. Whole-message JSON in the "json" variant.
  if (!calls.length && variant === 'json') {
    const parsed = repairJson(text.trim());
    if (parsed) accept(parsed, text.trim());
  }

  let cleaned = text;
  for (const [s, e] of spans.sort((a, b) => b[0] - a[0])) {
    cleaned = cleaned.slice(0, s) + cleaned.slice(e);
  }
  cleaned = cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  return { text: calls.length ? cleaned : text.trim(), calls, invalid };
}

/** finish_reason the client expects for a reply that contains calls. */
export const finishReason = (calls: ToolCall[]) => (calls.length ? 'tool_calls' : 'stop');

export function toolResultMessage(callIdValue: string, name: string, content: string) {
  return { role: 'tool', tool_call_id: callIdValue, name, content };
}
