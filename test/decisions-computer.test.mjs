import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fixture, waitJob } from './helpers.mjs';
import { DecisionsComputer, installDecisionsComputerTools } from '../src/decisions-computer.mjs';
import { Jobs } from '../src/jobs.mjs';

const principal = { clientId: 'client', grantId: 'grant', scopes: ['computer:use'] };
const args = { sessionId: 'session', task: 'Click the calculator button', idempotencyKey: 'run-1' };
const fields = { action: null, x: null, y: null, toX: null, toY: null, button: null, amount: null, elementId: null, direction: null, pages: null, text: null, keys: null };
const proposal = (status = 'action') => ({ ...fields, status, explanation: 'Observed calculator button', ...(status === 'action' ? { action: 'invoke', elementId: 'button-1' } : {}) });
function setup(t, { choices = ['execute', 'complete'], error, change = false } = {}) {
  const { config } = fixture(t), calls = [], actions = [], events = [];
  let observed = 0, planned = 0;
  const session = { target: { appId: 'calculator', appName: 'Calculator' }, mode: 'foreground' };
  const native = {
    platform: 'win32', assertEnabled() {}, session(id, p) { assert.equal(id, 'session'); assert.equal(p, principal); return session; },
    async observe() { observed++; return { sessionId: 'session', observationId: `observation-${observed}`, tree: change && observed > 1 ? 'new button' : 'button', data: 'eA==', mimeType: 'image/png' }; },
    async interact(action) { actions.push(action); if (error) throw Error(error); }
  };
  const owner = { config, native, controllers: new Set() };
  const api = new DecisionsComputer(owner, { fetchImpl: async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const body = url.endsWith('/responses') ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal(planned++ ? 'complete' : 'action')) }] }] }
      : { answers: [{ name: 'next_step', type: 'choice', choice: choices.shift() || 'handoff', confidence: 0.95 }] };
    return new Response(JSON.stringify(body), { status: 200 });
  } });
  api.configure({ enabled: true, apiKey: 'sk-test-private' });
  const context = { signal: new AbortController().signal, emit: (type, data) => events.push({ type, data }), requestApproval: async () => true };
  return { api, owner, config, calls, actions, events, context };
}

test('settings persist a write-only key separately from public config and support removal', t => {
  const f = setup(t);
  assert.equal(f.api.settings().hasApiKey, true);
  assert.ok(!JSON.stringify(f.api.settings()).includes('sk-test-private'));
  assert.ok(!readFileSync(path.join(f.config.home, 'config.json'), 'utf8').includes('sk-test-private'));
  if (process.platform !== 'win32') assert.equal(statSync(path.join(f.config.home, 'openai-key.json')).mode & 0o777, 0o600);
  assert.equal(new DecisionsComputer(f.owner).settings().hasApiKey, true);
  assert.throws(() => f.api.configure({ maxSteps: 100 }), /maxSteps/);
  assert.throws(() => f.api.configure({ apiKey: 'key\nheader' }), /Invalid API key/);
  f.api.configure({ apiKey: '' }); assert.equal(f.api.settings().hasApiKey, false);
  assert.throws(() => f.api.ready(), /API key/);
});

test('runs use actual Responses and Decisions schemas, review and execute once, then verify completion', async t => {
  const f = setup(t); let approvals = 0;
  f.context.requestApproval = async request => { approvals++; assert.match(request.message, /button-1/); return true; };
  const result = await f.api.run(args, principal, f.context);
  assert.equal(result.outcome, 'completed'); assert.equal(approvals, 1); assert.equal(f.actions.length, 1);
  assert.equal(f.actions[0].observationId, 'observation-2');
  assert.deepEqual(f.calls.map(c => c.url.split('/').at(-1)), ['responses', 'decisions', 'responses', 'decisions']);
  assert.equal(f.calls[0].body.store, false); assert.equal(f.calls[0].body.text.format.strict, true);
  assert.equal(f.calls[1].body.questions[0].type, 'choice'); assert.equal(f.calls[1].body.model, 'gpt-6-luna');
  assert.match(f.calls[1].body.input[0].content[1].image_url, /^data:image\/png;base64,/);
  assert.equal(f.calls[0].options.headers.Authorization, 'Bearer sk-test-private');
  assert.ok(!JSON.stringify(f.events).includes('sk-test-private')); assert.equal(f.owner.controllers.size, 0);
});

