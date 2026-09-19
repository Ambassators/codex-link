import { spawn, spawnSync } from 'node:child_process';
import { openSync, writeFileSync, readFileSync, rmSync, mkdirSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDirectory } from './config.mjs';
import { createBridge } from './server.mjs';

function reusedWindowsPid(pid, lockModifiedAt) {
  // A PID can belong to an unrelated process after a crash or reboot. A process
  // started after the lock was written cannot own that lock. Keep the lock if
  // Windows cannot report the start time, rather than risk two active writers.
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; [Console]::Write(([DateTimeOffset](Get-Process -Id ${pid}).StartTime.ToUniversalTime()).ToUnixTimeMilliseconds())`],
  { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.error || result.status !== 0 || !/^\d+$/.test(result.stdout.trim())) return false;
  // Allow for filesystem timestamp precision.
  return Number(result.stdout.trim()) > lockModifiedAt + 1000;
}

export function acquireLock(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 }); const lock = path.join(home, 'instance.lock');
  try { const fd = openSync(lock, 'wx', 0o600); try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); } }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let previous, modifiedAt; try { previous = Number(readFileSync(lock, 'utf8')); modifiedAt = statSync(lock).mtimeMs; } catch { throw new Error('Cannot inspect existing app lock'); }
    if (!Number.isSafeInteger(previous) || previous < 1 || previous > 0xffffffff) throw new Error('Invalid instance.lock; inspect it before removing it');
    let alive = true;
    try { process.kill(previous, 0); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; alive = false; }
    if (alive && !(process.platform === 'win32' && reusedWindowsPid(previous, modifiedAt))) throw new Error(`Codex Link is already running (PID ${previous})`);
    // Another starter may have recovered this stale lock while we inspected it.
    if (Number(readFileSync(lock, 'utf8')) !== previous || statSync(lock).mtimeMs !== modifiedAt) return acquireLock(home);
    rmSync(lock); return acquireLock(home);
  }
  return () => { try { if (readFileSync(lock, 'utf8') === String(process.pid)) rmSync(lock); } catch {} };
}
export async function main() {
  const home = dataDirectory(), unlock = acquireLock(home);
  let bridge;
  try { bridge = await createBridge({ home, autoEnableConnection: true }); } catch (e) { unlock(); throw e; }
  console.log(`\nCodex Link is running.\n\nOpen the PRIVATE local control panel:\n${bridge.adminUrl}\n\nDo not share this URL or expose port ${bridge.adminPort}.\nState directory: ${home}\nPress Ctrl+C to stop.\n`);
  if (process.env.CODEX_LINK_OPEN_BROWSER === '1') {
    let child;
    if (process.platform === 'darwin') child = spawn('/usr/bin/open', [bridge.adminUrl], { stdio: 'ignore' });
    else if (process.platform === 'win32') {
      // The generated URL contains only loopback, digits and URL-safe random bytes, never arbitrary shell text.
      child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', bridge.adminUrl], { stdio: 'ignore' });
    }
    child?.on('error', e => console.error(`Open the printed URL manually: ${e.message}`)); child?.unref();
  }
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; await bridge.close(); unlock(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  process.on('exit', unlock);
  return bridge;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
