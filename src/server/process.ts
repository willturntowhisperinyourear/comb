import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function shellCommand(command: string): { file: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { file: process.env.COMB_SHELL || '/bin/bash', args: ['-lc', command] };
  }

  // Use Git Bash, not the Windows bash.exe alias that launches WSL.
  const roots = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)']!, 'Git'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git'),
    ...(process.env.PATH ?? '').split(';').map((entry) => {
      const path = entry.replace(/^"|"$/g, '');
      return existsSync(join(path, 'git.exe')) ? resolve(path, '..') : null;
    }),
  ].filter((path): path is string => !!path);
  const file = process.env.COMB_SHELL || roots
    .flatMap((root) => [join(root, 'bin', 'bash.exe'), join(root, 'usr', 'bin', 'bash.exe')])
    .find(existsSync);
  if (!file) throw new Error('Bash not found. Install Git for Windows or set COMB_SHELL to the full path of Git Bash.');

  // Windows Python creates Scripts/, even when invoked from Git Bash.
  const script = command
    .replace(/(^|&&\s*|\|\|\s*|;\s*)python3(?=\s)/g, '$1python')
    .replace(/\.venv\/bin\//g, '.venv/Scripts/');
  return { file, args: ['-c', script] };
}

export function spawnShell(command: string, options: SpawnOptionsWithoutStdio = {}) {
  const { file, args } = shellCommand(command);
  return spawn(file, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Killing only bash.exe leaves its connector alive and holding the port.
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => child.kill(signal));
  } else {
    child.kill(signal);
  }
}

interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onLine?: (line: string) => void;
}

export function runProcess(file: string, args: string[], options: RunOptions): Promise<{ code: number; output: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(file, args, {
      cwd: options.cwd, env: { ...process.env, ...options.env }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      output += `\nCommand timed out after ${options.timeoutMs} ms`;
      killProcessTree(child, 'SIGKILL');
    }, options.timeoutMs) : undefined;
    const push = (buffer: Buffer) => {
      const text = buffer.toString();
      output += text;
      options.onLine?.(text);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.once('error', (error) => {
      clearTimeout(timer);
      push(Buffer.from(String(error)));
      resolveResult({ code: 1, output });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveResult({ code: timedOut ? 1 : code ?? 1, output });
    });
  });
}

export async function runShell(command: string, options: RunOptions) {
  const { file, args } = shellCommand(command);
  return runProcess(file, args, options);
}
