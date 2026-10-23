import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, get, nowIso, PLUGIN_DIR, run, setting } from './db.ts';
import { PROVIDER_PRESETS } from './catalog.ts';
import type { Model, Plugin, ToolVariant } from '../shared/types.ts';
import { probe } from './adapters.ts';
import { modelById, upstreamById, type Candidate } from './router.ts';

const children = new Map<string, ChildProcess>();

// Logs live beside the checkouts: a file inside the checkout would make the
// directory non-empty and break `git clone` into it.
const logDir = join(DATA_DIR, 'logs');
mkdirSync(logDir, { recursive: true });
const logPath = (id: string) => join(logDir, `${id}.log`);

function log(id: string, line: string) {
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(logPath(id), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // A log that cannot be written must not take the server down.
  }
}

export function pluginLog(id: string, lines = 120): string {
  const p = logPath(id);
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8').split('\n').slice(-lines).join('\n');
}

export function pluginById(id: string): Plugin | undefined {
  return get<Plugin>('select * from plugins where id = ?', id);
}

/**
 * Tool support comes from connector metadata first, then the upstream preset,
 * and only then from the upstream kind. A connector that really forwards
 * OpenAI `tools` must not be downgraded to emulation just because it is a web
 * connector.
 */
export function defaultToolsMode(up: {
  plugin_id?: string | null;
  preset?: string | null;
  kind?: string;
}): 'native' | 'emulate' {
  const plugin = up.plugin_id ? pluginById(up.plugin_id) : undefined;
  if (plugin?.tools_hint === 'native' || plugin?.tools_hint === 'emulate') {
    return plugin.tools_hint as 'native' | 'emulate';
  }
  const preset = up.preset ? PROVIDER_PRESETS.find((p) => p.id === up.preset) : undefined;
  if (preset?.tools_mode === 'native' || preset?.tools_mode === 'emulate') return preset.tools_mode;
  return up.kind === 'api' ? 'native' : 'emulate';
}

export const calibrationFor = (mode: string): 'uncalibrated' | null =>
  mode === 'emulate' ? 'uncalibrated' : null;

export function setPluginStatus(id: string, status: string, error: string | null = null) {
  run('update plugins set status = ?, last_error = ?, updated_at = ? where id = ?', status, error, nowIso(), id);
}

