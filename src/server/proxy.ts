import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { all, get, setting, sha256 } from './db.ts';
import {
  autoCandidates,
  candidatesFor,
  chainByName,
  markFailure,
  markSuccess,
  orderCandidates,
  recordUsage,
  type Candidate,
} from './router.ts';
import { callUpstream, type ChatPayload } from './adapters.ts';
import type { Strategy } from '../shared/types.ts';
import { scheduleDoctor } from './doctor.ts';

export const proxy = Router();

interface KeyRow {
  id: string;
  name: string;
  rpm: number;
  rpd: number;
}

export function authenticate(req: Request): { key: KeyRow | null; error?: string } {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : (req.headers['x-api-key'] as string) ?? '';
  if (!token) return { key: null, error: 'missing api key: send Authorization: Bearer <comb key>' };
  const row = get<KeyRow>(
    'select id, name, rpm, rpd from api_keys where hash = ? and revoked = 0',
    sha256(token.trim()),
  );
  if (!row) return { key: null, error: 'invalid api key' };
  return { key: row };
}

function keyLimited(key: KeyRow): string | null {
  if (key.rpm > 0) {
    const n = get<{ n: number }>(
      'select count(*) n from usage where key_id = ? and ts > ?',
      key.id,
      Date.now() - 60_000,
    );
    if (Number(n?.n ?? 0) >= key.rpm) return `key rate limit: ${key.rpm} requests per minute`;
  }
  if (key.rpd > 0) {
    const n = get<{ n: number }>(
      'select count(*) n from usage where key_id = ? and ts > ?',
      key.id,
      Date.now() - 86_400_000,
    );
    if (Number(n?.n ?? 0) >= key.rpd) return `key rate limit: ${key.rpd} requests per day`;
  }
  return null;
}

const chunkId = () => 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 24);

function sse(res: Response, data: unknown) {
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

function chunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/** Streams an emulated answer in slices so clients get a normal chunked reply. */
function sliceForStream(text: string): string[] {
  const size = 64;
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [''];
}

export interface ChatOutcome {
  status: number;
  body: any;
}

/** Non-streaming call path shared by the proxy and the playground. */
export async function chatOnce(
  payload: ChatPayload,
  keyId: string | null,
  strategyOverride?: Strategy,
): Promise<ChatOutcome> {
  const resolved = resolveTargets(payload.model, strategyOverride);
  if (!resolved.candidates.length) {
    return {
      status: 404,
      body: { error: { message: `no active upstream for model "${payload.model}"`, type: 'model_not_found' } },
    };
  }

  const maxAttempts = Math.max(1, Number(setting('max_attempts', '4')) || 4);
  const attempts = resolved.candidates.slice(0, maxAttempts);
  const failures: { model: string; upstream: string; error: string }[] = [];

  for (const candidate of attempts) {
    const started = Date.now();
    const result = await callUpstream(candidate, { ...payload, stream: false });
    const latency = Date.now() - started;
    if (result.ok) {
      markSuccess(candidate.model.id);
      recordUsage({
        keyId,
        model: payload.model,
        upstreamId: candidate.upstream.id,
        status: 200,
        ok: true,
        latencyMs: latency,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      });
      return {
        status: 200,
        body: completionBody(payload.model, candidate, result, latency, attempts.indexOf(candidate) + 1),
      };
    }
    markFailure(candidate.model.id, result.error ?? `status ${result.status}`, result.retryAfterMs);
    scheduleDoctor(candidate.upstream.plugin_id);
    recordUsage({
      keyId,
      model: payload.model,
      upstreamId: candidate.upstream.id,
      status: result.status,
      ok: false,
      latencyMs: latency,
      error: result.error,
    });
    failures.push({ model: candidate.model.id, upstream: candidate.upstream.name, error: result.error ?? 'failed' });
  }

  return {
    status: 502,
    body: {
      error: {
        message: 'every upstream failed',
        type: 'upstream_error',
        attempts: failures,
      },
    },
  };
}

function completionBody(
  requested: string,
  candidate: Candidate,
  result: { content: string; toolCalls: any[]; finish: string; tokensIn: number; tokensOut: number },
  latency: number,
  attempts: number,
) {
  return {
    id: chunkId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requested,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: result.content || null,
          ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
        },
        finish_reason: result.finish,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: result.tokensIn,
      completion_tokens: result.tokensOut,
      total_tokens: result.tokensIn + result.tokensOut,
    },
    comb: {
      routed_model: candidate.model.id,
      upstream: candidate.upstream.name,
      emulated_tools: candidate.model.tools_mode === 'emulate',
      attempts,
      latency_ms: latency,
      chain: candidate.chain ?? null,
    },
  };
}

export function resolveTargets(model: string, strategyOverride?: Strategy) {
  const chain = chainByName(model);
  const strategy: Strategy =
    strategyOverride ?? ((chain?.strategy as Strategy) ?? (setting('strategy', 'priority') as Strategy));
  if (model === 'auto') {
    return { strategy: 'priority' as Strategy, candidates: autoCandidates(), auto: true };
  }
  return { strategy, candidates: orderCandidates(candidatesFor(model), strategy), auto: false };
}

