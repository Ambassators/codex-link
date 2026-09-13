import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { Tailscale } from '../src/tailscale.mjs';
function setup(t, state = {}) {
  const f = fixture(t), file = path.join(f.base, 'tailscale-fixture.json'); writeFileSync(file, JSON.stringify(state));
  f.config.value.tailscaleCommand = { file: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-tailscale.mjs', import.meta.url)), file] };
  return { ...f, ts: new Tailscale(f.config), saved: () => JSON.parse(readFileSync(file, 'utf8')), context: { emit() {} } };
}
test('Tailscale adapter logs in and forwards only the public listener', async t => {
  const { ts, config, context, saved } = setup(t);
  const result = await ts.enable(context); assert.equal(result.mcpUrl, 'https://fixture.tail-test.ts.net/mcp');
  assert.ok(saved().calls.some(a => a[0] === 'up'));
  const run = saved().calls.find(a => a.includes('--bg'));
  assert.deepEqual(run, ['funnel', '--bg', '--https=443', 'http://127.0.0.1:43121']);
  assert.equal(config.value.funnelManaged, true); await ts.disable(); assert.equal(config.value.funnelManaged, false);
  assert.equal(saved().calls.some(a => a.includes('reset')), false);
});
test('Tailscale adapter refuses to overwrite an existing listener', async t => {
  const { ts, context, saved } = setup(t, { connected: true, serve: { TCP: { 443: { HTTPS: true } } } });
  await assert.rejects(ts.enable(context), /already has a listener/);
  assert.equal(saved().calls.some(a => a.includes('--bg')), false);
});
test('failed Tailscale publication restores the prior OAuth issuer', async t => {
  const { ts, config, context } = setup(t, { connected: true, fail: true }); const before = config.value.publicOrigin;
  await assert.rejects(ts.enable(context), /policy denied/); assert.equal(config.value.publicOrigin, before); assert.equal(config.value.funnelManaged, false);
});
test('macOS desktop commands force CLI mode without shell environment', { skip: process.platform !== 'darwin' }, async t => {
  const { ts, config, context, saved } = setup(t, { requireCli: true });
  const env = { TERM: undefined, TERM_PROGRAM: undefined, SHLVL: undefined, PS1: undefined, TAILSCALE_BE_CLI: '0', ELECTRON_RUN_AS_NODE: '1' };
  config.value.tailscaleCommand.env = env;
  assert.equal((await ts.status()).state, 'NeedsLogin');
  await ts.enable(context); await ts.disable();
  assert.ok(saved().calls.some(args => args[0] === 'up'));
  assert.equal(config.value.tailscaleCommand.env, env);
  assert.equal(env.TAILSCALE_BE_CLI, '0');
});
test('a failed status check reports the installed service error without attempting login', async t => {
  const { ts, context, saved } = setup(t, { statusError: 'Cannot connect to the Tailscale service' });
  const status = await ts.status();
  assert.equal(status.installed, true); assert.equal(status.connected, false);
  await assert.rejects(ts.enable(context), /Cannot connect to the Tailscale service/);
  assert.ok(saved().calls.every(args => args[0] === 'status'));
});
test('GUI output is reported as an invalid status without starting a stalled login', async t => {
  const { ts, context, saved } = setup(t, { invalidStatus: true });
  assert.equal((await ts.status()).installed, true);
  await assert.rejects(ts.enable(context), /did not return its connection status/);
  assert.ok(saved().calls.every(args => args[0] === 'status'));
});

test('an already enabled managed Funnel is left running', async t => {
  const host = 'fixture.tail-test.ts.net:443';
  const { ts, config, context, saved } = setup(t, { connected: true, serve: {
    TCP: { 443: { HTTPS: true } }, Web: { [host]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:43121' } } } }, AllowFunnel: { [host]: true }
  } });
  config.value.funnelManaged = true;
  await ts.enable(context);
  assert.equal(saved().calls.some(args => args.includes('--bg') || args[0] === 'up'), false);
});

test('startup enables a disabled connection after binding the public port', async t => {
  const { createBridge } = await import('../src/server.mjs');
  const { waitJob } = await import('./helpers.mjs');
  const { config, saved } = setup(t);
  config.value.publicOrigin = '';
  const bridge = await createBridge({ config, adminPort: 0, publicPort: 0, autoEnableConnection: true });
  try {
    const job = bridge.jobs.list().find(j => j.kind === 'setup');
    assert.ok(job);
    assert.equal((await waitJob(bridge.jobs, job.id)).status, 'completed');
    assert.ok(saved().calls.some(args => args.includes(`http://127.0.0.1:${bridge.publicPort}`)));
    assert.equal(bridge.state().settings.funnelManaged, true);
  } finally { await bridge.close(); }
});

test('startup preserves a custom public origin without invoking Tailscale', async t => {
  const { createBridge } = await import('../src/server.mjs');
  const { config, saved } = setup(t);
  const bridge = await createBridge({ config, adminPort: 0, publicPort: 0, autoEnableConnection: true });
  try { assert.equal(bridge.jobs.list().length, 0); assert.equal(saved().calls, undefined); }
  finally { await bridge.close(); }
});