test('handoff, refusal, low confidence, denial and screen changes perform no input', async t => {
  for (const variant of ['handoff', 'refusal', 'confidence', 'denial', 'change']) {
    const f = setup(t, { choices: [variant === 'handoff' ? 'handoff' : 'execute'], change: variant === 'change' });
    if (variant === 'denial') f.context.requestApproval = async () => false;
    if (['refusal', 'confidence'].includes(variant)) {
      const original = f.api.fetch;
      f.api.fetch = async (url, options) => url.endsWith('/decisions') ? new Response(JSON.stringify({ answers: [{ name: 'next_step', type: variant === 'refusal' ? 'refusal' : 'choice', choice: 'execute', confidence: 0.2 }] })) : original(url, options);
    }
    if (variant === 'refusal') await assert.rejects(f.api.run(args, principal, f.context), /refused/);
    else await f.api.run({ ...args, maxSteps: 1 }, principal, f.context);
    assert.equal(f.actions.length, 0, variant);
  }
});

test('failed input is never retried and step limits bound replanning', async t => {
  const f = setup(t, { error: 'input outcome uncertain' });
  await assert.rejects(f.api.run(args, principal, f.context), /uncertain/);
  assert.equal(f.actions.length, 1); assert.equal(f.calls.length, 2);
  const g = setup(t, { choices: ['replan', 'replan', 'replan'] });
  const result = await g.api.run({ ...args, maxSteps: 2 }, principal, g.context);
  assert.equal(result.outcome, 'step_limit'); assert.equal(g.calls.length, 4);
});

test('owner stop, key changes and cancellation during review prevent dispatch', async t => {
  for (const variant of ['stop', 'key', 'cancel']) {
    const f = setup(t); const cancel = new AbortController(); f.context.signal = cancel.signal;
    f.context.requestApproval = async () => {
      if (variant === 'stop') for (const controller of f.owner.controllers) controller.abort();
      if (variant === 'key') f.api.configure({ apiKey: '' });
      if (variant === 'cancel') cancel.abort();
      return true;
    };
    await assert.rejects(f.api.run(args, principal, f.context)); assert.equal(f.actions.length, 0);
  }
});

test('upstream HTTP errors do not leak a key or response body', async t => {
  const f = setup(t); f.api.fetch = async () => new Response('sk-test-private secret screenshot', { status: 401 });
  await assert.rejects(f.api.run(args, principal, f.context), e => /HTTP 401/.test(e.message) && !/sk-test-private|screenshot/.test(e.message));
});

test('MCP runs always request local data-transmission approval and retries do not restart', async t => {
  const f = setup(t); const jobs = new Jobs(f.config); t.after(() => jobs.close());
  const definitions = new Map(); const tools = { computer: { ...f.owner, decisions: f.api }, jobs, add(name, description, schema, scopes, readOnly, handler) { definitions.set(name, handler); } };
  f.config.value.dangerousModeEnabled = true;
  installDecisionsComputerTools(tools);
  const handler = definitions.get('computer_api_run');
  const job = handler(args, principal);
  assert.equal(job.status, 'awaiting_approval'); assert.equal(f.calls.length, 0);
  assert.equal(handler(args, principal).id, job.id);
  assert.throws(() => handler({ ...args, task: 'different' }, principal), /different arguments/);
  assert.throws(() => handler(args, { ...principal, grantId: 'other' }), /not accessible/);
  jobs.approve(job.id, false); assert.equal((await waitJob(jobs, job.id)).status, 'denied');
});
