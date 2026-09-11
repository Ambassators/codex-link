import test from 'node:test';
import assert from 'node:assert/strict';
import { Jobs } from '../src/jobs.mjs';
import { fixture, waitJob } from './helpers.mjs';
const principal = { clientId: 'a', scopes: ['files:write'] };
test('writes do not execute before approval; denial does not run them', async t => {
  const { config } = fixture(t), jobs = new Jobs(config); t.after(() => jobs.close()); let runs = 0;
  const j = jobs.create({ kind: 'write', title: 'write', principal, scopes: ['files:write'], approval: true }, async () => { runs++; return { ok: true }; });
  await new Promise(r => setTimeout(r, 20)); assert.equal(runs, 0); jobs.approve(j.id, false); assert.equal(runs, 0); assert.equal(jobs.get(j.id).status, 'denied');
});
test('approval executes once and results are isolated by client and scope', async t => {
  const { config } = fixture(t), jobs = new Jobs(config); t.after(() => jobs.close()); let runs = 0;
  const j = jobs.create({ kind: 'write', title: 'write', principal, scopes: ['files:write'] }, async () => { runs++; return { ok: true }; });
  jobs.approve(j.id, true); assert.throws(() => jobs.approve(j.id, true), /not awaiting/);
  const result = await waitJob(jobs, j.id); assert.equal(runs, 1); assert.equal(result.status, 'completed');
  assert.throws(() => jobs.get(j.id, { clientId: 'b', scopes: principal.scopes }), /not accessible/);
  assert.throws(() => jobs.get(j.id, { clientId: 'a', scopes: [] }), /not accessible/);
});
test('restart marks pending jobs interrupted rather than replaying', async t => {
  const { config } = fixture(t), jobs = new Jobs(config); t.after(() => jobs.close());
  const j = jobs.create({ kind: 'write', title: 'write', principal }, () => { throw Error('must not run'); });
  const restarted = new Jobs(config); t.after(() => restarted.close()); assert.equal(restarted.get(j.id).status, 'interrupted');
});

test('shutdown waits for cooperative cancellation and rejects new jobs', async t => {
  const { config } = fixture(t), jobs = new Jobs(config); t.after(() => jobs.close()); let finished = false;
  const job = jobs.create({ kind: 'work', title: 'work', principal, approval: false }, async ({ signal }) => {
    await new Promise(resolve => signal.addEventListener('abort', () => setTimeout(resolve, 25), { once: true }));
    finished = true; return { done: true };
  });
  while (jobs.get(job.id).status !== 'running') await new Promise(resolve => setTimeout(resolve, 5));
  await jobs.close(); assert.equal(finished, true); assert.equal(jobs.get(job.id).status, 'cancelled');
  assert.equal(jobs.controllers.size, 0);
  assert.throws(() => jobs.create({ kind: 'work', title: 'late', principal }, async () => {}), /shutting down/);
});
