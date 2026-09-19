import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireLock } from '../src/main.mjs';

function state(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'codex-link-lock-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, lock: path.join(home, 'instance.lock') };
}

test('instance lock rejects a live owner and can be reacquired after release', t => {
  const { home, lock } = state(t);
  const release = acquireLock(home);
  assert.throws(() => acquireLock(home), /already running/);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  release();
  assert.equal(existsSync(lock), false);
  acquireLock(home)();
});

test('instance lock recovers after its owner exits without cleanup', t => {
  const { home, lock } = state(t);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { acquireLock } from ${JSON.stringify(new URL('../src/main.mjs', import.meta.url).href)}; acquireLock(process.argv[1]);`, home],
  { encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(existsSync(lock), true);
  const release = acquireLock(home);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  release();
});

test('Windows recovers a stale lock whose PID was reused after reboot', { skip: process.platform !== 'win32' }, t => {
  const { home, lock } = state(t);
  // This PID is alive, but its start time is newer than the old lock.
  writeFileSync(lock, String(process.pid));
  utimesSync(lock, new Date(0), new Date(0));
  const release = acquireLock(home);
  // The replacement lock must still prevent a real duplicate instance.
  assert.throws(() => acquireLock(home), /already running/);
  release();
});

test('instance unlock does not remove a replacement owned by another process', t => {
  const { home, lock } = state(t);
  const release = acquireLock(home);
  writeFileSync(lock, String(process.pid + 1));
  release();
  assert.equal(existsSync(lock), true);
});
