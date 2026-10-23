import { all, get, run, nowIso, setting } from './db.ts';
import type { Chain, Model, Strategy, Upstream } from '../shared/types.ts';

export interface Candidate {
  model: Model;
  upstream: Upstream;
  chain?: string;
}

export const STRATEGIES: Strategy[] = [
  'priority',
  'weighted',
  'round_robin',
  'least_used',
  'fastest',
  'cheapest',
  'quota_headroom',
];

const modelRows = (where: string, ...params: (string | number)[]) =>
  all<Model>(`select * from models m where m.enabled = 1 ${where}`, ...params);

export function upstreamById(id: string): Upstream | undefined {
  return get<Upstream>('select * from upstreams where id = ?', id);
}

export function modelById(id: string): Model | undefined {
  return get<Model>('select * from models where id = ?', id);
}

export function chainByName(name: string): Chain | undefined {
  return get<Chain>('select * from chains where name = ? and enabled = 1', name);
}

function enabledUpstream(id: string | null): Upstream | undefined {
  if (!id) return undefined;
  const up = upstreamById(id);
  return up && up.status === 'active' ? up : undefined;
}

/** Expands a chain (or a bare model id) into model+upstream pairs. */
export function candidatesFor(name: string): Candidate[] {
  const chain = chainByName(name);
  if (chain) {
    const ids: string[] = JSON.parse(chain.members || '[]');
    return ids
      .map((id) => {
        const model = modelById(id);
        const upstream = enabledUpstream(model?.upstream_id ?? null);
        return model && upstream ? { model, upstream, chain: chain.name } : null;
      })
      .filter(Boolean) as Candidate[];
  }

  // Exact canonical id first, then a unique upstream_model match.
  const exact = modelById(name);
  if (exact) {
    const upstream = enabledUpstream(exact.upstream_id);
    return upstream ? [{ model: exact, upstream }] : [];
  }
  const loose = modelRows('and (m.upstream_model = ? or m.id like ?)', name, `%/${name}`);
  return loose
    .map((model) => {
      const upstream = enabledUpstream(model.upstream_id);
      return upstream ? { model, upstream } : null;
    })
    .filter(Boolean) as Candidate[];
}

/** `auto` walks every enabled model, healthiest first. */
export function autoCandidates(): Candidate[] {
  const rows = modelRows('');
  const cands = rows
    .map((model) => {
      const upstream = enabledUpstream(model.upstream_id);
      return upstream ? { model, upstream } : null;
    })
    .filter(Boolean) as Candidate[];
  return orderCandidates(cands, 'priority', true);
}

export interface ModelStats {
  total: number;
  ok: number;
  avgLatency: number;
  lastOk: number;
  failures: number;
  cooldownUntil: number;
  rpm: number;
  rpd: number;
}

export function statsFor(modelId: string, upstreamId: string): ModelStats {
  const dayAgo = Date.now() - 86_400_000;
  const row = get<{ total: number; ok: number; avgLatency: number; lastOk: number }>(
    `select count(*) total, coalesce(sum(ok),0) ok, coalesce(avg(latency_ms),0) avgLatency,
            coalesce(max(case when ok = 1 then ts else 0 end),0) lastOk
       from usage where model = ? and ts > ?`,
    modelId,
    dayAgo,
  );
  const cd = get<{ failures: number; until_ms: number }>(
    'select failures, until_ms from cooldowns where model_id = ?',
    modelId,
  );
  const rpm = get<{ n: number }>(
    'select count(*) n from usage where upstream_id = ? and ts > ?',
    upstreamId,
    Date.now() - 60_000,
  );
  const rpd = get<{ n: number }>(
    'select count(*) n from usage where upstream_id = ? and ts > ?',
    upstreamId,
    dayAgo,
  );
  return {
    total: Number(row?.total ?? 0),
    ok: Number(row?.ok ?? 0),
    avgLatency: Number(row?.avgLatency ?? 0),
    lastOk: Number(row?.lastOk ?? 0),
    failures: Number(cd?.failures ?? 0),
    cooldownUntil: Number(cd?.until_ms ?? 0),
    rpm: Number(rpm?.n ?? 0),
    rpd: Number(rpd?.n ?? 0),
  };
}

export function inCooldown(modelId: string): boolean {
  const cd = get<{ until_ms: number }>('select until_ms from cooldowns where model_id = ?', modelId);
  return !!cd && cd.until_ms > Date.now();
}

export function cooldownReason(modelId: string): string | null {
  const cd = get<{ until_ms: number; reason: string | null }>(
    'select until_ms, reason from cooldowns where model_id = ?',
    modelId,
  );
  return cd && cd.until_ms > Date.now() ? cd.reason ?? 'cooldown' : null;
}

