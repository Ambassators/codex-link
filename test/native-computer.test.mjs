import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NativeComputer, imagePoint, sameTarget, validateInteraction } from '../src/native-computer.mjs';
import { Computer } from '../src/computer.mjs';
import { Tools } from '../src/tools.mjs';
import { Jobs } from '../src/jobs.mjs';

const principal = { clientId: 'native-test-client', grantId: 'grant-a', scopes: ['bridge:read', 'computer:use'] };
const target = { appId: 'dev.fixture.editor', executable: '/fixture/editor', appName: 'Fixture Editor', pid: 700, processStart: '123456', windowId: '70', bounds: { x: -1600, y: 100, width: 1200, height: 800 }, title: 'private title', blocked: false };
const frame = { ...target.bounds, imageWidth: 600, imageHeight: 400 };
const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(options = {}) {
  let clock = Date.now();
  const calls = [];
  const config = { value: { computerAlwaysEnabled: true, computerEnabledUntil: 0, remotePaused: false, computerAppRules: [], autoApproveWrites: false, autoApproveShell: false }, save() {} };
  const owner = { config, tail: Promise.resolve(), enabled: () => config.value.computerAlwaysEnabled || config.value.computerEnabledUntil > clock };
  const transport = async (request, context) => {
    calls.push(clone(request));
    if (options.handler) { const result = await options.handler(request, context); if (result !== undefined) return result; }
    if (request.op === 'status') return { protocol: 1, capabilities: { lockedUse: false } };
    if (request.op === 'windows') return { protocol: 1, windows: [clone(target)] };
    if (request.op === 'describe') return { protocol: 1, target: { ...clone(target), windowId: request.windowId, pid: request.windowId === '71' ? 701 : 700 } };
    if (request.op === 'observe') return { protocol: 1, target: clone(request.target), frame: clone(frame), elements: [{ id: 'e0', path: [0], fingerprint: 'fingerprint-a', protected: false, role: 'button', name: 'Save', bounds: { x: -1500, y: 200, width: 200, height: 40 } }] };
    if (request.op === 'interact') return { protocol: 1, ok: true, action: request.action, foregroundChanged: false };
    throw Error('Unexpected native operation');
  };
  const native = new NativeComputer(owner, { platform: options.platform || 'darwin', arch: 'arm64', transport, now: () => clock });
  owner.native = native;
  const start = async (windowId = '70', mode) => native.start(await native.prepareStart({ windowId, mode }, principal), principal);
  const observe = async session => native.observe({ sessionId: session.sessionId }, principal);
  const interact = (session, observation, action = 'invoke', extra = {}) => native.interact({ sessionId: session.sessionId, observationId: observation.observationId, action, ...(action === 'invoke' ? { elementId: 'e0' } : {}), ...extra }, principal);
  return { native, owner, config, calls, start, observe, interact, advance: ms => { clock += ms; } };
}