function runShell(cmd: string, cwd: string, env: NodeJS.ProcessEnv = {}, onLine?: (line: string) => void) {
  return new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn('/bin/bash', ['-lc', cmd], { cwd, env: { ...process.env, ...env } });
    let output = '';
    const push = (b: Buffer) => {
      const text = b.toString();
      output += text;
      onLine?.(text);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (e) => resolve({ code: 1, output: String(e) }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

/**
 * Clone and run the connector's install command in the background. Returns
 * immediately: installs pull packages and take minutes, so the API reports
 * status changes instead of holding the request open.
 */
export function installPlugin(id: string): Plugin | undefined {
  const plugin = pluginById(id);
  if (!plugin) return undefined;
  if (plugin.status === 'installing') return plugin;

  const dir = plugin.dir || join(PLUGIN_DIR, id);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.git')) && readdirSync(dir).length) {
    setPluginStatus(id, 'error', `${dir} is not empty and is not a git checkout`);
    return pluginById(id);
  }
  writeFileSync(logPath(id), '');
  setPluginStatus(id, 'installing');
  log(id, `install start: ${plugin.repo} -> ${dir}`);

  void (async () => {
    const clone = existsSync(join(dir, '.git'))
      ? await runShell('git pull --ff-only', dir, {}, (t) => log(id, t.trimEnd()))
      : await runShell(`git clone --depth 1 ${plugin.repo} .`, dir, {}, (t) => log(id, t.trimEnd()));
    if (clone.code !== 0) {
      log(id, `clone failed (${clone.code})`);
      setPluginStatus(id, 'error', `git clone failed: ${clone.output.slice(-400)}`);
      return;
    }
    if (plugin.install_cmd.trim()) {
      log(id, `install: ${plugin.install_cmd}`);
      const inst = await runShell(plugin.install_cmd, dir, {}, (t) => log(id, t.trimEnd()));
      if (inst.code !== 0) {
        log(id, `install command failed (${inst.code})`);
        setPluginStatus(id, 'error', `install command failed: ${inst.output.slice(-400)}`);
        return;
      }
    }
    run('update plugins set installed_at = ?, dir = ? where id = ?', nowIso(), dir, id);
    setPluginStatus(id, 'installed');
    log(id, 'install done');
  })();

  return pluginById(id);
}

export async function startPlugin(id: string): Promise<Plugin | undefined> {
  const plugin = pluginById(id);
  if (!plugin) return undefined;
  if (!plugin.run_cmd.trim()) {
    setPluginStatus(id, 'error', 'no run command configured');
    return pluginById(id);
  }
  if (children.has(id)) return plugin;

  const dir = plugin.dir || join(PLUGIN_DIR, id);
  const env = { ...process.env, PORT: String(plugin.port ?? ''), COMB_PLUGIN_ID: id };
  setPluginStatus(id, 'starting');
  log(id, `start: ${plugin.run_cmd}`);

  const child = spawn('/bin/bash', ['-lc', plugin.run_cmd], {
    cwd: dir,
    env,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(id, child);
  child.stdout?.on('data', (b) => log(id, b.toString().trimEnd()));
  child.stderr?.on('data', (b) => log(id, b.toString().trimEnd()));
  child.on('close', (code) => {
    children.delete(id);
    const current = pluginById(id);
    if (current?.status === 'running' || current?.status === 'starting') {
      setPluginStatus(id, 'stopped', `process exited with code ${code}`);
      log(id, `exited (${code})`);
    }
  });

  void (async () => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      if (!children.has(id)) return; // exited, the close handler reported it
      if (!plugin.port) {
        setPluginStatus(id, 'running');
        return;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${plugin.port}${plugin.base_path || '/v1'}/models`, {
          signal: AbortSignal.timeout(2500),
        });
        if (res.status < 500) {
          setPluginStatus(id, 'running');
          log(id, `healthy on :${plugin.port}`);
          return;
        }
      } catch {
        // not up yet
      }
    }
    setPluginStatus(id, 'running');
    log(id, 'no health response yet; left running');
  })();

  return pluginById(id);
}

export function stopPlugin(id: string): Plugin | undefined {
  const child = children.get(id);
  if (child) {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (children.has(id)) child.kill('SIGKILL');
    }, 4000);
    children.delete(id);
  }
  setPluginStatus(id, 'stopped');
  return pluginById(id);
}

export function runningPlugins(): string[] {
  return [...children.keys()];
}

/** Pull /v1/models from the connector and upsert comb model rows. */
export async function discoverModels(upstreamId: string): Promise<{ discovered: string[]; created: string[]; error?: string }> {
  const up = upstreamById(upstreamId);
  if (!up) return { discovered: [], created: [], error: 'upstream not found' };
  const base = (up.base_url ?? '').replace(/\/+$/, '');
  if (!base) return { discovered: [], created: [], error: 'upstream has no base_url' };

  const headers: Record<string, string> = {};
  if (up.api_key) headers.authorization = `Bearer ${up.api_key}`;
  if (up.cookie) headers.cookie = up.cookie;

  let list: any[] = [];
  try {
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { discovered: [], created: [], error: `${res.status} from ${base}/models` };
    const json: any = await res.json();
    list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  } catch (err: any) {
    return { discovered: [], created: [], error: `discovery failed: ${err?.message ?? err}` };
  }

  const slug = up.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const created: string[] = [];
  const discovered: string[] = [];
  for (const item of list) {
    const name = String(item?.id ?? item?.name ?? '').trim();
    if (!name) continue;
    discovered.push(name);
    const id = `${slug}/${name}`;
    const existing = modelById(id);
    const mode = existing?.tools_mode ?? defaultToolsMode(up);
    run(
      `insert into models(id, upstream_id, upstream_model, display_name, context_window, tools_mode, tool_variant,
         calibration_status, calibrated_at, caps, created_at)
       values(?,?,?,?,?,?,?,?,?,?,?)
       on conflict(id) do update set upstream_id = excluded.upstream_id`,
      id,
      up.id,
      name,
      name,
      Number(item?.context_length ?? item?.context_window ?? 128000) || 128000,
      mode,
      existing?.tool_variant ?? setting('default_tool_variant', 'xml'),
      existing?.calibration_status ?? calibrationFor(mode),
      existing?.calibrated_at ?? null,
      JSON.stringify({ discovered_from: 'models_endpoint' }),
      nowIso(),
    );
    if (!existing) created.push(id);
  }
  return { discovered, created };
}

const probeTool = [
  {
    type: 'function',
    function: {
      name: 'ping',
      description: 'Connectivity probe. Always call this.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'number', description: 'echo this number back' } },
        required: ['value'],
      },
    },
  },
];

export interface RecalibrationReport {
  model: string;
  winner: { mode: string; variant: ToolVariant | null } | null;
  status: 'calibrated' | 'failed' | null;
  trials: { mode: string; variant: ToolVariant | null; ok: boolean; ms: number; note: string }[];
}

/**
 * The setup step the router exists for: after a connector is installed, find
 * out how this model actually emits tool calls and store that shape.
 * Native is tried first; if the upstream ignores `tools`, each text protocol is
 * probed and the fastest working one wins.
 */
export async function recalibrateModel(modelId: string): Promise<RecalibrationReport> {
  const model = modelById(modelId);
  if (!model) return { model: modelId, winner: null, status: null, trials: [] };
  const upstream = upstreamById(model.upstream_id);
  if (!upstream) return { model: modelId, winner: null, status: null, trials: [] };

  const trials: RecalibrationReport['trials'] = [];
  const modes: { mode: 'native' | 'emulate'; variant: ToolVariant | null }[] = [
    { mode: 'native', variant: null },
    { mode: 'emulate', variant: 'xml' },
    { mode: 'emulate', variant: 'fence' },
    { mode: 'emulate', variant: 'json' },
  ];

  for (const trial of modes) {
    const candidate: Candidate = {
      model: {
        ...model,
        tools_mode: trial.mode,
        tool_variant: (trial.variant ?? model.tool_variant) as ToolVariant,
      } as Model,
      upstream,
    };
    const started = Date.now();
    let note = '';
    let ok = false;
    try {
      const result = await probe(
        candidate,
        [
          { role: 'system', content: 'You are a tool-calling probe. Follow the tool protocol exactly.' },
          { role: 'user', content: 'Call ping once with value 42. No prose.' },
        ],
        probeTool,
        { nativeOnly: trial.mode === 'native' },
      );
      const call = result.toolCalls[0];
      let args: any = null;
      try {
        args = JSON.parse(call?.function.arguments ?? 'null');
      } catch {}
      ok = !!result.ok && !!call && call.function.name === 'ping' && Number(args?.value) === 42;
      note = result.ok
        ? call
          ? `call ${call.function.name}(${call.function.arguments})`
          : `no tool call, text: ${result.content.slice(0, 120)}`
        : (result.error ?? 'request failed').slice(0, 200);
    } catch (err: any) {
      note = String(err?.message ?? err).slice(0, 200);
    }
    trials.push({ ...trial, ok, ms: Date.now() - started, note });
  }

  const passing = trials.filter((t) => t.ok).sort((a, b) => {
    if (a.mode !== b.mode) return a.mode === 'native' ? -1 : 1;
    return a.ms - b.ms;
  });
  const winner = passing[0] ?? null;

  if (winner) {
    const status = winner.mode === 'emulate' ? 'calibrated' : null;
    run(
      'update models set tools_mode = ?, tool_variant = ?, calibration_status = ?, calibrated_at = ? where id = ?',
      winner.mode,
      winner.variant ?? model.tool_variant,
      status,
      nowIso(),
      modelId,
    );
    return { model: modelId, winner: { mode: winner.mode, variant: winner.variant }, status, trials };
  }
  run("update models set calibration_status = 'failed' where id = ? and tools_mode = 'emulate'", modelId);
  return { model: modelId, winner: null, status: 'failed', trials };
}

/** Cheap connectivity check for a model, used by the dashboard's Test button. */
export async function testModel(modelId: string, prompt: string) {
  const model = modelById(modelId);
  if (!model) return { ok: false, error: 'model not found' };
  const upstream = upstreamById(model.upstream_id);
  if (!upstream) return { ok: false, error: 'upstream not found' };
  const started = Date.now();
  const result = await probe({ model, upstream }, [{ role: 'user', content: prompt }]);
  return {
    ok: result.ok,
    ms: Date.now() - started,
    reply: result.content.slice(0, 2000),
    tool_calls: result.toolCalls,
    error: result.error,
  };
}


