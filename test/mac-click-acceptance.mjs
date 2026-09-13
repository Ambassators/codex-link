// Opt-in desktop acceptance test: node test/mac-click-acceptance.mjs [helper-path]
// Opens two disposable Electron processes and verifies received DOM events.
// Does not change the running bridge, its policy, or macOS privacy permissions.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeComputer } from '../src/native-computer.mjs';

assert.equal(process.platform, 'darwin', 'This acceptance test requires macOS');
const root = fileURLToPath(new URL('../', import.meta.url));
const helper = process.argv[2] || path.join(root, 'computer/bin', `darwin-${process.arch}`, 'codex-link-computer');
const home = mkdtempSync(path.join(tmpdir(), 'codex-click-acceptance-'));
const processes = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const events = file => {
  try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
};
async function waitFor(fn, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await pause(50); }
  throw Error(message);
}
const owner = { config: { value: { computerAlwaysEnabled: true, computerAppRules: [] } }, enabled: () => true, tail: Promise.resolve() };
const native = new NativeComputer(owner, { transport: async request => {
  const process = spawnSync(helper, [], { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15000 });
  assert.ifError(process.error);
  return JSON.parse(process.stdout);
} });
const principal = { clientId: 'local-click-acceptance', grantId: 'disposable-fixtures', scopes: ['computer:use'] };
async function launch(name) {
  const file = path.join(home, name + '.jsonl');
  const result = spawnSync('open', ['-g', '-n', '-a', path.join(root, 'desktop/node_modules/electron/dist/Electron.app'), '--args',
    path.join(root, 'test/fixtures/mac-input-parity.cjs'), '--event-file', file, '--accessibility-ready']);
  assert.equal(result.status, 0);
  const ready = await waitFor(() => events(file).find(e => e.event === 'ready'), 'Fixture did not start');
  processes.push(ready.pid);
  const window = await waitFor(async () => (await native.windows(principal)).windows.find(w => w.pid === ready.pid && w.bounds.width === 620), 'Fixture window is missing');
  return { file, window };
}
const start = async (window, mode) => native.start(await native.prepareStart({ windowId: window.windowId, mode }, principal), principal);
async function act(session, action, control) {
  let lastObservation;
  return waitFor(async () => {
    const observation = await native.observe({ sessionId: session.sessionId }, principal);
    lastObservation = observation;
    const bounds = control && observation.elements.find(e => e.name === control)?.bounds;
    if (control && !bounds) return null;
    try {
      return await native.interact({ sessionId: session.sessionId, observationId: observation.observationId, action,
        ...(bounds ? { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) } : {}) }, principal);
    } catch (error) {
      // This rejection explicitly precedes pointer input. Wait for the owner's
      // held buttons/modifiers, then obtain a new observation; never replay an
      // uncertain click or suppress the native human-input guard.
      if (error.code === 'human_input') return null;
      throw error;
    }
  }, `Control ${control || action} was unavailable or human input stayed held`).catch(error => {
    if (!error.code) console.error(JSON.stringify({ target: lastObservation?.target,
      elements: lastObservation?.elements.slice(0, 12).map(e => ({ role: e.role, name: e.name })), treeTruncated: lastObservation?.treeTruncated }));
    throw error;
  });
}
try {
  const target = await launch('target');
  const blocker = await launch('blocker');
  const front = await start(blocker.window, 'foreground');
  await act(front, 'focus');
  const background = await start(target.window, 'background');
  for (let count = 1; count <= 3; count++) {
    const result = await act(background, 'click', 'Pointer test canvas');
    assert.equal(result.inputMethod, 'accessibility');
    assert.equal(result.foregroundChanged, false);
    await waitFor(() => events(target.file).filter(e => e.event === 'click-details').length === count, 'Background click was silently lost');
    const click = events(target.file).filter(e => e.event === 'click-details').at(-1);
    assert.deepEqual(click, { event: 'click-details', meta: false, ctrl: false, shift: false, alt: false });
  }
  await assert.rejects(act(background, 'double_click', 'Pointer test canvas'), /foreground session/i);
  assert.equal(events(target.file).filter(e => e.event === 'click-details').length, 3);
  const foreground = await start(target.window, 'foreground');
  await act(foreground, 'focus');
  assert.equal((await native.observe({ sessionId: foreground.sessionId }, principal)).target.frontmost, true, 'Focus must finish actual activation');
  const result = await act(foreground, 'double_click', 'Pointer test canvas');
  assert.equal(result.inputMethod, 'quartz');
  await waitFor(() => events(target.file).some(e => e.event === 'pointer' && e.double === 1 && e.click === 5), 'Foreground double click was silently lost');
  console.log('PASS: 3 unmodified background clicks; inactive raw input rejected without a click; verified foreground activation and double click.');
} finally {
  native.stop();
  for (const pid of processes) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  rmSync(home, { recursive: true, force: true });
}