test('platform capabilities explicitly distinguish macOS and Windows without claiming private cursors or locked use', async () => {
  for (const platform of ['darwin', 'win32']) {
    const f = fixture({ platform }); const capabilities = await f.native.capabilities();
    assert.equal(capabilities.defaultMode, platform === 'darwin' ? 'background' : 'foreground');
    assert.equal(capabilities.independentSystemCursor, false); assert.equal(capabilities.lockedUse, false);
    assert.equal(capabilities.legacyEnabled, false); assert.equal(f.calls[0].op, 'status');
  }
});
test('diagnostics do not require a lease but window discovery and session creation do', async () => {
  const f = fixture(); f.config.value.computerAlwaysEnabled = false;
  assert.equal((await f.native.capabilities()).installed, true);
  await assert.rejects(f.native.windows(principal), /Enable computer/);
  await assert.rejects(f.start(), /Enable computer/);
  assert.deepEqual(f.calls.map(c => c.op), ['status']);
});
test('default app policy asks; saved allows are mode-specific and blocks override every mode', async () => {
  const f = fixture();
  assert.equal((await f.native.prepareStart({ windowId: '70' }, principal)).needsApproval, true);
  f.native.setRules([{ appId: target.appId, executable: target.executable, mode: 'background', decision: 'allow' }]);
  assert.equal((await f.native.prepareStart({ windowId: '70' }, principal)).needsApproval, false);
  assert.equal((await f.native.prepareStart({ windowId: '70', mode: 'foreground' }, principal)).needsApproval, true);
  f.native.setRules([{ appId: target.appId, executable: target.executable, mode: 'foreground', decision: 'block' }]);
  await assert.rejects(f.start(), /blocked/);
});
test('application policy validates unknown fields, duplicate rules and exact identities', () => {
  const f = fixture(), rule = { appId: target.appId, executable: target.executable, mode: 'background', decision: 'allow' };
  assert.throws(() => f.native.setRules([{ ...rule, anything: true }]), /Unknown/);
  assert.throws(() => f.native.setRules([rule, rule]), /Duplicate/);
  f.native.setRules([rule]); assert.equal(f.native.decision({ ...target, executable: '/other/editor' }, 'background'), 'ask');
});
test('sessions bind both OAuth client and grant identity', async () => {
  const f = fixture(), s = await f.start();
  for (const other of [{ ...principal, clientId: 'other' }, { ...principal, grantId: 'other' }]) {
    assert.throws(() => f.native.session(s.sessionId, other), /another connection/);
    assert.throws(() => f.native.end(s.sessionId, other), /another connection/);
  }
  assert.equal(f.native.end(s.sessionId, principal).closed, true);
  assert.equal(f.native.end(s.sessionId, principal).closed, true);
});
test('window titles remain redacted until this connection has an unexpired approved session', async () => {
  const f = fixture(); assert.equal((await f.native.windows(principal)).windows[0].title, undefined);
  await f.start(); assert.equal((await f.native.windows(principal)).windows[0].title, target.title);
  assert.equal((await f.native.windows({ ...principal, clientId: 'other' })).windows[0].title, undefined);
  f.advance(16 * 60 * 1000); assert.equal((await f.native.windows(principal)).windows[0].title, undefined);
});
test('session approval is invalidated by stop and process replacement', async () => {
  const f = fixture(); const prepared = await f.native.prepareStart({ windowId: '70' }, principal);
  f.native.stop(); await assert.rejects(f.native.start(prepared, principal), /revoked/);
  assert.equal(sameTarget(target, { ...target, processStart: 'new-process' }), false);
});
test('a process change while local approval is pending prevents creating a session', async () => {
  let changed = false;
  const f = fixture({ handler: request => request.op === 'describe' && changed ? { protocol: 1, target: { ...clone(target), processStart: 'replacement' } } : undefined });
  const prepared = await f.native.prepareStart({ windowId: '70' }, principal); changed = true;
  await assert.rejects(f.native.start(prepared, principal), /changed while approval/);
});
test('observations are single-use and reused screenshots cannot cause duplicate clicks', async () => {
  const f = fixture(), s = await f.start(), o = await f.observe(s);
  await f.interact(s, o);
  await assert.rejects(f.interact(s, o), /stale or already used/);
  assert.equal(f.calls.filter(c => c.op === 'interact').length, 1);
});
test('stale observations and expired sessions fail without sending input', async () => {
  const f = fixture(), s = await f.start(), o = await f.observe(s); f.advance(30001);
  await assert.rejects(f.interact(s, o), /stale/);
  f.advance(15 * 60 * 1000); await assert.rejects(f.observe(s), /expired/);
  assert.equal(f.calls.filter(c => c.op === 'interact').length, 0);
});
test('high-DPI and negative-monitor geometry map image pixels to the same native point', async () => {
  assert.deepEqual(imagePoint(frame, 100, 50), { x: -1400, y: 200 });
  for (const point of [[600, 0], [-1, 0], [0, 400], [0.5, 0]]) assert.throws(() => imagePoint(frame, ...point), /outside/);
  assert.throws(() => imagePoint({ ...frame, imageWidth: 0 }, 0, 0), /geometry/);
  const f = fixture(), s = await f.start(), o = await f.observe(s);
  assert.deepEqual(o.elements[0].bounds, { x: 50, y: 50, width: 100, height: 20 });
  assert.equal(o.elements[0].fingerprint, undefined); assert.equal(o.elements[0].path, undefined);
  await f.interact(s, o, 'click', { x: 100, y: 50 });
  const request = f.calls.at(-1); assert.equal(request.x, -1400); assert.equal(request.y, 200);
});
test('action variants reject missing and extraneous arguments instead of using unsafe defaults', () => {
  const base = { sessionId: 's', observationId: 'o' };
  assert.throws(() => validateInteraction({ ...base, action: 'click', x: 1 }), /Invalid y/);
  assert.throws(() => validateInteraction({ ...base, action: 'type', text: 'x', x: 2 }), /Unexpected/);
  assert.throws(() => validateInteraction({ ...base, action: 'scroll', x: 0, y: 0, amount: 31 }), /amount/);
  assert.throws(() => validateInteraction({ ...base, action: 'key', keys: ['ctrl', 'ctrl'] }), /Duplicate/);
  assert.throws(() => validateInteraction({ ...base, action: 'type', text: '\0' }), /NUL/);
  assert.throws(() => validateInteraction({ ...base, action: '__proto__' }), /Unknown/);
});
test('Windows background sessions allow semantic UI Automation but never global mouse or keyboard fallback', async () => {
  const f = fixture({ platform: 'win32' }), s = await f.start('70', 'background'), o = await f.observe(s);
  await assert.rejects(f.interact(s, o, 'click', { x: 20, y: 20 }), /UI Automation/);
  await f.interact(s, o); assert.equal(f.calls.at(-1).action, 'invoke');
});
test('macOS background drag maps both endpoints without granting foreground access', async () => {
  const f = fixture(), s = await f.start(), o = await f.observe(s);
  await assert.rejects(f.interact(s, o, 'focus'), /foreground/);
  await assert.rejects(f.interact(s, o, 'drag', { x: 0, y: 0, toX: 601, toY: 10 }), /outside/i);
  await f.interact(s, o, 'drag', { x: 0, y: 0, toX: 10, toY: 10 });
  assert.equal(f.calls.at(-1).mode, 'background');
  assert.deepEqual([f.calls.at(-1).x, f.calls.at(-1).y, f.calls.at(-1).toX, f.calls.at(-1).toY], [-1600, 100, -1580, 120]);
  await assert.rejects(f.interact(s, o, 'drag', { x: 0, y: 0, toX: 10, toY: 10 }), /already used/);
  const w = fixture({ platform: 'win32' }), ws = await w.start('70', 'background'), wo = await w.observe(ws);
  await assert.rejects(w.interact(ws, wo, 'drag', { x: 0, y: 0, toX: 10, toY: 10 }), /UI Automation/);
});
test('a protected accessibility element cannot be targeted', async () => {
  const f = fixture(), s = await f.start(), o = await f.observe(s);
  f.native.session(s.sessionId, principal).observation.elements.get('e0').protected = true;
  await assert.rejects(f.interact(s, o), /protected/);
});
test('native errors consume the observation; an uncertain side effect is not retried', async () => {
  const f = fixture({ handler: request => request.op === 'interact' ? { protocol: 1, error: { code: 'stale_element', message: 'Element moved' } } : undefined });
  const s = await f.start(), o = await f.observe(s);
  await assert.rejects(f.interact(s, o), /Element moved/);
  await assert.rejects(f.interact(s, o), /already used/);
});
test('background focus changes close the affected session without trying to steal focus back', async () => {
  const f = fixture({ handler: request => request.op === 'interact' ? { protocol: 1, ok: true, foregroundChanged: true } : undefined });
  const s = await f.start(), o = await f.observe(s), result = await f.interact(s, o);
  assert.equal(result.sessionClosed, true); assert.equal(f.native.sessions.size, 0);
  assert.equal(f.calls.filter(c => c.op === 'interact').length, 1);
});
test('stop cancels in-flight and queued native work and discards all sessions', async () => {
  const entered = deferred();
  const f = fixture({ handler: (request, { signal }) => {
    if (request.op !== 'observe') return;
    entered.resolve();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('Operation cancelled')), { once: true }));
  } });
  const s = await f.start();
  const first = f.observe(s); await entered.promise;
  const second = f.observe(s);
  const checked = Promise.all([assert.rejects(first, /cancelled/), assert.rejects(second, /cancelled|expired/)]);
  f.native.stop(); await checked;
  assert.equal(f.native.sessions.size, 0); assert.equal(f.native.controllers.size, 0);
  assert.equal(f.calls.filter(c => c.op === 'observe').length, 1);
});
test('foreground work waits behind background work in the same app', async () => {
  const entered = deferred(), release = deferred(); let observed = 0;
  const f = fixture({ handler: async request => {
    if (request.op === 'observe' && ++observed === 1) { entered.resolve(); await release.promise; }
  } });
  const background = await f.start('70', 'background'), foreground = await f.start('70', 'foreground');
  const first = f.observe(background); await entered.promise;
  const second = f.observe(foreground); await tick(); assert.equal(observed, 1);
  release.resolve(); await Promise.all([first, second]); assert.equal(observed, 2);
});
test('background work may overlap across separate app processes while foreground work stays global', async () => {
  const gate = deferred(); let entered = 0;
  const f = fixture({ handler: async request => { if (request.op === 'observe') { entered++; await gate.promise; } } });
  const a = await f.start('70', 'background'), b = await f.start('71', 'background');
  const first = f.observe(a), second = f.observe(b); await tick(); assert.equal(entered, 2);
  gate.resolve(); await Promise.all([first, second]);
});
test('oversized requests and invalid native protocols do not leak controllers', async () => {
  const f = fixture(); await assert.rejects(f.native.invoke({ op: 'status', oversized: 'x'.repeat(131073) }), /128 KiB/);
  assert.equal(f.native.controllers.size, 0);
  const bad = fixture({ handler: () => ({ protocol: 99 }) });
  await assert.rejects(bad.native.invoke({ op: 'status' }), /protocol mismatch/); assert.equal(bad.native.controllers.size, 0);
});
test('permission changes invalidate sessions and independently gate legacy PyAutoGUI', async () => {
  const f = fixture(), s = await f.start();
  f.native.setRules([]); assert.throws(() => f.native.session(s.sessionId, principal), /expired/);
  const computer = new Computer(f.config);
  await assert.rejects(computer.action({ action: 'screenshot' }), /legacy desktop control is disabled/);
});

