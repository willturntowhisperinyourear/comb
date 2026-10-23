import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, PLUGIN_DIR, all, get, nowIso, run } from './db.ts';
import { analyzeRepo, type RepoAnalysis } from './analyze.ts';
import { countFiles, extractArchive, hoistSingleRoot, isArchiveName } from './archive.ts';
import { addModels } from './models.ts';
import { appendPluginLog, pluginById, setPluginStatus, startPlugin, stopPlugin } from './plugins.ts';
import { refreshUpstream } from './refresh.ts';
import { slugify } from './text.ts';
import type { PluginKind } from '../shared/types.ts';
import { runProcess, runShell } from './process.ts';

// Custom connectors: a repo or archive becomes data/plugins/<id>, gets an
// analyzed starting configuration, and is installed in the background.

export const STAGING_DIR = join(DATA_DIR, 'staging');
mkdirSync(STAGING_DIR, { recursive: true });

export interface PreparedConnector {
  staging_id: string;
  analysis: RepoAnalysis;
  source: string;
  files: number;
  notes: string[];
}

interface StagingMeta extends PreparedConnector {
  dir: string;
  created_at: string;
}

export interface CustomConnectorInput {
  staging_id: string;
  id?: string;
  name?: string;
  kind?: PluginKind;
  port?: number;
  base_path?: string;
  auth_hint?: string;
  install_cmd?: string;
  run_cmd?: string;
  tools_hint?: 'native' | 'emulate';
  models?: string[];
  create_upstream?: boolean;
  auto_calibrate?: boolean;
  start?: boolean;
}

const stagingDir = (id: string) => join(STAGING_DIR, id);
const metaPath = (id: string) => join(stagingDir(id), 'meta.json');

function writeMeta(meta: StagingMeta) {
  writeFileSync(metaPath(meta.staging_id), JSON.stringify(meta, null, 2));
}

export function readPrepared(stagingId: string): StagingMeta | null {
  try {
    return JSON.parse(readFileSync(metaPath(stagingId), 'utf8'));
  } catch {
    return null;
  }
}

export function takenPorts(): number[] {
  return all<{ port: number }>('select port from plugins where port is not null')
    .map((r) => Number(r.port))
    .filter(Boolean);
}

export function cleanStaging(maxAgeMs = 24 * 3600_000) {
  if (!existsSync(STAGING_DIR)) return;
  for (const entry of readdirSync(STAGING_DIR)) {
    const full = join(STAGING_DIR, entry);
    try {
      if (statSync(full).isDirectory() && Date.now() - statSync(full).mtimeMs > maxAgeMs) {
        rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // A staging entry that vanished is fine.
    }
  }
}

export async function prepareGit(url: string): Promise<PreparedConnector> {
  const clean = url.trim();
  if (!clean) throw new Error('git url is required');
  const id = randomUUID();
  const dir = stagingDir(id);
  const src = join(dir, 'src');
  mkdirSync(dir, { recursive: true });

  // Args, not a shell string: a url must never be able to run a command.
  const clone = await runProcess('git', ['clone', '--depth', '1', '--', clean, 'src'], { cwd: dir, timeoutMs: 240_000 });
  if (clone.code !== 0 || !existsSync(src)) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`git clone failed: ${clone.output.slice(-400) || 'unknown error'}`);
  }
  rmSync(join(src, '.git'), { recursive: true, force: true });

  const analysis = analyzeRepo(src, takenPorts());
  const meta: StagingMeta = {
    staging_id: id,
    dir,
    source: clean,
    files: countFiles(src),
    notes: [],
    analysis,
    created_at: nowIso(),
  };
  writeMeta(meta);
  return { staging_id: id, analysis, source: clean, files: meta.files, notes: [] };
}

