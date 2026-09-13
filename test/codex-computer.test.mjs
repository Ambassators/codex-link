import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexComputer, parseCodexApps } from '../src/codex-computer.mjs';
import { CodexComputerClient } from '../src/codex-computer-client.mjs';
import { Jobs } from '../src/jobs.mjs';
import { fixture } from './helpers.mjs';
const p = { clientId: 'one', grantId: 'grant', scopes: ['computer:use'] };
const apps = { content: [{ type: 'text', text: 'Discord — /Applications/Discord.app/ — com.hnc.Discord [running]\nInvalid line' }] };
const tick = () => new Promise(r => setImmediate(r));
function backend(t) {
  const f = fixture(t); f.config.value.computerAlwaysEnabled = true; f.config.value.dangerousModeEnabled = true;
  let now = Date.now(); const calls = [], clients = [];
  const owner = { config: f.config, enabled: () => true };
  const native = new CodexComputer(owner, { now: () => now, clientFactory: () => {
    const client = { closed: false, initialize: async () => {}, close() { this.closed = true; }, async call(name, input) {
      assert.equal(this.closed, false); calls.push({ name, input });
      return name === 'list_apps' ? apps : { content: [{ type: 'text', text: '1 button Friends' }, { type: 'image', data: 'fixture-image', mimeType: 'image/png' }] };
    } }; clients.push(client); return client;
  } });
  t.after(() => native.stop());
  return { native, calls, clients, advance: ms => { now += ms; } };
}
test('Codex app parsing uses exact bundle IDs and app key-window semantics', () => {
  assert.deepEqual(parseCodexApps(apps), [{ appName: 'Discord', executable: '/Applications/Discord.app/', appId: 'com.hnc.Discord', windowId: 'com.hnc.Discord', running: true, targetKind: 'app-key-window' }]);
});
test('relay preserves image pixels, app isolation, fresh observations and never replays input', async t => {
  const f = backend(t), a = await f.native.start(await f.native.prepareStart({ windowId: 'com.hnc.Discord' }, p), p);
  assert.throws(() => f.native.session(a.sessionId, { ...p, grantId: 'another' }), /another connection/);
  const obs = await f.native.observe({ sessionId: a.sessionId, maxImageSide: 320 }, p);
  assert.equal(obs.content.at(-1).data, 'fixture-image');
  const args = { sessionId: a.sessionId, observationId: obs.structuredContent.observationId, action: 'click', x: 321, y: 123, idempotencyKey: 'once' };
  const after = await f.native.interact(args, p);
  assert.deepEqual(f.calls.find(c => c.name === 'click'), { name: 'click', input: { app: 'com.hnc.Discord', x: 321, y: 123, mouse_button: 'left', click_count: 1 } });
  assert.equal(after.tree, '1 button Friends'); assert.equal(after.needsObservation, false);
  assert.equal(after.hasImage, false); assert.equal(after.stateStable, true);
  assert.notEqual(after.observationId, obs.structuredContent.observationId);
  await f.native.interact({ sessionId: a.sessionId, observationId: after.observationId, action: 'invoke', elementId: '1', idempotencyKey: 'next' }, p);
  await assert.rejects(f.native.interact(args, p), /stale/);
  assert.equal(f.calls.filter(c => c.name === 'click').length, 2);
  const next = await f.native.observe({ sessionId: a.sessionId }, p); f.advance(30001);
  await assert.rejects(f.native.interact({ ...args, observationId: next.structuredContent.observationId }, p), /stale/);
  f.native.end(a.sessionId, p); assert.ok(f.clients.every(c => c.closed));
});
test('relay rejects unsupported foreground and scroll translations; blocks override dangerous mode', async t => {
  const f = backend(t);
  await assert.rejects(f.native.prepareStart({ windowId: 'com.hnc.Discord', mode: 'foreground' }, p), /manages app input/);
  assert.throws(() => f.native.validateInteraction({ action: 'scroll', x: 1, y: 2, amount: 3 }), /requires elementId/);
  f.native.setRules([{ appId: 'com.hnc.Discord', executable: '/Applications/Discord.app/', mode: 'background', decision: 'block' }]);
  await assert.rejects(f.native.prepareStart({ windowId: 'com.hnc.Discord' }, p), /blocked locally/);
});
test('runtime approval resumes the same runner exactly once and cancellation clears waiters', async t => {
  const f = fixture(t), jobs = new Jobs(f.config); t.after(() => jobs.close()); let runs = 0;
  const j = jobs.create({ kind: 'computer', title: 'App permission', principal: p, approval: false }, async c => { runs++; return { allowed: await c.requestApproval({ source: 'Codex Computer Use', message: 'Allow Discord?' }) }; });
  await tick(); assert.equal(jobs.get(j.id).status, 'awaiting_approval');
  assert.equal(jobs.get(j.id).permissionRequest.message, 'Allow Discord?');
  jobs.approve(j.id, false); await tick();
  assert.equal(runs, 1); assert.equal(jobs.get(j.id).result.allowed, false); assert.equal(jobs.approvals.size, 0);
  const cancelled = jobs.create({ kind: 'computer', title: 'Cancel app', principal: p, approval: false }, c => c.requestApproval({ source: 'Codex Computer Use', message: 'Allow?' }));
  await tick(); jobs.cancel(cancelled.id); await tick();
  assert.equal(jobs.get(cancelled.id).status, 'cancelled'); assert.equal(jobs.approvals.size, 0);
});
// Real stdio framing, initialize, request/response and incoming permission elicitation.
const server = `let buffer=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\\n'))>=0){const m=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const send=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); if(m.method==='initialize')send({protocolVersion:'2024-11-05'});else if(m.method==='tools/list')send({tools:['list_apps','get_app_state','click'].map(name=>({name}))});else if(m.method==='tools/call'){globalThis.pending=m.id;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'consent',method:'elicitation/create',params:{message:'Allow Discord?',requestedSchema:{type:'object',properties:{}}}})+'\\n');}else if(m.id==='consent')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:globalThis.pending,result:{content:[{type:'text',text:m.result.action}]}})+'\\n');}});`;
test('MCP relay forwards owner consent once and never manufactures acceptance', async t => {
  const c = new CodexComputerClient({ executable: process.execPath, args: ['-e', server] }); t.after(() => c.close());
  await c.initialize(); let approvals = 0;
  const r = await c.call('get_app_state', { app: 'com.hnc.Discord' }, { requestApproval: async request => { approvals++; assert.equal(request.message, 'Allow Discord?'); return true; } });
  assert.equal(approvals, 1); assert.equal(r.content[0].text, 'accept');
  await assert.rejects(c.call('get_app_state', { app: 'com.hnc.Discord' }, { requestApproval: async () => false }), /denied/);
  await assert.rejects(c.call('get_app_state', { app: 'com.hnc.Discord' }), /requested consent outside/);
});
test('cancelled MCP calls close the process without retry', async t => {
  const c = new CodexComputerClient({ executable: process.execPath, args: ['-e', server] }); t.after(() => c.close());
  await c.initialize(); const controller = new AbortController();
  const pending = c.call('get_app_state', { app: 'com.hnc.Discord' }, { signal: controller.signal, requestApproval: () => new Promise(() => {}) });
  controller.abort(); await assert.rejects(pending, /cancelled/); assert.equal(c.closed, true); assert.equal(c.pending.size, 0);
});