async function toolsFixture(t) {
  const f = fixture(); f.config.home = mkdtempSync(path.join(tmpdir(), 'codex-link-native-test-'));
  const jobs = new Jobs(f.config);
  const oauth = { require(p, scopes) { assert.ok(scopes.every(s => p.scopes.includes(s)), 'scope denied'); } };
  const tools = new Tools({ config: f.config, jobs, computer: f.owner, oauth, audit() {}, workspaces: { list: () => [] } });
  t.after(async () => { f.native.stop(); await jobs.close(); rmSync(f.config.home, { recursive: true, force: true }); });
  const call = async (name, args) => (await tools.call(name, args, principal)).structuredContent;
  const complete = async id => { for (let i = 0; i < 100 && ['running', 'queued'].includes(jobs.get(id).status); i++) await new Promise(r => setTimeout(r, 5)); return jobs.get(id); };
  return { ...f, tools, jobs, call, complete };
}
test('native tool registration retains existing tools and advertises strict native schemas', async t => {
  const f = await toolsFixture(t), names = f.tools.list().map(t => t.name);
  for (const name of ['file_read', 'conversation_read', 'computer_action', 'computer_capabilities', 'computer_windows', 'computer_session_start', 'computer_observe', 'computer_interact', 'computer_session_end']) assert.ok(names.includes(name));
  await assert.rejects(f.call('computer_interact', { sessionId: 's', observationId: 'o', action: 'type', text: 'test', idempotencyKey: 'k', unexpected: true }), /unknown argument/);
});
test('session start is approval-gated; duplicate idempotency keys never create another grant', async t => {
  const f = await toolsFixture(t);
  const args = { windowId: '70', idempotencyKey: 'session-once' };
  const job = await f.call('computer_session_start', args);
  assert.equal(job.status, 'awaiting_approval'); assert.equal(f.native.sessions.size, 0);
  assert.equal(job.request, undefined); assert.ok(!JSON.stringify(job).includes(target.title));
  assert.equal(f.jobs.get(job.id).request.target.executable, target.executable);
  f.jobs.approve(job.id, true); const completed = await f.complete(job.id);
  assert.equal(completed.status, 'completed'); assert.equal(f.native.sessions.size, 1);
  const count = f.calls.length; const retry = await f.call('computer_session_start', args);
  assert.equal(retry.id, job.id); assert.equal(f.calls.length, count);
  await assert.rejects(f.call('computer_session_start', { ...args, mode: 'foreground' }), /different arguments/);
});
test('typed text is redacted before first persistence and idempotent retries do not resend input', async t => {
  const f = await toolsFixture(t), s = await f.start(), o = await f.observe(s);
  const secret = 'private-test-text-not-for-job-storage';
  const args = { sessionId: s.sessionId, observationId: o.observationId, action: 'type', text: secret, idempotencyKey: 'type-once' };
  const job = await f.call('computer_interact', args); await f.complete(job.id);
  assert.equal(f.jobs.get(job.id).status, 'completed');
  assert.ok(!readFileSync(path.join(f.config.home, 'jobs.json'), 'utf8').includes(secret));
  const count = f.calls.length; const retry = await f.call('computer_interact', args);
  assert.equal(retry.id, job.id); assert.equal(f.calls.length, count);
  assert.equal(f.calls.at(-1).text, secret);
});


test('concurrent approved session completions cannot exceed the eight-session cap', async () => {
  const f = fixture();
  const prepared = await Promise.all(Array.from({ length: 9 }, () => f.native.prepareStart({ windowId: '70' }, principal)));
  const results = await Promise.allSettled(prepared.map(p => f.native.start(p, principal)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 8);
  assert.equal(f.native.sessions.size, 8);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
});

test('a native operation is aborted at the owner lease deadline', async () => {
  const f = fixture({ handler: (request, { signal }) => request.op === 'observe' ? new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Error('Lease deadline cancelled operation')), { once: true });
  }) : undefined });
  const session = await f.start();
  f.config.value.computerAlwaysEnabled = false;
  f.config.value.computerEnabledUntil = Date.now() + 35;
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(f.observe(session), /deadline cancelled/); }
  finally { clearTimeout(keepAlive); f.native.stop(); }
  assert.equal(f.native.controllers.size, 0);
});