export function saveUploadedArchive(filename: string, data: Buffer): string {
  const uploads = join(STAGING_DIR, 'uploads');
  mkdirSync(uploads, { recursive: true });
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_') || 'archive.zip';
  const target = join(uploads, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`);
  writeFileSync(target, data);
  return target;
}

export async function prepareArchivePath(file: string, sourceLabel?: string): Promise<PreparedConnector> {
  if (!existsSync(file)) throw new Error(`archive not found: ${file}`);
  if (!isArchiveName(file)) throw new Error('unsupported archive type; use .zip, .tar.gz, .tgz, .tar, .rar or .7z');
  const id = randomUUID();
  const dir = stagingDir(id);
  const extractDir = join(dir, 'extract');
  mkdirSync(dir, { recursive: true });

  let notes: string[] = [];
  try {
    const result = extractArchive(file, extractDir);
    notes = result.notes;
    const hoisted = hoistSingleRoot(extractDir);
    const src = join(dir, 'src');
    renameSync(extractDir, src);
    const analysis = analyzeRepo(src, takenPorts());
    if (hoisted) notes.push('unwrapped the single top-level folder');
    const meta: StagingMeta = {
      staging_id: id,
      dir,
      source: sourceLabel ?? file,
      files: countFiles(src),
      notes,
      analysis,
      created_at: nowIso(),
    };
    writeMeta(meta);
    return { staging_id: id, analysis, source: meta.source, files: meta.files, notes };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

export async function downloadArchive(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('archive url is not a valid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('archive url must be http or https');
  const res = await fetch(parsed, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > 200 * 1024 * 1024) throw new Error('archive is larger than the 200 MB upload limit');
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > 200 * 1024 * 1024) throw new Error('archive is larger than the 200 MB upload limit');
  const name = decodeURIComponent(parsed.pathname.split('/').pop() || 'archive.zip');
  return saveUploadedArchive(name, data);
}

function ensureUpstream(
  pluginId: string,
  name: string,
  kind: PluginKind,
  port: number,
  basePath: string,
  toolsHint: 'native' | 'emulate',
  models: string[],
): string {
  const mapped = kind === 'web2api' ? 'web' : kind === 'cli2api' ? 'cli' : 'api';
  const base = `http://127.0.0.1:${port}${basePath.startsWith('/') ? basePath : '/' + basePath}`;
  const existing = get<any>('select * from upstreams where plugin_id = ?', pluginId);

  let upstreamId = existing?.id as string | undefined;
  if (upstreamId) {
    run('update upstreams set base_url = ? where id = ?', base, upstreamId);
  } else {
    upstreamId = randomUUID();
    run(
      `insert into upstreams(id, name, preset, kind, plugin_id, adapter, base_url, headers, auth_mode, status,
         weight, cost_per_1k, max_rpm, max_rpd, reset_mode, config, created_at)
       values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      upstreamId,
      name,
      null,
      mapped,
      pluginId,
      'openai-http',
      base,
      '{}',
      'none',
      'active',
      1,
      0,
      0,
      0,
      'none',
      '{}',
      nowIso(),
    );
  }
  if (models.length) addModels(upstreamId, models, toolsHint);
  return upstreamId;
}

async function waitForRunning(id: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = pluginById(id);
    if (current?.status === 'running') return true;
    if (current?.status === 'error') return false;
    await new Promise((r) => setTimeout(r, 1200));
  }
  return pluginById(id)?.status === 'running';
}

export interface InstallResult {
  plugin: ReturnType<typeof pluginById>;
  upstream_id: string | null;
  installing: boolean;
}

export function finalizeCustomConnector(input: CustomConnectorInput): InstallResult {
  const meta = readPrepared(input.staging_id);
  if (!meta) throw new Error('upload expired or unknown; analyze the source again');

  const analysis = meta.analysis;
  const id = slugify(input.id || analysis.id || 'connector');
  const name = (input.name || analysis.name || id).trim();
  const kind = input.kind ?? analysis.kind;
  const port = Number(input.port) || analysis.port;
  const basePath = (input.base_path || analysis.base_path || '/v1').trim();
  const installCmd = (input.install_cmd ?? analysis.install_cmd).trim();
  const runCmd = (input.run_cmd ?? analysis.run_cmd).trim();
  const toolsHint = input.tools_hint ?? analysis.tools_hint;
  const models = (input.models ?? analysis.models).map((m) => String(m).trim()).filter(Boolean);

  if (!runCmd) throw new Error('a start command is required before installing');
  if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error('port must be between 1 and 65535');

  const dir = join(PLUGIN_DIR, id);
  const existing = pluginById(id);
  if (existing) {
    try {
      stopPlugin(id);
    } catch {
      // Stopping a connector that is already down is fine.
    }
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const src = join(meta.dir, 'src');
  cpSync(src, dir, { recursive: true });
  rmSync(meta.dir, { recursive: true, force: true });

  if (existing) {
    run(
      `update plugins set name = ?, kind = ?, port = ?, base_path = ?, install_cmd = ?, run_cmd = ?, models_hint = ?,
         tools_hint = ?, dir = ?, status = 'installed', last_error = null, installed_at = ?, updated_at = ?
       where id = ?`,
      name,
      kind,
      port,
      basePath,
      installCmd,
      runCmd,
      JSON.stringify(models),
      toolsHint,
      dir,
      nowIso(),
      nowIso(),
      id,
    );
  } else {
    run(
      `insert into plugins(id, name, kind, repo, description, port, base_path, auth_hint, install_cmd, run_cmd,
         models_hint, tools_hint, status, dir, installed_at, updated_at)
       values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      name,
      kind,
      meta.source,
      input.auth_hint ?? 'custom connector',
      port,
      basePath,
      input.auth_hint ?? '',
      installCmd,
      runCmd,
      JSON.stringify(models),
      toolsHint,
      'installed',
      dir,
      nowIso(),
      nowIso(),
    );
  }

  const upstreamId = input.create_upstream
    ? ensureUpstream(id, name, kind, port, basePath, toolsHint, models)
    : null;

  const autoCalibrate = input.auto_calibrate !== false;
  const shouldStart = input.start !== false;

  void (async () => {
    try {
      setPluginStatus(id, 'installing');
      if (installCmd) {
        appendPluginLog(id, `install: ${installCmd}`);
        const res = await runShell(installCmd, { cwd: dir, timeoutMs: 20 * 60_000 });
        appendPluginLog(id, res.output.slice(-4000));
        if (res.code !== 0) {
          setPluginStatus(id, 'error', `install command failed: ${res.output.slice(-400)}`);
          return;
        }
      }
      setPluginStatus(id, 'installed');
      if (shouldStart) {
        await startPlugin(id);
        const up = await waitForRunning(id, 30_000);
        appendPluginLog(id, up ? 'running' : 'start did not become healthy yet');
      }
      if (upstreamId) {
        const refreshed = await refreshUpstream(upstreamId, { calibrate: autoCalibrate });
        appendPluginLog(
          id,
          `refresh: ${refreshed.discovered.length} discovered, ${refreshed.calibrated} calibrated`,
        );
      }
    } catch (err: any) {
      setPluginStatus(id, 'error', String(err?.message ?? err));
    }
  })();

  return { plugin: pluginById(id), upstream_id: upstreamId, installing: true };
}
