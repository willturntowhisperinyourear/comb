import { all } from './db.ts';
import { PROVIDER_PRESETS } from './catalog.ts';
import { addModels } from './models.ts';
import { defaultToolsMode, discoverModels, pluginById, recalibrateModel, runningPlugins } from './plugins.ts';
import { upstreamById } from './router.ts';

// One refresh per upstream at a time, shared by the API, the setup wizard and
// the scheduler, so a scheduled tick never races a manual refresh.
const busy = new Set<string>();
export const upstreamBusy = (id: string) => busy.has(id);

export interface RefreshOptions {
  force?: boolean;
  /** Re-probe failed models only after this much time. 0 retries every run. */
  retryFailedAfterMs?: number;
  /** false keeps models uncalibrated, for installs that should not spend probes. */
  calibrate?: boolean;
}

export interface RefreshResult {
  discovered: string[];
  created: string[];
  existing: number;
  calibrated: number;
  failed: number;
  skipped: number;
  warnings: string[];
  healthy: boolean;
  connector_running: boolean;
  error?: string;
}

const empty = (): RefreshResult => ({
  discovered: [],
  created: [],
  existing: 0,
  calibrated: 0,
  failed: 0,
  skipped: 0,
  warnings: [],
  healthy: false,
  connector_running: false,
});

/**
 * Refresh one upstream: ask the connector what it serves now, keep every model
 * row that already exists, seed the preset list when the connector is down or
 * returns nothing, then calibrate only the emulated models that still need it.
 */
export async function refreshUpstream(upstreamId: string, opts: RefreshOptions = {}): Promise<RefreshResult> {
  const up = upstreamById(upstreamId);
  if (!up) return { ...empty(), error: 'upstream not found' };
  if (busy.has(up.id)) {
    return { ...empty(), error: 'a refresh is already running for this upstream', connector_running: false };
  }
  busy.add(up.id);
  try {
    const { force = false, retryFailedAfterMs = 0, calibrate = true } = opts;
    const preset = PROVIDER_PRESETS.find((p) => p.id === up.preset);
    const plugin = up.plugin_id ? pluginById(up.plugin_id) : null;
    const connectorRunning = plugin ? runningPlugins().includes(plugin.id) : false;
    const warnings: string[] = [];

    if (plugin && !connectorRunning) {
      warnings.push(
        `${plugin.name} is ${plugin.status}. Start it to discover live models; comb seeded the known ids instead.`,
      );
    }

    let live: { discovered: string[]; created: string[]; error?: string } = { discovered: [], created: [] };
    let reachable = false;
    if (up.adapter === 'openai-http' && (!plugin || connectorRunning)) {
      live = await discoverModels(up.id);
      if (live.error) warnings.push(`live discovery failed: ${live.error}`);
      else reachable = true;
    } else if (!plugin) {
      warnings.push('this upstream has no connector; live discovery was skipped');
    }

    let pluginSeed: string[] = [];
    if (plugin) {
      try {
        const parsed = JSON.parse(plugin.models_hint || '[]');
        if (Array.isArray(parsed)) pluginSeed = parsed.map(String);
      } catch {
        // A malformed hint is not worth failing the refresh over.
      }
    }
    const seeded = addModels(up.id, [...(preset?.models ?? []), ...pluginSeed], defaultToolsMode(up));
    if (!live.discovered.length && !seeded.created.length) {
      warnings.push('nothing came back from discovery or the preset; add model ids by hand');
    }

    const rows = all<any>('select * from models where upstream_id = ? order by id', up.id);
    // Probing a connector that is not running only produces "failed" noise, so
    // refresh leaves those models uncalibrated until it is back up.
    const canProbe = !plugin || connectorRunning;
    if (!canProbe) {
      warnings.push('calibration skipped while the connector is down; refresh again after starting it');
    }

    const failedRetryable = (m: any) =>
      !retryFailedAfterMs || !m.calibrated_at || Date.now() - Date.parse(m.calibrated_at) >= retryFailedAfterMs;

    const candidates = canProbe && calibrate
      ? rows.filter(
          (m) =>
            m.tools_mode === 'emulate' &&
            (force ||
              !m.calibration_status ||
              m.calibration_status === 'uncalibrated' ||
              (m.calibration_status === 'failed' && failedRetryable(m))),
        )
      : [];

    let calibrated = 0;
    let failed = 0;
    for (const model of candidates) {
      const report = await recalibrateModel(model.id);
      if (report.status === 'calibrated') calibrated++;
      else if (report.status === 'failed') failed++;
    }

    const created = [...new Set([...live.created, ...seeded.created])];
    return {
      discovered: live.discovered,
      created,
      existing: rows.length - created.length,
      calibrated,
      failed,
      skipped: rows.length - candidates.length,
      warnings,
      healthy: reachable || (!plugin && up.adapter === 'cli-spawn'),
      connector_running: plugin ? connectorRunning : true,
    };
  } finally {
    busy.delete(up.id);
  }
}
