import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { NativeComputer } from '../src/native-computer.mjs';
import { CodexComputer } from '../src/codex-computer.mjs';
import { installNativeComputerTools } from '../src/native-computer-tools.mjs';
import { createBridge } from '../src/server.mjs';
import { id, challenge } from '../src/util.mjs';
import { fixture, register, waitJob } from './helpers.mjs';
import { findExecutable } from '../src/process.mjs';

function hostStatus(url, host) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Host: host } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
  });
}
async function server(t) {
  const f = fixture(t), b = await createBridge({ config: f.config, adminPort: 0, publicPort: 0 });
  // Explicit final cleanup after all persisted job/server state has been flushed.
  t.after(async () => { await b.close(); rmSync(f.base, { recursive: true, force: true }); });
  const remote = `http://127.0.0.1:${b.publicPort}`, local = `http://127.0.0.1:${b.adminPort}`;
  const admin = (route, data) => fetch(local + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-Codex-Link-Admin': b.adminToken, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const auth = register(b.oauth), token = auth.tokens().access_token;
  const rpc = async (method, params = {}, bearer = token, extra = {}) => {
    const r = await fetch(remote + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-11-25', ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { response: r, body: await r.json() };
  };
  const tool = async (name, args = {}, bearer) => (await rpc('tools/call', { name, arguments: args }, bearer)).body.result;
  return { ...f, b, remote, local, admin, auth, token, rpc, tool };
}

test('macOS exposes inspection but rejects removed structured input without executing it', async t => {
  const { b, tool, admin, rpc } = await server(t);
  const calls = [];
  b.computer.native.stop();
  b.computer.native = new CodexComputer(b.computer, { clientFactory: () => ({
    initialize: async () => {}, close() {}, async call(name, args) {
      calls.push({ name, args });
      return name === 'list_apps' ? { content: [], structuredContent: { apps: [{ id: 'fixture.app', displayName: 'Fixture', isRunning: true }] } } : { content: [{ type: 'text', text: '24 button Test' }, { type: 'image', mimeType: 'image/png', data: 'fixture-image' }] };
    }
  }) });
  installNativeComputerTools(b.tools);
  await admin('/api/dangerous', { enabled: true });
  const start = (await tool('computer_session_start', { windowId: 'fixture.app', idempotencyKey: 'relay-start' })).structuredContent;
  const session = (await waitJob(b.jobs, start.id)).result;
  const observation = await tool('computer_observe', { sessionId: session.sessionId });
  assert.equal(observation.content[2].type, 'image');
  assert.equal(observation.content[2].data, 'fixture-image');
  const args = { sessionId: session.sessionId, observationId: observation.structuredContent.observationId, action: 'invoke', elementId: '24', idempotencyKey: 'relay-click' };
  const names = (await rpc('tools/list')).body.result.tools.map(t => t.name);
  assert.ok(!names.includes('computer_interact'));
  if (process.platform === 'darwin') assert.ok(names.includes('computer_js'));
  const jobsBefore = b.jobs.store.data.jobs.length;
  const rejected = await tool('computer_interact', args);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /Unknown tool/);
  assert.equal(b.jobs.store.data.jobs.length, jobsBefore);
  assert.equal(calls.filter(c => c.name === 'click').length, 0);
  assert.equal(b.computer.legacyEnabled(), false);
  const treeOnly = await tool('computer_observe', { sessionId: session.sessionId, includeImage: false });
  assert.equal(treeOnly.structuredContent.tree, '24 button Test');
  assert.ok(!treeOnly.content.some(c => c.type === 'image'));
  assert.equal((await tool('computer_session_end', { sessionId: session.sessionId })).structuredContent.closed, true);
});

test('HTTP Computer Use REPL requires execution scope and returns native images inline', { skip: process.platform !== 'darwin' }, async t => {
  const { b, tool, admin } = await server(t);
  const calls=[];
  b.computer.repl.clientFactory=()=>({closed:false,initialize:async()=>{},close(){this.closed=true},async replCall(name,args){calls.push({name,args});return {content:[{type:'text',text:args.code},{type:'image',mimeType:'image/png',data:'native-image'}],_meta:{native:true}};}});
  await admin('/api/dangerous',{enabled:true});
  const code='let app = await cua.getApp("Calculator");';
  const result=await tool('computer_js',{code,idempotencyKey:'raw-once'});
  assert.equal(result.content[0].text,code);assert.equal(result.content[1].data,'native-image');assert.equal(result._meta.native,true);
  const limited=register(b.oauth,'bridge:read computer:use').tokens().access_token;
  const denied=await tool('computer_js',{code},limited);assert.equal(denied.isError,true);assert.equal(calls.length,1);
  await admin('/api/computer',{enabled:false});assert.equal(b.computer.repl.sessions.size,0);
});

test('HTTP OAuth discovery, DCR, browser pairing, consent, PKCE token and authenticated MCP', async t => {
  const { b, remote, rpc } = await server(t);
  const meta = await (await fetch(remote + '/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(meta.resource, b.oauth.resource);
  const authorization = await (await fetch(remote + '/.well-known/oauth-authorization-server')).json();
  assert.equal(authorization.authorization_response_iss_parameter_supported, true);
  const clientResponse = await fetch(remote + '/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'HTTP integration test', redirect_uris: b.config.value.redirectUris, token_endpoint_auth_method: 'none' }) });
  assert.equal(clientResponse.status, 201); const client = await clientResponse.json();
  const ticket = new URL(b.oauth.pairTicket().url).hash.split('ticket=')[1];
  const pairing = await fetch(remote + '/oauth/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: b.oauth.issuer }, body: JSON.stringify({ ticket }) });
  assert.equal(pairing.status, 200); const cookie = pairing.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
  const verifier = id(48), query = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', scope: 'bridge:read files:read files:write', state: 'http-test', resource: b.oauth.resource, code_challenge_method: 'S256', code_challenge: challenge(verifier) });
  const page = await (await fetch(remote + '/oauth/authorize?' + query, { headers: { Cookie: cookie.split(';')[0] } })).text();
  const request_id = /name="request_id" value="([^"]+)"/.exec(page)?.[1], csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1];
  assert.ok(request_id); assert.ok(csrf);
  const consent = await fetch(remote + '/oauth/authorize', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie.split(';')[0], Origin: b.oauth.issuer }, body: new URLSearchParams({ request_id, csrf, decision: 'allow' }) });
  assert.equal(consent.status, 303); const redirect = new URL(consent.headers.get('location'));
  assert.equal(redirect.searchParams.get('iss'), b.oauth.issuer); assert.equal(redirect.searchParams.get('state'), 'http-test');
  const tokenResponse = await fetch(remote + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], resource: b.oauth.resource, code_verifier: verifier, code: redirect.searchParams.get('code') }) });
  assert.equal(tokenResponse.status, 200); const token = await tokenResponse.json();
  assert.ok(token.refresh_token);
  const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'integration-test', version: '1' }, capabilities: {} }, token.access_token);
  assert.equal(initialized.body.result.serverInfo.name, 'codex-link');
  const list = await rpc('tools/list', {}, token.access_token); assert.ok(list.body.result.tools.find(x => x.name === 'file_read')); assert.equal(list.body.result.tools.length, process.platform === 'darwin' ? 26 : 24); assert.ok(list.body.result.tools.every(x => !x.name.startsWith('codex_')));
  const revoked = await fetch(remote + '/oauth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client.client_id, token: token.access_token }) });
  assert.equal(revoked.status, 200); assert.equal((await rpc('ping', {}, token.access_token)).response.status, 401);
});