export function markFailure(modelId: string, reason: string, retryAfterMs?: number) {
  const base = Number(setting('cooldown_base_ms', '30000')) || 30_000;
  const prev = get<{ failures: number }>('select failures from cooldowns where model_id = ?', modelId);
  const failures = Math.min(Number(prev?.failures ?? 0) + 1, 8);
  const backoff = Math.min(base * 2 ** (failures - 1), 15 * 60_000);
  const until = Date.now() + Math.max(backoff, retryAfterMs ?? 0);
  run(
    `insert into cooldowns(model_id, failures, until_ms, reason) values(?,?,?,?)
     on conflict(model_id) do update set failures = excluded.failures,
       until_ms = excluded.until_ms, reason = excluded.reason`,
    modelId,
    failures,
    until,
    reason,
  );
}

export function markSuccess(modelId: string) {
  run('update cooldowns set failures = 0, until_ms = 0, reason = null where model_id = ?', modelId);
}

let rrCursor = 0;

/**
 * Orders candidates for one attempt. `priority` keeps chain order; every other
 * strategy reorders, and unavailable ones (cooling, rate limited) go last instead
 * of being dropped, so a final attempt can still try them.
 */
export function orderCandidates(cands: Candidate[], strategy: Strategy, auto = false): Candidate[] {
  const withStats = cands.map((c) => ({
    c,
    s: statsFor(c.model.id, c.upstream.id),
    cost: Number(c.upstream.cost_per_1k) || 0,
    weight: Math.max(1, Number(c.upstream.weight) || 1),
  }));

  const score = (x: (typeof withStats)[number]) => {
    const prior = x.s.total + 2;
    const okRate = (x.s.ok + 1) / prior;
    const speed = 1 / (1 + x.s.avgLatency / 2000);
    const cost = x.cost <= 0 ? 1 : 1 / (1 + x.cost);
    const headroom = x.c.upstream.max_rpm > 0 ? Math.max(0, 1 - x.s.rpm / x.c.upstream.max_rpm) : 1;
    return 0.5 * okRate + 0.25 * speed + 0.15 * cost + 0.1 * headroom;
  };

  let ordered = [...withStats];
  switch (strategy) {
    case 'weighted': {
      // Weighted shuffle: higher weight is more likely to land first.
      ordered.sort((a, b) => b.weight * Math.random() - a.weight * Math.random());
      break;
    }
    case 'round_robin': {
      const n = ordered.length;
      if (n) {
        const off = rrCursor++ % n;
        ordered = [...ordered.slice(off), ...ordered.slice(0, off)];
      }
      break;
    }
    case 'least_used':
      ordered.sort((a, b) => a.s.total - b.s.total);
      break;
    case 'fastest':
      ordered.sort((a, b) => (a.s.avgLatency || 1e9) - (b.s.avgLatency || 1e9));
      break;
    case 'cheapest':
      ordered.sort((a, b) => a.cost - b.cost);
      break;
    case 'quota_headroom':
      ordered.sort((a, b) => {
        const h = (x: (typeof withStats)[number]) =>
          x.c.upstream.max_rpm > 0 ? 1 - x.s.rpm / x.c.upstream.max_rpm : 1;
        return h(b) - h(a);
      });
      break;
    default:
      if (auto) ordered.sort((a, b) => score(b) - score(a));
  }

  const usable = (x: (typeof withStats)[number]) =>
    !inCooldown(x.c.model.id) &&
    !(x.c.upstream.max_rpm > 0 && x.s.rpm >= x.c.upstream.max_rpm) &&
    !(x.c.upstream.max_rpd > 0 && x.s.rpd >= x.c.upstream.max_rpd);

  const ready = ordered.filter(usable);
  const blocked = ordered.filter((x) => !usable(x));
  return [...ready, ...blocked].map((x) => x.c);
}

export function recordUsage(row: {
  keyId: string | null;
  model: string;
  upstreamId: string | null;
  status: number;
  ok: boolean;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  error?: string | null;
  streamed?: boolean;
}) {
  run(
    `insert into usage(ts, key_id, model, upstream_id, status, ok, latency_ms, tokens_in, tokens_out, error, streamed)
     values(?,?,?,?,?,?,?,?,?,?,?)`,
    Date.now(),
    row.keyId,
    row.model,
    row.upstreamId,
    row.status,
    row.ok ? 1 : 0,
    Math.round(row.latencyMs),
    row.tokensIn ?? 0,
    row.tokensOut ?? 0,
    row.error ?? null,
    row.streamed ? 1 : 0,
  );
}

export const now = nowIso;