proxy.post('/v1/chat/completions', async (req: Request, res: Response) => {
  const auth = authenticate(req);
  if (!auth.key) {
    res.status(401).json({ error: { message: auth.error, type: 'invalid_request_error' } });
    return;
  }
  const limited = keyLimited(auth.key);
  if (limited) {
    res.status(429).json({ error: { message: limited, type: 'rate_limit_error' } });
    return;
  }

  const payload = req.body as ChatPayload;
  if (typeof payload?.model !== 'string' || !Array.isArray(payload?.messages)) {
    res.status(400).json({ error: { message: 'model and messages are required', type: 'invalid_request_error' } });
    return;
  }

  const headerStrategy = req.headers['x-comb-strategy'] as Strategy | undefined;
  const resolved = resolveTargets(payload.model, headerStrategy);
  if (!resolved.candidates.length) {
    res.status(404).json({
      error: {
        message: `no active upstream for model "${payload.model}"`,
        type: 'model_not_found',
        hint: 'add an upstream, or call a chain name such as "auto"',
      },
    });
    return;
  }

  if (!payload.stream) {
    const outcome = await chatOnce(payload, auth.key.id, headerStrategy);
    res.status(outcome.status).json(outcome.body);
    return;
  }

  // Streaming headers go out before the first upstream byte so a slow provider
  // does not look like a hang. A total failure then arrives as an SSE error
  // event rather than an HTTP status; clients see a normal end of stream.
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders?.();

  const id = chunkId();
  const requested = payload.model;
  const maxAttempts = Math.max(1, Number(setting('max_attempts', '4')) || 4);
  const attempts = resolved.candidates.slice(0, maxAttempts);
  const failures: { model: string; error: string }[] = [];
  let sent = false;

  for (const candidate of attempts) {
    if (sent) break;
    const started = Date.now();
    const limit = keyLimited(auth.key);
    if (limit) {
      sse(res, { error: { message: limit, type: 'rate_limit_error' } });
      sse(res, '[DONE]');
      res.end();
      return;
    }

    let streamed = '';
    const result = await callUpstream(candidate, { ...payload, stream: true }, {
      stream: true,
      onText: (delta) => {
        if (!delta) return;
        sent = true;
        streamed += delta;
        sse(res, chunk(id, requested, { content: delta }));
      },
    });
    const latency = Date.now() - started;

    if (result.ok) {
      markSuccess(candidate.model.id);
      recordUsage({
        keyId: auth.key.id,
        model: requested,
        upstreamId: candidate.upstream.id,
        status: 200,
        ok: true,
        latencyMs: latency,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        streamed: true,
      });

      if (!sent) {
        sse(res, chunk(id, requested, { role: 'assistant', content: '' }));
        // Emulated upstreams answer in one block; slice it so the client still
        // sees a chunked stream instead of a single burst.
        const pieces = sliceForStream(result.content);
        for (const piece of pieces) if (piece) sse(res, chunk(id, requested, { content: piece }));
      } else if (result.content.length > streamed.length) {
        const rest = result.content.slice(streamed.length);
        if (rest) sse(res, chunk(id, requested, { content: rest }));
      }

      if (result.toolCalls.length) {
        sse(
          res,
          chunk(id, requested, {
            tool_calls: result.toolCalls.map((tc, index) => ({
              index,
              id: tc.id,
              type: 'function',
              function: tc.function,
            })),
          }),
        );
      }
      sse(res, chunk(id, requested, {}, result.finish));
      sse(res, {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: requested,
        choices: [],
        usage: {
          prompt_tokens: result.tokensIn,
          completion_tokens: result.tokensOut,
          total_tokens: result.tokensIn + result.tokensOut,
        },
      });
      sse(res, '[DONE]');
      res.end();
      return;
    }

    markFailure(candidate.model.id, result.error ?? `status ${result.status}`, result.retryAfterMs);
    scheduleDoctor(candidate.upstream.plugin_id);
    recordUsage({
      keyId: auth.key.id,
      model: requested,
      upstreamId: candidate.upstream.id,
      status: result.status,
      ok: false,
      latencyMs: latency,
      error: result.error,
      streamed: true,
    });
    failures.push({ model: candidate.model.id, error: result.error ?? 'failed' });
  }

  sse(res, { error: { message: 'every upstream failed', type: 'upstream_error', attempts: failures } });
  sse(res, '[DONE]');
  res.end();
});

proxy.get('/v1/models', (req: Request, res: Response) => {
  const auth = authenticate(req);
  if (!auth.key) {
    res.status(401).json({ error: { message: auth.error, type: 'invalid_request_error' } });
    return;
  }
  const models = all<any>(
    `select m.id, m.display_name, m.context_window, m.tools_mode, m.tool_variant, u.name as upstream
       from models m join upstreams u on u.id = m.upstream_id
      where m.enabled = 1 and u.status = 'active'`,
  );
  const chains = all<any>('select name, description from chains where enabled = 1');
  res.json({
    object: 'list',
    data: [
      { id: 'auto', object: 'model', created: 0, owned_by: 'comb', comb: { auto: true } },
      ...chains.map((c) => ({
        id: c.name,
        object: 'model',
        created: 0,
        owned_by: 'comb',
        comb: { chain: true, description: c.description },
      })),
      ...models.map((m) => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: m.upstream,
        comb: {
          context_window: m.context_window,
          tools: m.tools_mode,
          tool_variant: m.tools_mode === 'emulate' ? m.tool_variant : null,
        },
      })),
    ],
  });
});

proxy.post('/v1/embeddings', (_req, res) => {
  res.status(501).json({
    error: {
      message: 'embeddings are not routed yet; comb forwards chat completions only',
      type: 'not_implemented',
    },
  });
});

proxy.get('/v1/health', (_req, res) => {
  const cooling = all<any>('select model_id, until_ms, reason from cooldowns where until_ms > ?', Date.now());
  res.json({ ok: true, cooling });
});

/** Used by the dashboard playground: runs the same path without a client key. */
export async function playgroundChat(payload: ChatPayload) {
  const outcome = await chatOnce(payload, null);
  return outcome;
}

export function recentUsage(sinceMs: number) {
  return all<any>('select * from usage where ts > ? order by ts desc', Date.now() - sinceMs);
}
