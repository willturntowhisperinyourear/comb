import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { slugify } from './text.ts';

// Repository analyzer for custom connectors. Reads a bounded slice of the
// checkout and proposes the fields a connector needs, so the operator reviews
// instead of typing everything from scratch.

export interface RepoAnalysis {
  name: string;
  id: string;
  runtime: 'node' | 'python' | 'go' | 'shell' | 'unknown';
  kind: 'web2api' | 'cli2api' | 'api2api';
  tools_hint: 'native' | 'emulate';
  install_cmd: string;
  run_cmd: string;
  port: number;
  base_path: string;
  models: string[];
  entrypoint: string | null;
  notes: string[];
}

const READ_LIMIT = 200_000;
const SCAN_FILES = 400;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next']);
const TEXT_EXT = /\.(md|txt|json|toml|ya?ml|py|js|mjs|cjs|ts|tsx|jsx|go|sh|env|example|cfg|ini)$/i;

function readText(path: string, limit = READ_LIMIT): string {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return '';
    if (statSync(path).size > limit * 4) return '';
    return readFileSync(path, 'utf8').slice(0, limit);
  } catch {
    return '';
  }
}

function listFiles(root: string, maxDepth = 2): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= SCAN_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= SCAN_FILES) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory() && depth > 0) walk(full, depth - 1);
      else if (entry.isFile()) out.push(relative(root, full));
    }
  };
  walk(root, maxDepth);
  return out;
}

