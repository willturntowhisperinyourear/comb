import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyzeRepo } from './analyze.ts';

const project = (name: string, files: Record<string, string>) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'comb-analyze-')), name);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
};

test('node project: lockfile, build script, start script and port', () => {
  const dir = project('node-connector', {
    'package.json': JSON.stringify({
      name: 'gemini-bridge',
      main: 'dist/index.js',
      scripts: { build: 'tsc', start: 'node dist/index.js' },
    }),
    'package-lock.json': '{}',
    '.env.example': 'PORT=8123\n',
    'README.md': 'OpenAI compatible bridge that uses a browser cookie session.',
    'src/index.ts': 'export const x = 1;\n',
  });

  const analysis = analyzeRepo(dir);
  assert.equal(analysis.runtime, 'node');
  assert.equal(analysis.id, 'gemini-bridge');
  assert.equal(analysis.install_cmd, 'npm install && npm run build');
  assert.equal(analysis.run_cmd, 'npm start');
  assert.equal(analysis.kind, 'web2api');
  assert.equal(analysis.port, 8123);
  assert.equal(analysis.tools_hint, 'emulate');
});

test('node project with pnpm and a taken port gets the next free one', () => {
  const dir = project('pnpm-connector', {
    'package.json': JSON.stringify({ name: 'qwen-shim', scripts: { start: 'node server.js' } }),
    'pnpm-lock.yaml': '',
    'server.js': 'const port = process.env.PORT || 8088;\n',
  });

  const analysis = analyzeRepo(dir, [8088]);
  assert.equal(analysis.install_cmd, 'pnpm install');
  assert.equal(analysis.run_cmd, 'pnpm start');
  assert.notEqual(analysis.port, 8088);
  assert.ok(analysis.port >= 8095 && analysis.port < 8199);
  assert.ok(analysis.notes.some((n) => n.includes('8088')));
});

test('python project: venv install and uvicorn start', () => {
  const dir = project('python-connector', {
    'requirements.txt': 'fastapi\nuvicorn\nhttpx\n',
    'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
    'README.md': 'Run with uvicorn main:app. Uses a logged in CLI session.',
  });

  const analysis = analyzeRepo(dir);
  assert.equal(analysis.runtime, 'python');
  assert.equal(analysis.install_cmd, 'python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt');
  assert.equal(analysis.run_cmd, './.venv/bin/uvicorn main:app --host 0.0.0.0 --port $PORT');
  assert.equal(analysis.entrypoint, 'main.py');
  assert.ok(['web2api', 'cli2api', 'api2api'].includes(analysis.kind));
});

test('python project with pyproject and a plain script', () => {
  const dir = project('py-script', {
    'pyproject.toml': '[project]\nname = "arena-proxy"\n',
    'server.py': 'import uvicorn\nif __name__ == "__main__":\n    uvicorn.run("app:api", port=8090)\n',
  });

  const analysis = analyzeRepo(dir);
  assert.equal(analysis.name, 'Arena Proxy');
  assert.equal(analysis.install_cmd, 'python3 -m venv .venv && ./.venv/bin/pip install .');
  assert.equal(analysis.run_cmd, './.venv/bin/python server.py');
  assert.equal(analysis.port, 8090);
});

test('go project: build to a binary and run it', () => {
  const dir = project('go-connector', {
    'go.mod': 'module github.com/user/go-connector\n\ngo 1.22\n',
    'main.go': 'package main\nfunc main() {}\n',
    'README.md': 'Exposes OpenAI /v1/chat/completions, supports tool_calls.',
  });

  const analysis = analyzeRepo(dir);
  assert.equal(analysis.runtime, 'go');
  assert.equal(analysis.install_cmd, 'go build -o server .');
  assert.equal(analysis.run_cmd, './server');
  assert.equal(analysis.tools_hint, 'native');
  assert.equal(analysis.name, 'Go Connector');
});

test('shell project falls back to install.sh and start.sh', () => {
  const dir = project('shell-connector', {
    'install.sh': 'echo install\n',
    'start.sh': 'echo start\n',
  });

  const analysis = analyzeRepo(dir);
  assert.equal(analysis.runtime, 'shell');
  assert.equal(analysis.install_cmd, 'bash install.sh');
  assert.equal(analysis.run_cmd, 'bash start.sh');
  assert.ok(analysis.notes.some((n) => n.includes('port')));
});

test('unknown project asks for commands instead of guessing', () => {
  const dir = project('mystery', { 'README.md': 'Nothing to see here.' });
  const analysis = analyzeRepo(dir);
  assert.equal(analysis.runtime, 'unknown');
  assert.equal(analysis.run_cmd, '');
  assert.ok(analysis.notes.some((n) => n.includes('start command not detected') || n.includes('start command')));
});