test('post-action state failure preserves completion and never replays input', async t => {
  const f = backend(t), a = await f.native.start(await f.native.prepareStart({ windowId: 'com.hnc.Discord' }, p), p);
  const obs = await f.native.observe({ sessionId: a.sessionId, includeImage: false }, p);
  assert.equal(obs.structuredContent.tree, '1 button Friends');
  const client = f.native.session(a.sessionId, p).client, original = client.call.bind(client);
  client.call = (name, input) => name === 'get_app_state' ? Promise.reject(new Error('Capture unavailable')) : original(name, input);
  const args = { sessionId: a.sessionId, observationId: obs.structuredContent.observationId, action: 'type', text: 'test', idempotencyKey: 'capture-failed' };
  const result = await f.native.interact(args, p);
  assert.equal(result.actionCompleted, true); assert.equal(result.needsObservation, true);
  assert.equal(result.stateError, 'Capture unavailable'); assert.equal(result.observationId, undefined);
  await assert.rejects(f.native.interact(args, p), /stale/);
  assert.equal(f.calls.filter(c => c.name === 'type_text').length, 1);
});

test('changing interface state stops checking at the settle budget and expires normally', async t => {
  const f = backend(t); f.native.settleMs = 120;
  const a = await f.native.start(await f.native.prepareStart({ windowId: 'com.hnc.Discord' }, p), p);
  const obs = await f.native.observe({ sessionId: a.sessionId }, p);
  const client = f.native.session(a.sessionId, p).client, original = client.call.bind(client); let captures = 0;
  client.call = (name, input) => name === 'get_app_state' ? Promise.resolve({ content: [{ type: 'text', text: `1 text loading ${++captures}` }] }) : original(name, input);
  const result = await f.native.interact({ sessionId: a.sessionId, observationId: obs.structuredContent.observationId, action: 'invoke', elementId: '1', idempotencyKey: 'changing' }, p);
  assert.equal(result.stateStable, false); assert.ok(captures >= 1 && captures <= 3);
  assert.equal(f.native.observationCurrent(result, p), true);
  f.advance(30001); assert.equal(f.native.observationCurrent(result, p), false);
});