function pickPort(candidates: number[], taken: Set<number>): number {
  const counts = new Map<number, number>();
  for (const port of candidates) {
    if (port < 1024 || port > 65535) continue;
    counts.set(port, (counts.get(port) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).find(([port]) => !taken.has(port));
  if (best) return best[0];
  for (let port = 8095; port < 8199; port++) if (!taken.has(port)) return port;
  return 8095;
}

function detectPorts(text: string): number[] {
  const ports: number[] = [];
  const patterns = [
    /--port[= ]+["']?(\d{4,5})/gi,
    /\bPORT\s*[=:]\s*["']?(\d{4,5})/g,
    /process\.env\.PORT\s*(?:\|\||\?\?)\s*["']?(\d{4,5})/g,
    /\bport\s*[=:]\s*["']?(\d{4,5})/gi,
    /EXPOSE\s+(\d{4,5})/gi,
    /localhost:(\d{4,5})/gi,
    /0\.0\.0\.0:(\d{4,5})/g,
    /127\.0\.0\.1:(\d{4,5})/g,
  ];
  for (const re of patterns) {
    for (const match of text.matchAll(re)) ports.push(Number(match[1]));
  }
  return ports;
}

const MODEL_FAMILIES =
  /(?:gemini|qwen|claude|gpt|deepseek|glm|grok|sonar|cursor|llama|mistral|kimi|moonshot|o[1-4])[a-z0-9._-]*/gi;

function detectModels(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(MODEL_FAMILIES)) {
    const id = match[0].toLowerCase().replace(/[.,;:)]+$/, '');
    if (id.length < 6) continue;
    if (!/[0-9]/.test(id)) continue; // "gpt" or "claude" alone is not a model id
    if (/^(get|got|glm|good|gpt|node)/.test(id) && !/[0-9]/.test(id.slice(3))) continue;
    found.add(id);
  }
  return [...found].slice(0, 10);
}

function detectKind(text: string): 'web2api' | 'cli2api' | 'api2api' {
  if (/(cli|command line|subprocess|child_process|spawn|exec|pty|shell out)/i.test(text) &&
      /(openai|chat\/completions|compatible)/i.test(text)) {
    return 'cli2api';
  }
  if (/(cookie|session|cookie jar|browser|playwright|puppeteer|selenium|reverse[- ]?engineer|chat\.|webui)/i.test(text)) {
    return 'web2api';
  }
  return 'api2api';
}

function detectTools(text: string): 'native' | 'emulate' {
  return /(tool_calls|tool_calls\b|function_call|"tools"\s*:|tools\s*:\s*\[|toolCall)/i.test(text)
    ? 'native'
    : 'emulate';
}

function dockerCommand(dockerfile: string): string | null {
  const cmd = /^\s*CMD\s+(.+)$/im.exec(dockerfile);
  const entry = /^\s*ENTRYPOINT\s+(.+)$/im.exec(dockerfile);
  const raw = cmd?.[1] ?? entry?.[1];
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parts = JSON.parse(trimmed) as string[];
      return parts.join(' ');
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function pythonCommand(dir: string, files: string[], text: string, notes: string[]): { install: string; run: string; entry: string | null } {
  const has = (name: string) => files.includes(name) || files.some((f) => f.endsWith(`/${name}`));
  const candidates = ['main.py', 'app.py', 'server.py', 'run.py', 'src/main.py', 'src/app.py', 'src/server.py'];
  const entry = candidates.find((f) => files.includes(f)) ?? null;
  const entryText = entry ? readText(join(dir, entry)) : '';
  const webFramework = /(fastapi|flask|uvicorn)/i.test(text) || /(FastAPI|Flask)\(/.test(entryText);

  let install = '';
  if (files.includes('pyproject.toml')) {
    install = 'python3 -m venv .venv && ./.venv/bin/pip install .';
  } else if (has('requirements.txt')) {
    install = 'python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt';
  } else if (files.includes('setup.py')) {
    install = 'python3 -m venv .venv && ./.venv/bin/pip install -e .';
  } else {
    install = 'python3 -m venv .venv';
    notes.push('no python dependency file found; install step only creates a venv');
  }

  let run = '';
  const appVar = /(app|application)\s*=\s*(FastAPI|Flask)\(/.exec(entryText)?.[1] ?? 'app';
  if (webFramework && entry && /uvicorn/i.test(text + entryText)) {
    const module = entry.replace(/\.py$/, '').replace(/\//g, '.');
    run = `./.venv/bin/uvicorn ${module}:${appVar} --host 0.0.0.0 --port $PORT`;
  } else if (entry) {
    run = `./.venv/bin/python ${entry}`;
  } else {
    notes.push('no python entrypoint recognised; set the start command by hand');
  }
  return { install, run, entry };
}

function nodeCommand(dir: string, files: string[], notes: string[]): { install: string; run: string; entry: string | null } {
  const pkgRaw = readText(join(dir, 'package.json'));
  let pkg: any = {};
  try {
    pkg = JSON.parse(pkgRaw);
  } catch {
    if (pkgRaw) notes.push('package.json could not be parsed');
  }
  const pm = files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn' : 'npm';
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  let install = `${pm} install`;
  if (scripts.build) install += ` && ${pm} run build`;

  let run = '';
  if (scripts.start) run = pm === 'npm' ? 'npm start' : `${pm} start`;
  else if (scripts.serve) run = `${pm} run serve`;
  else if (typeof pkg.bin === 'string') run = `node ${pkg.bin}`;
  else if (pkg.bin && typeof pkg.bin === 'object') run = `node ${Object.values(pkg.bin)[0]}`;
  else if (pkg.main) run = `node ${pkg.main}`;
  else if (files.includes('src/index.ts') || files.includes('server.ts')) {
    run = `npx tsx ${files.includes('src/index.ts') ? 'src/index.ts' : 'server.ts'}`;
  } else {
    notes.push('no node start script or entrypoint found');
  }
  const entry = pkg.main ?? (files.includes('src/index.ts') ? 'src/index.ts' : null);
  return { install, run, entry: entry ? String(entry) : null };
}

export function analyzeRepo(dir: string, takenPorts: number[] = []): RepoAnalysis {
  const files = listFiles(dir);
  const lower = files.map((f) => f.toLowerCase());
  const has = (name: string) => lower.includes(name) || lower.some((f) => f.endsWith(`/${name}`));
  const readme =
    readText(join(dir, 'README.md')) ||
    readText(join(dir, 'readme.md')) ||
    readText(join(dir, 'README.rst'));
  const notes: string[] = [];
  const taken = new Set(takenPorts);

  const runtime: RepoAnalysis['runtime'] = has('go.mod')
    ? 'go'
    : has('package.json')
      ? 'node'
      : has('pyproject.toml') || has('requirements.txt') || has('setup.py')
        ? 'python'
        : has('install.sh') || has('Makefile')
          ? 'shell'
          : 'unknown';
  notes.push(`runtime: ${runtime}`);

  let install_cmd = '';
  let run_cmd = '';
  let entrypoint: string | null = null;

  if (runtime === 'node') {
    const res = nodeCommand(dir, lower, notes);
    install_cmd = res.install;
    run_cmd = res.run;
    entrypoint = res.entry;
  } else if (runtime === 'python') {
    const pyText = [
      readText(join(dir, 'requirements.txt')),
      readText(join(dir, 'pyproject.toml')),
      readText(join(dir, 'setup.py')),
    ].join('\n');
    const res = pythonCommand(dir, lower, pyText || readme, notes);
    install_cmd = res.install;
    run_cmd = res.run;
    entrypoint = res.entry;
  } else if (runtime === 'go') {
    install_cmd = 'go build -o server .';
    run_cmd = './server';
    entrypoint = 'server';
  } else if (runtime === 'shell') {
    if (has('install.sh')) install_cmd = 'bash install.sh';
    else if (has('Makefile') && /install:/m.test(readText(join(dir, 'Makefile')))) install_cmd = 'make install';
    if (has('start.sh')) run_cmd = 'bash start.sh';
  }

  if (!run_cmd) {
    const docker = has('Dockerfile') ? dockerCommand(readText(join(dir, 'Dockerfile'))) : null;
    if (docker) {
      run_cmd = docker;
      notes.push('start command came from the Dockerfile CMD');
    }
  }
  if (!run_cmd) notes.push('start command not detected; set it by hand');
  if (!install_cmd) notes.push('install command not detected; set it by hand');

  const packageName = (() => {
    try {
      return JSON.parse(readText(join(dir, 'package.json'))).name as string | undefined;
    } catch {
      return undefined;
    }
  })();
  const pyName = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(readText(join(dir, 'pyproject.toml')))?.[1];
  const goName = /^module\s+(\S+)/m.exec(readText(join(dir, 'go.mod')))?.[1];
  const rawName = packageName || pyName || (goName ? basename(goName) : '') || basename(dir) || 'connector';
  const name = rawName.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

  const sourceText = [
    readme,
    readText(join(dir, 'package.json')),
    readText(join(dir, '.env.example')),
    readText(join(dir, 'Dockerfile')),
    ...lower.slice(0, 40).filter((f) => TEXT_EXT.test(f)).map((f) => readText(join(dir, f), 40_000)),
  ].join('\n');

  const ports = detectPorts(sourceText);
  const port = pickPort(ports, taken);
  if (!ports.length) notes.push('no port found; assigned the next free one');
  else if (taken.has(ports[0])) notes.push(`default port ${ports[0]} is taken; assigned ${port}`);

  const kind = detectKind(sourceText + ' ' + lower.join(' '));
  const models = detectModels(sourceText);

  return {
    name,
    id: slugify(name),
    runtime,
    kind,
    tools_hint: detectTools(sourceText),
    install_cmd,
    run_cmd,
    port,
    base_path: '/v1',
    models,
    entrypoint,
    notes,
  };
}
