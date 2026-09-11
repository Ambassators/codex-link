import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { assert } from './util.mjs';

export function findExecutable(name, extra = []) {
  const names = process.platform === 'win32' ? [name.endsWith('.exe') ? name : `${name}.exe`] : [name];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const candidate of [...extra, ...dirs.flatMap(dir => names.map(n => path.join(dir, n)))]) if (existsSync(candidate)) return candidate;
  return null;
}
export function nodeCommand(script, args = []) { return { file: process.execPath, args: [script, ...args], env: { ELECTRON_RUN_AS_NODE: '1' } }; }
export function tailscaleCommand(config) {
  let command = config.value.tailscaleCommand;
  if (!command) {
    const file = findExecutable('tailscale', [
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')
    ]);
    assert(file, 'Tailscale is not installed. Run the platform setup script or install Tailscale.'); command = { file, args: [] };
  }
  // Finder-launched apps have no shell environment. The macOS executable otherwise
  // starts its GUI instead of the CLI, leaving status/up/Funnel commands hanging.
  return process.platform === 'darwin' ? { ...command, env: { ...command.env, TAILSCALE_BE_CLI: '1' } } : command;
}
export function pythonCommand(config) {
  if (config.value.pythonCommand) return config.value.pythonCommand;
  const file = path.join(config.home, 'computer-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  assert(existsSync(file), 'Computer-use dependencies are missing. Run the computer setup command shown in the UI.'); return { file, args: [] };
}
export function cleanEnv(extra = {}) {
  // Do not leak bridge-owned tokens into child processes. User's normal environment is retained intentionally.
  const env = { ...process.env, ...extra }; for (const k of Object.keys(env)) if (/^CODEX_LINK_(ADMIN|TOKEN|SECRET)/.test(k)) delete env[k];
  return env;
}
export function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }); killer.on('error', () => { try { child.kill(); } catch {} });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1500); timer.unref();
  }
}
export function launch(command, args = [], options = {}) {
  assert(command && typeof command.file === 'string' && Array.isArray(command.args || []), 'Invalid command configuration');
  return spawn(command.file, [...(command.args || []), ...args], { cwd: options.cwd, env: cleanEnv(command.env || {}), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
}
export function runProcess(command, args = [], { cwd, signal, timeoutMs = 30000, maxOutput = 1024 * 1024, input, onOutput = () => {}, onSpawn = () => {}, keepStdin = false } = {}) {
  assert(!signal?.aborted, 'Operation cancelled');
  return new Promise((resolve, reject) => {
    const child = launch(command, args, { cwd }); let stdout = '', stderr = '', bytes = 0, exceeded = false, timedOut = false;
    const abort = () => killTree(child); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs); timer.unref();
    onSpawn(child);
    const collect = (kind, chunk) => {
      if (bytes >= maxOutput) { if (!exceeded) { exceeded = true; killTree(child); } return; }
      bytes += Buffer.byteLength(chunk); const text = String(chunk).slice(0, Math.max(0, maxOutput - (bytes - Buffer.byteLength(chunk))));
      if (kind === 'stdout') stdout += text; else stderr += text;
      onOutput(kind, text);
      if (bytes > maxOutput && !exceeded) { exceeded = true; killTree(child); }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => collect('stdout', chunk)); child.stderr.on('data', chunk => collect('stderr', chunk));
    child.stdin.on('error', () => {});
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.on('error', e => { cleanup(); reject(e); });
    child.on('close', (code, exitSignal) => {
      cleanup();
      if (signal?.aborted) return reject(new Error('Operation cancelled'));
      if (timedOut) return reject(new Error(`Command timed out after ${timeoutMs} ms; partial output is in the job events`));
      if (exceeded) return reject(new Error('Command exceeded output limit and was stopped; inspect partial output'));
      resolve({ exitCode: code, signal: exitSignal, stdout, stderr });
    });
    if (input !== undefined) child.stdin.write(input);
    if (!keepStdin) child.stdin.end();
  });
}
export function shellCommand(shell, command) {
  if (shell === 'default') shell = process.platform === 'win32' ? 'powershell' : 'bash';
  if (shell === 'powershell' || shell === 'pwsh') {
    let file = findExecutable('pwsh');
    if (!file && process.platform === 'win32' && shell === 'powershell') file = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    assert(file, 'PowerShell is not installed');
    // Base64 avoids Windows quoting and .cmd trampoline bugs. The script itself is intentional user code.
    return { file, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ' + command, 'utf16le').toString('base64')] };
  }
  if (shell === 'cmd') { assert(process.platform === 'win32', 'cmd is Windows-only'); return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'chcp 65001>nul & ' + command] }; }
  assert(['bash', 'zsh', 'sh'].includes(shell), 'Unsupported shell');
  const file = findExecutable(shell); assert(file, `${shell} is not installed`); return { file, args: ['-lc', command] };
}
