import { all, nowIso, setting, setSetting } from './db.ts';
import { refreshUpstream, upstreamBusy } from './refresh.ts';

// Background upkeep: refresh every active upstream, discover models, and
// calibrate only what is still unproven. Runs are serial and never overlap.

const DEFAULT_INTERVAL = 60;
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 1440;
const FAILED_RETRY_MS = 6 * 3_600_000;

export interface SchedulerSummary {
  at: string;
  trigger: string;
  upstreams: number;
  refreshed: number;
  calibrated: number;
  failed: number;
  healthy: number;
  skipped: number;
  warnings: string[];
}

export interface SchedulerState {
  enabled: boolean;
  interval_minutes: number;
  running: boolean;
  last_run: string | null;
  next_run: string | null;
  last_summary: SchedulerSummary | null;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

const intervalMs = () => schedulerInterval() * 60_000;

export const schedulerInterval = (): number => {
  const raw = Number(setting('scheduler_interval_minutes', String(DEFAULT_INTERVAL)));
  if (!Number.isFinite(raw)) return DEFAULT_INTERVAL;
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(raw)));
};

export const schedulerEnabled = (): boolean => setting('scheduler_enabled', '0') === '1';

export function schedulerState(): SchedulerState {
  let summary: SchedulerSummary | null = null;
  try {
    summary = JSON.parse(setting('scheduler_last_summary', '') || 'null');
  } catch {
    summary = null;
  }
  return {
    enabled: schedulerEnabled(),
    interval_minutes: schedulerInterval(),
    running,
    last_run: setting('scheduler_last_run', '') || null,
    next_run: setting('scheduler_next_run', '') || null,
    last_summary: summary,
  };
}

function scheduleNext(delay = intervalMs()) {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!schedulerEnabled()) {
    setSetting('scheduler_next_run', '');
    return;
  }
  setSetting('scheduler_next_run', new Date(Date.now() + delay).toISOString());
  timer = setTimeout(() => {
    timer = null;
    void runSchedulerTick('scheduled');
  }, delay);
  // Never keep the process alive just for the scheduler.
  timer.unref?.();
}

export function configureScheduler(input: { enabled?: boolean; interval_minutes?: number }): SchedulerState {
  if (input.enabled !== undefined) setSetting('scheduler_enabled', input.enabled ? '1' : '0');
  if (input.interval_minutes !== undefined) {
    const value = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(Number(input.interval_minutes))));
    if (Number.isFinite(value)) setSetting('scheduler_interval_minutes', String(value));
  }
  scheduleNext();
  return schedulerState();
}

/** Starts the timer after boot. Overdue runs fire shortly after start. */
export function startScheduler() {
  if (!schedulerEnabled()) {
    setSetting('scheduler_next_run', '');
    return;
  }
  const stored = setting('scheduler_next_run', '');
  const due = stored ? Date.parse(stored) - Date.now() : 0;
  scheduleNext(due > 60_000 ? due : 5_000);
}

/**
 * Runs one pass. Returns immediately with a skipped marker when a previous
 * pass is still going, so a slow connector cannot pile up runs.
 */
export async function runSchedulerTick(trigger = 'manual'): Promise<SchedulerSummary | { skipped: string }> {
  if (running) return { skipped: 'a scheduler run is already in progress' };
  running = true;
  const summary: SchedulerSummary = {
    at: nowIso(),
    trigger,
    upstreams: 0,
    refreshed: 0,
    calibrated: 0,
    failed: 0,
    healthy: 0,
    skipped: 0,
    warnings: [],
  };

  try {
    const upstreams = all<any>("select id, name from upstreams where status = 'active' order by created_at");
    summary.upstreams = upstreams.length;
    for (const up of upstreams) {
      if (upstreamBusy(up.id)) {
        summary.skipped++;
        summary.warnings.push(`${up.name}: refresh already running, skipped`);
        continue;
      }
      const result = await refreshUpstream(up.id, { retryFailedAfterMs: FAILED_RETRY_MS });
      if (result.error) {
        summary.skipped++;
        summary.warnings.push(`${up.name}: ${result.error}`);
        continue;
      }
      summary.refreshed++;
      summary.calibrated += result.calibrated;
      summary.failed += result.failed;
      if (result.healthy) summary.healthy++;
      for (const warning of result.warnings) summary.warnings.push(`${up.name}: ${warning}`);
    }
    setSetting('scheduler_last_run', summary.at);
    setSetting('scheduler_last_summary', JSON.stringify(summary));
  } finally {
    running = false;
    if (schedulerEnabled()) scheduleNext();
  }
  return summary;
}

/** Test helper: drop the pending timer without changing the saved settings. */
export function stopSchedulerTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}
