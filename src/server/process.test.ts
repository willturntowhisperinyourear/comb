import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess, runShell } from './process.ts';
import { PLUGIN_CATALOG } from './catalog.ts';

const cwd = mkdtempSync(join(tmpdir(), 'comb process '));

test('shell commands preserve environment expansion and report nonzero exits', async () => {
  const success = await runShell('printf "%s" "$COMB_PROCESS_TEST"', {
    cwd, env: { COMB_PROCESS_TEST: 'value with spaces' }, timeoutMs: 5000,
  });
  assert.equal(success.code, 0, success.output);
  assert.equal(success.output, 'value with spaces');
  const failure = await runShell('echo install-diagnostic >&2; exit 7', { cwd, timeoutMs: 5000 });
  assert.equal(failure.code, 7);
  assert.match(failure.output, /install-diagnostic/);
});

test('missing shell errors are returned with the executable name', async () => {
  const original = process.env.COMB_SHELL;
  try {
    process.env.COMB_SHELL = join(cwd, 'missing-bash');
    const result = await runShell('echo unused', { cwd, timeoutMs: 5000 });
    assert.equal(result.code, 1);
    assert.match(result.output, /missing-bash.*ENOENT/);
  } finally {
    if (original === undefined) delete process.env.COMB_SHELL;
    else process.env.COMB_SHELL = original;
  }
});

test('process timeouts terminate the command and retain the reason', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, timeoutMs: 150 });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /timed out after 150 ms/);
});

let pythonAvailable = true;
try {
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['--version'], { stdio: 'pipe' });
} catch {
  pythonAvailable = false;
}

test('catalog Python commands create and use a native virtual environment', { skip: !pythonAvailable }, async () => {
  writeFileSync(join(cwd, 'requirements.txt'), '');
  writeFileSync(join(cwd, 'app.py'), 'raise RuntimeError("server must not start during install")\n');
  const installed = await runShell(PLUGIN_CATALOG.find((p) => p.id === 'deepseek-web')!.install_cmd, { cwd, timeoutMs: 60_000 });
  assert.equal(installed.code, 0, installed.output);
  const result = await runShell(
    './.venv/bin/python -c "print(42)" && ./.venv/bin/pip --version',
    { cwd, timeoutMs: 60_000 },
  );
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /42/);
  assert.match(result.output, /pip \d/);
});