test('public transport never exposes admin APIs; Host/Origin and bearer are checked', async t => {
  const { remote, local, token } = await server(t);
  const denied = await fetch(remote + '/mcp'); assert.equal(denied.status, 401); assert.match(denied.headers.get('www-authenticate'), /resource_metadata/);
  assert.equal((await fetch(local + '/api/state')).status, 401);
  assert.equal((await fetch(remote + '/api/state', { headers: { Authorization: `Bearer ${token}` } })).status, 404);
  assert.equal(await hostStatus(local + '/', 'evil.example'), 403);
  assert.equal((await fetch(remote + '/healthz', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal(await hostStatus(remote + '/healthz', 'evil.example'), 403);
  assert.equal((await fetch(remote + '/mcp', { headers: { Authorization: `Bearer ${token}` } })).status, 405);
});

test('MCP validates negotiation, notifications, JSON, scopes and tool argument schemas', async t => {
  const { rpc, remote, token, b, tool } = await server(t);
  assert.equal((await rpc('ping', {}, token, { Accept: 'application/json' })).response.status, 406);
  assert.equal((await rpc('ping', {}, token, { 'MCP-Protocol-Version': '1900-01-01' })).response.status, 400);
  assert.equal((await rpc('unknown')).body.error.code, -32601);
  const note = await fetch(remote + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202); assert.equal(await note.text(), '');
  const readonly = register(b.oauth, 'bridge:read files:read').tokens().access_token;
  const denied = await tool('shell_start', { workspace: 'project', command: 'echo never', idempotencyKey: 'deny' }, readonly);
  assert.equal(denied.isError, true); assert.match(denied._meta['mcp/www_authenticate'][0], /shell:execute/);
  const invalid = await tool('file_read', { workspace: 'project', path: 'a', extraProperty: true }); assert.equal(invalid.isError, true);
});

test('end-to-end MCP file job cannot write before local approval; CAS/idempotency and polling work', async t => {
  const { b, root, tool, admin } = await server(t);
  const args = { workspace: 'project', path: 'nested/hello.txt', text: 'Hello from MCP\n', expectedHash: null, idempotencyKey: 'write-once' };
  const queued = (await tool('file_write', args)).structuredContent;
  assert.equal(queued.status, 'awaiting_approval'); assert.equal(existsSync(path.join(root, args.path)), false);
  const duplicate = (await tool('file_write', args)).structuredContent; assert.equal(duplicate.id, queued.id);
  assert.equal((await tool('file_write', { ...args, text: 'different' })).isError, true);
  const approval = await admin('/api/approve', { jobId: queued.id, allow: true }); assert.equal(approval.status, 200);
  assert.equal((await waitJob(b.jobs, queued.id)).status, 'completed');
  assert.equal(readFileSync(path.join(root, args.path), 'utf8'), args.text);
  const read = (await tool('file_read', { workspace: 'project', path: args.path })).structuredContent;
  assert.match(read.sha256, /^[a-f0-9]{64}$/);
  const polled = (await tool('job_get', { jobId: queued.id })).structuredContent;
  assert.equal(polled.status, 'completed'); assert.equal(polled.request, undefined);
  const foreign = register(b.oauth).tokens().access_token;
  assert.equal((await tool('job_get', { jobId: queued.id }, foreign)).isError, true);
});

test('real default shell execution is approval-gated and emits stdout; stop pauses remote access', async t => {
  const { b, tool, admin, rpc } = await server(t);
  const queued = (await tool('shell_start', { workspace: 'project', command: process.platform === 'win32' ? "Write-Output 'real-shell-ok'" : "printf 'real-shell-ok\\n'", idempotencyKey: 'real-shell' })).structuredContent;
  assert.equal(queued.status, 'awaiting_approval'); await admin('/api/approve', { jobId: queued.id, allow: true });
  const done = await waitJob(b.jobs, queued.id); assert.equal(done.status, 'completed', done.error); assert.match(done.result.stdout, /real-shell-ok/);
  assert.ok(done.events.some(e => e.type === 'shell.stdout'));
  await admin('/api/stop', {}); assert.equal((await rpc('ping')).response.status, 503);
});

test('real ripgrep uses pattern data, not shell code, and returns no-match normally', async t => {
  if (!findExecutable('rg')) { t.skip('ripgrep is not installed on this runner'); return; }
  const { root, tool } = await server(t); writeFileSync(path.join(root, 'sample.txt'), 'needle\n$(touch NEVER)\n');
  const match = (await tool('rg_search', { workspace: 'project', pattern: 'needle' })).structuredContent;
  assert.equal(match.exitCode, 0); assert.match(match.stdout, /sample.txt/);
  const noMatch = (await tool('rg_search', { workspace: 'project', pattern: 'not-present' })).structuredContent; assert.equal(noMatch.exitCode, 1);
  assert.equal(existsSync(path.join(root, 'NEVER')), false);
});

test('MCP image read returns typed bytes; admin activity follows newest events', async t => {
  const { b, root, tool, admin } = await server(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zs1sAAAAASUVORK5CYII=', 'base64');
  writeFileSync(path.join(root, 'one.png'), png);
  const read = await tool('image_read', { workspace: 'project', path: 'one.png' });
  const image = read.content.find(c => c.type === 'image'); assert.equal(image.mimeType, 'image/png'); assert.deepEqual(Buffer.from(image.data, 'base64'), png);
  const j = b.jobs.create({ kind: 'test', title: 'tail test', approval: true }, () => ({}));
  for (let n = 0; n < 230; n++) b.jobs.event(j.id, 'test.log', { n });
  const page = await (await admin('/api/job?id=' + j.id)).json();
  assert.equal(page.events.length, 200); assert.equal(page.events.at(-1).data.n, 229); assert.equal(page.hasMore, false);
});

test('local engine routes and local tool execution are removed', async t => {
  const { admin, tool, b } = await server(t);
  for (const route of ['/api/codex/login', '/api/codex/windows-setup', '/api/tool']) assert.equal((await admin(route, {})).status, 404);
  for (const name of ['codex_start', 'codex_steer', 'codex_catalog', 'codex_session_open', 'codex_session_call']) {
    const result = await tool(name); assert.equal(result.isError, true); assert.match(result.content[0].text, /Unknown tool/);
  }
  assert.equal(Object.hasOwn(b, 'codex'), false);
  const state = await (await admin('/api/state')).json();
  assert.equal(state.folderPicker, false);
  assert.equal(Object.hasOwn(state.settings, 'autoApproveCodex'), false);
});

test('desktop folder picker only runs through the authenticated owner API', async t => {
  const f = fixture(t); let calls = 0;
  const b = await createBridge({ config: f.config, adminPort: 0, publicPort: 0, chooseFolder: async () => { calls++; return f.root; } });
  t.after(async () => { await b.close(); rmSync(f.base, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${b.adminPort}/api/workspaces/choose`;
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401); assert.equal(calls, 0);
  const response = await fetch(url, { method: 'POST', headers: { 'X-Codex-Link-Admin': b.adminToken, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200); assert.equal(calls, 1); assert.equal((await response.json()).root, realpathSync(f.root));
});

test('local owner can enable dangerous mode and persistent computer control', async t => {
  const { b, root, admin, tool } = await server(t);
  const permanentResponse = await admin('/api/computer', { enabled: true, persistent: true });
  assert.equal(permanentResponse.status, 200);
  const permanentState = await permanentResponse.json();
  assert.equal(permanentState.settings.computerAlwaysEnabled, true);
  assert.equal(permanentState.computerEnabledUntil, 0);
  assert.equal(b.computer.enabled(), true);

  const disabledResponse = await admin('/api/computer', { enabled: false });
  assert.equal(disabledResponse.status, 200);
  assert.equal((await disabledResponse.json()).settings.computerAlwaysEnabled, false);

  const dangerousResponse = await admin('/api/dangerous', { enabled: true });
  assert.equal(dangerousResponse.status, 200);
  const dangerousState = await dangerousResponse.json();
  assert.equal(dangerousState.settings.autoApproveWrites, true);
  assert.equal(dangerousState.settings.autoApproveShell, true);
  assert.equal(dangerousState.settings.computerAlwaysEnabled, true);
  assert.equal(b.computer.enabled(), true);

  const args = { workspace: 'project', path: 'danger-mode.txt', text: 'auto-approved\n', expectedHash: null, idempotencyKey: 'danger-write' };
  const write = (await tool('file_write', args)).structuredContent;
  assert.notEqual(write.status, 'awaiting_approval');
  assert.equal((await waitJob(b.jobs, write.id)).status, 'completed');
  assert.equal(readFileSync(path.join(root, args.path), 'utf8'), args.text);

  const offResponse = await admin('/api/dangerous', { enabled: false });
  const offState = await offResponse.json();
  assert.equal(offState.settings.autoApproveWrites, false);
  assert.equal(offState.settings.autoApproveShell, false);
  assert.equal(offState.settings.computerAlwaysEnabled, false);
  assert.equal(b.computer.enabled(), false);
});


test('dangerous mode releases pending requests and overrides individual approval settings', async t => {
  const { b, admin, tool } = await server(t);
  const args = { workspace: 'project', path: 'pending-danger.txt', text: 'approved', expectedHash: null, idempotencyKey: 'pending-danger' };
  const pending = (await tool('file_write', args)).structuredContent;
  assert.equal(pending.status, 'awaiting_approval');
  await admin('/api/dangerous', { enabled: true });
  assert.equal((await waitJob(b.jobs, pending.id)).status, 'completed');
  await admin('/api/settings', { autoApproveWrites: false, autoApproveShell: false });
  const next = (await tool('file_write', { ...args, path: 'next-danger.txt', idempotencyKey: 'next-danger' })).structuredContent;
  assert.notEqual(next.status, 'awaiting_approval');
  assert.equal((await waitJob(b.jobs, next.id)).status, 'completed');
  await admin('/api/dangerous', { enabled: false });
  const gated = (await tool('file_write', { ...args, path: 'gated.txt', idempotencyKey: 'gated' })).structuredContent;
  assert.equal(gated.status, 'awaiting_approval');
});

test('native computer owner routes require local authentication and cannot be used over MCP', async t => {
  const { remote, local, token, admin, b, tool } = await server(t);
  let invoked = false;
  b.computer.native.invoke = async () => { invoked = true; return { protocol: 1 }; };
  for (const route of ['/api/computer/policy', '/api/computer/permissions', '/api/computer/session/end']) {
    assert.equal((await fetch(local + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(remote + route, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  }
  const denied = await tool('computer_permissions', {}); assert.equal(denied.isError, true);
  assert.equal(invoked, false);
  assert.equal((await admin('/api/computer/policy', { rules: [], surprise: true })).status, 400);
  assert.equal((await admin('/api/computer/policy', { rules: [], legacyEnabled: 'true' })).status, 400);
  assert.equal(b.config.value.computerLegacyEnabled, false);
});

test('local native app policy invalidates live sessions without enabling desktop control', async t => {
  const { b, admin } = await server(t);
  assert.equal(b.computer.enabled(), false);
  b.computer.native.sessions.set('fixture-session', { id: 'fixture-session', target: { appId: 'fixture', executable: '/fixture/app' }, expiresAt: Date.now() + 10000 });
  const rule = { appId: 'fixture', executable: '/fixture/app', mode: 'foreground', decision: 'allow' };
  const response = await admin('/api/computer/policy', { rules: [rule] });
  assert.equal(response.status, 200); assert.equal(b.computer.native.sessions.size, 0);
  assert.deepEqual(b.config.value.computerAppRules, [rule]); assert.equal(b.computer.enabled(), false);
  assert.equal(b.config.value.computerLegacyEnabled, false);
  assert.equal((await admin('/api/computer/policy', { rules: [rule, rule] })).status, 400);
});

test('dangerous mode bypasses native application rules and enables legacy access until disabled', async t => {
  const { b, admin } = await server(t);
  assert.equal((await admin('/api/dangerous', { enabled: true })).status, 200);
  b.computer.native = new NativeComputer(b.computer, { platform: 'win32', transport: async () => ({}) });
  const target = { appId: 'fixture.editor', appName: 'Fixture', executable: '/fixture/editor', windowId: '1', pid: 777, processStart: '1234', blocked: false };
  b.computer.native.invoke = async () => ({ protocol: 1, target });
  const prepared = await b.computer.native.prepareStart({ windowId: '1' }, { clientId: 'test', grantId: 'test' });
  assert.equal(prepared.needsApproval, false);
  b.computer.native.setRules([{ appId: target.appId, executable: target.executable, mode: 'foreground', decision: 'block' }]);
  assert.equal((await b.computer.native.prepareStart({ windowId: '1', mode: 'foreground' }, { clientId: 'test', grantId: 'test' })).needsApproval, false);
  assert.equal(b.computer.legacyEnabled(), true);
  assert.equal(b.computer.native.manifest().legacyEnabled, true);
  assert.equal(b.config.value.computerLegacyEnabled, false);
  await admin('/api/dangerous', { enabled: false });
  assert.equal(b.computer.native.decision(target, 'foreground'), 'block');
  assert.equal(b.computer.legacyEnabled(), false);
  await assert.rejects(b.computer.action({ action: 'screenshot' }), /legacy desktop control is disabled/);
});

test('native computer skill is a fixed MCP resource rather than an arbitrary local-file reader', async t => {
  const { rpc } = await server(t);
  const resources = (await rpc('resources/list')).body.result.resources;
  assert.ok(resources.some(r => r.uri === 'codex-link://computer-guide'));
  const result = (await rpc('resources/read', { uri: 'codex-link://computer-guide' })).body.result;
  assert.equal(result.contents[0].mimeType, 'text/markdown');
  assert.match(result.contents[0].text, /computer_session_start/);
  assert.match(result.contents[0].text, /Windows.*foreground/);
  assert.ok((await rpc('resources/read', { uri: 'file:///etc/passwd' })).body.error);
});

test('macOS OS permission prompts are owner-initiated only and never run during diagnostics', { skip: process.platform !== 'darwin' }, async t => {
  const { b, admin, local } = await server(t);
  const calls = [];
  b.computer.native.invoke = async request => { calls.push(request.op); return { protocol: 1, message: 'fixture only' }; };
  assert.equal((await admin('/api/computer/permissions', { surprise: true })).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await fetch(local + '/api/computer/permissions', { method: 'POST', headers: { 'X-Codex-Link-Admin': b.adminToken, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.deepEqual(calls, []);
  assert.equal((await admin('/api/computer/permissions', {})).status, 200);
  assert.deepEqual(calls, ['request_permissions']); // Stubbed: no OS prompt is displayed by this test.
  assert.equal(b.computer.enabled(), false);
});

test('owner updates are authenticated, scoped, cancellable and returned once on tool responses', async t => {
  const { b, admin, local, rpc, tool } = await server(t);
  const grantId = b.oauth.connections()[0].id;
  const post = text => admin('/api/updates', { grantId, text });
  assert.equal((await fetch(local + '/api/updates', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await post(' ')).status, 400);
  assert.equal((await post('x'.repeat(4001))).status, 400);
  assert.equal((await admin('/api/updates', { grantId: 'missing', text: 'private' })).status, 400);
  const cancelled = await (await post('cancel me')).json();
  assert.equal((await admin('/api/updates/cancel', { id: cancelled.id })).status, 200);
  await post('focus on login');
  await rpc('ping'); await rpc('tools/list');
  const otherToken = register(b.oauth).tokens().access_token;
  assert.ok(!(await tool('bridge_status', {}, otherToken)).content.some(c => c.text?.includes('focus on login')));
  const result = await tool('bridge_status');
  assert.match(result.content.at(-1).text, /focus on login/);
  assert.doesNotMatch(result.content.at(-1).text, /cancel me/);
  assert.ok(!(await tool('bridge_status')).content.some(c => c.text?.includes('focus on login')));
  await post('recover from this error');
  const error = await tool('missing_tool');
  assert.equal(error.isError, true); assert.match(error.content.at(-1).text, /recover from this error/);
  await post('wait until resumed');
  await admin('/api/settings', { remotePaused: true });
  assert.equal((await rpc('tools/call', { name: 'bridge_status' })).response.status, 503);
  await admin('/api/settings', { remotePaused: false });
  assert.match((await tool('bridge_status')).content.at(-1).text, /wait until resumed/);
  const state = await (await admin('/api/state')).json();
  assert.equal(state.updates.filter(u => u.status === 'returned').length, 3);
  assert.equal(state.updates.filter(u => u.status === 'cancelled').length, 1);
});

test('dangerous mode cannot accept an upstream runtime consent request', async t => {
  const { b, admin, remote, token } = await server(t);
  const j = b.jobs.create({ kind: 'computer', title: 'Runtime consent', principal: { clientId: 'local-owner' }, approval: false }, c => c.requestApproval({ source: 'Codex Computer Use', message: 'Allow Discord?' }));
  await new Promise(r => setImmediate(r));
  assert.equal(b.jobs.get(j.id).status, 'awaiting_approval');
  await admin('/api/dangerous', { enabled: true });
  assert.equal(b.jobs.get(j.id).status, 'awaiting_approval');
  const denied = await fetch(remote + '/api/approve', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: j.id, allow: true }) });
  assert.equal(denied.status, 404);
  assert.equal(b.jobs.get(j.id).status, 'awaiting_approval');
  await admin('/api/approve', { jobId: j.id, allow: false });
  assert.equal((await waitJob(b.jobs, j.id)).result, false);
});
