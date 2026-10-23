import { spawn } from 'node:child_process';
import { setting } from './db.ts';
import {
  buildProtocol,
  normalizeTools,
  parseToolCalls,
  transformMessages,
  type ToolCall,
  type ToolDef,
} from './tools.ts';
import type { Candidate } from './router.ts';

export interface ChatPayload {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  [key: string]: unknown;
}

export interface UpstreamResult {
  ok: boolean;
  status: number;
  content: string;
  toolCalls: ToolCall[];
  finish: string;
  tokensIn: number;
  tokensOut: number;
  error?: string;
  retryAfterMs?: number;
}

export interface CallOptions {
  stream?: boolean;
  onText?: (delta: string) => void;
}

const estimateTokens = (s: string) => Math.ceil(s.length / 4);

function parseJsonObject(value: string | null, fallback: Record<string, any>): Record<string, any> {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function protocolFor(c: Candidate, payload: ChatPayload, tools: ToolDef[]): string {
  if (!tools.length || c.model.tools_mode !== 'emulate' || payload.tool_choice === 'none') return '';
  return buildProtocol(
    tools,
    c.model.tool_variant,
    payload.tool_choice ?? 'auto',
    payload.parallel_tool_calls !== false,
  );
}

export function messagesFor(c: Candidate, payload: ChatPayload, protocol: string) {
  if (protocol) {
    const messages = transformMessages(payload.messages, c.model.tool_variant);
    if (messages[0]?.role === 'system') {
      return [
        { role: 'system', content: `${messages[0].content}\n\n${protocol}` },
        ...messages.slice(1),
      ];
    }
    return [{ role: 'system', content: protocol }, ...messages];
  }
  if (c.model.tools_mode === 'native') return payload.messages;
  return transformMessages(payload.messages, c.model.tool_variant);
}

export function buildCliPrompt(payload: ChatPayload, protocol: string): string {
  const transcript = transformMessages(payload.messages, 'xml')
    .map((m) => `${m.role === 'system' ? 'SYSTEM' : m.role === 'assistant' ? 'ASSISTANT' : 'USER'}: ${m.content}`)
    .join('\n\n');
  return protocol ? `${transcript}\n\n${protocol}` : transcript;
}

export async function callUpstream(
  c: Candidate,
  payload: ChatPayload,
  opts: CallOptions = {},
): Promise<UpstreamResult> {
  const tools = normalizeTools(payload.tools);
  const protocol = protocolFor(c, payload, tools);
  return c.upstream.adapter === 'cli-spawn'
    ? callCli(c, payload, tools, protocol, opts)
    : callHttp(c, payload, tools, protocol, opts);
}

function upstreamHeaders(up: Candidate['upstream']): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (up.api_key) headers.authorization = `Bearer ${up.api_key}`;
  if (up.auth_mode === 'cookie' && up.cookie) headers.cookie = up.cookie;
  return { ...headers, ...parseJsonObject(up.headers, {}) };
}

async function callHttp(
  c: Candidate,
  payload: ChatPayload,
  tools: ToolDef[],
  protocol: string,
  opts: CallOptions,
): Promise<UpstreamResult> {
  const up = c.upstream;
  const base = (up.base_url ?? '').replace(/\/+$/, '');
  if (!base) {
    return fail(0, 'upstream has no base_url');
  }
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  const extra = parseJsonObject(up.config, {});
  const emulating = !!protocol;
  const nativeTools = !emulating && up.adapter === 'openai-http' && c.model.tools_mode === 'native';

  const body: Record<string, unknown> = {
    model: c.model.upstream_model,
    messages: messagesFor(c, payload, protocol),
    stream: !!opts.stream,
  };
  for (const key of ['temperature', 'max_tokens', 'top_p', 'stop', 'presence_penalty', 'frequency_penalty', 'seed', 'response_format']) {
    if (payload[key] !== undefined) body[key] = payload[key];
  }
  if (nativeTools && tools.length) {
    body.tools = payload.tools;
    body.tool_choice = payload.tool_choice ?? 'auto';
    if (payload.parallel_tool_calls !== undefined) body.parallel_tool_calls = payload.parallel_tool_calls;
  }
  Object.assign(body, (extra.body as Record<string, unknown>) ?? {});

  const timeout = Number(extra.timeout_ms ?? setting('request_timeout_ms', '120000')) || 120_000;
  const started = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: upstreamHeaders(up),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err: any) {
    return {
      ...fail(0, `connect failed: ${err?.message ?? err}`),
      retryAfterMs: Date.now() - started,
      tokensIn: estimateTokens(JSON.stringify(payload.messages)),
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const retry = Number(res.headers.get('retry-after'));
    return {
      ...fail(res.status, `${res.status} ${text.slice(0, 400)}`),
      retryAfterMs: Number.isFinite(retry) ? retry * 1000 : undefined,
      tokensIn: estimateTokens(JSON.stringify(payload.messages)),
    };
  }

  const tokensInGuess = estimateTokens(JSON.stringify(payload.messages));

  if (opts.stream && res.headers.get('content-type')?.includes('event-stream')) {
    const acc = { content: '', finish: 'stop', tokensOut: 0, calls: new Map<number, ToolCall>() };
    await readSse(res, (event) => {
      const choice = event?.choices?.[0];
      const delta = choice?.delta;
      if (choice?.finish_reason) acc.finish = choice.finish_reason;
      if (event?.usage?.completion_tokens) acc.tokensOut = event.usage.completion_tokens;
      if (!delta) return;
      if (typeof delta.content === 'string' && delta.content) {
        acc.content += delta.content;
        opts.onText?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const index = Number(tc.index ?? 0);
        const cur =
          acc.calls.get(index) ??
          ({ id: tc.id ?? `call_${index}`, type: 'function', function: { name: '', arguments: '' } } as ToolCall);
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        acc.calls.set(index, cur);
      }
    });
    const toolCalls = [...acc.calls.values()].filter((x) => x.function.name);
    return {
      ok: true,
      status: 200,
      content: acc.content,
      toolCalls: emulating ? [] : toolCalls,
      finish: toolCalls.length ? 'tool_calls' : acc.finish,
      tokensIn: tokensInGuess,
      tokensOut: acc.tokensOut || estimateTokens(acc.content),
    };
  }

  const json: any = await res.json().catch(() => null);
  if (!json) return { ...fail(res.status, 'upstream returned non-JSON'), tokensIn: tokensInGuess };

  const message = json.choices?.[0]?.message ?? json.message ?? {};
  const content = typeof message.content === 'string' ? message.content : textFromParts(message.content);
  const finish = json.choices?.[0]?.finish_reason ?? 'stop';

  if (emulating) {
    const parsed = parseToolCalls(content, tools, c.model.tool_variant);
    if (parsed.calls.length && opts.onText) opts.onText(parsed.text);
    return {
      ok: true,
      status: 200,
      content: parsed.text,
      toolCalls: parsed.calls,
      finish: parsed.calls.length ? 'tool_calls' : 'stop',
      tokensIn: Number(json.usage?.prompt_tokens) || tokensInGuess,
      tokensOut: Number(json.usage?.completion_tokens) || estimateTokens(content),
    };
  }

  const nativeCalls: ToolCall[] = (message.tool_calls ?? []).map((tc: any, i: number) => ({
    id: tc.id ?? `call_${i}`,
    type: 'function' as const,
    function: {
      name: tc.function?.name ?? tc.name ?? '',
      arguments:
        typeof tc.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? tc.arguments ?? {}),
    },
  }));

  const parsedFallback = nativeCalls.length
    ? { text: content, calls: nativeCalls }
    : tools.length && c.model.tools_mode !== 'off'
      ? parseToolCalls(content, tools, c.model.tool_variant)
      : { text: content, calls: [] as ToolCall[] };

  return {
    ok: true,
    status: 200,
    content: parsedFallback.text,
    toolCalls: parsedFallback.calls,
    finish: parsedFallback.calls.length ? 'tool_calls' : finish,
    tokensIn: Number(json.usage?.prompt_tokens) || tokensInGuess,
    tokensOut: Number(json.usage?.completion_tokens) || estimateTokens(content),
  };
}

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts.map((p: any) => p?.text ?? '').join('');
}

async function readSse(res: Response, onEvent: (event: any) => void) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            onEvent(JSON.parse(data));
          } catch {
            // Some connectors interleave keep-alive frames.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function callCli(
  c: Candidate,
  payload: ChatPayload,
  tools: ToolDef[],
  protocol: string,
  opts: CallOptions,
): Promise<UpstreamResult> {
  const config = parseJsonObject(c.upstream.config, {});
  const template = String(config.cli_command ?? '').trim();
  if (!template) return fail(0, 'CLI upstream has no cli_command in its config');

  const prompt = buildCliPrompt(payload, protocol);
  const env = {
    ...process.env,
    COMB_PROMPT: prompt,
    COMB_MODEL: c.model.upstream_model,
    COMB_TOOLS: JSON.stringify(tools),
  };
  const timeout = Number(config.timeout_ms ?? 180_000) || 180_000;
  const started = Date.now();

  const { code, stdout, stderr } = await new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn('/bin/bash', ['-lc', template], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
      child.stdout.on('data', (b) => (out += b.toString()));
      child.stderr.on('data', (b) => (err += b.toString()));
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ code: exitCode ?? 1, stdout: out, stderr: err });
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: 1, stdout: '', stderr: String(e) });
      });
    },
  );

  if (code !== 0 && !stdout.trim()) {
    return { ...fail(502, `cli exit ${code}: ${stderr.slice(0, 400)}`), retryAfterMs: Date.now() - started };
  }

  const parsed = tools.length && c.model.tools_mode !== 'off'
    ? parseToolCalls(stdout, tools, c.model.tool_variant)
    : { text: stdout.trim(), calls: [] as ToolCall[] };
  if (opts.onText && parsed.text) opts.onText(parsed.text);

  return {
    ok: true,
    status: 200,
    content: parsed.text,
    toolCalls: parsed.calls,
    finish: parsed.calls.length ? 'tool_calls' : 'stop',
    tokensIn: estimateTokens(prompt),
    tokensOut: estimateTokens(stdout),
  };
}

function fail(status: number, error: string): UpstreamResult {
  return { ok: false, status, content: '', toolCalls: [], finish: 'error', tokensIn: 0, tokensOut: 0, error };
}

/** Health probe used by the inspector and the emulation recalibration. */
export async function probe(c: Candidate, messages: unknown[], tools?: unknown[]): Promise<UpstreamResult> {
  return callUpstream(c, { model: c.model.id, messages, tools, stream: false });
}
