import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Store, id, assert, safeError } from './util.mjs';

export class Jobs extends EventEmitter {
  constructor(config) {
    super(); this.config = config; this.work = new Map(); this.controllers = new Map(); this.extra = new Map(); this.saving = null; this.closing = false; this.closed = false;
    this.store = new Store(path.join(config.home, 'jobs.json'), { jobs: [] });
    for (const job of this.store.data.jobs) if (['queued', 'running', 'awaiting_approval'].includes(job.status)) { job.status = 'interrupted'; job.error = 'Bridge restarted. Review partial changes before resubmitting; jobs are never replayed automatically.'; }
    this.store.save();
  }
  saveSoon() {
    if (this.closed) return;
    if (!this.saving) this.saving = setTimeout(() => { this.saving = null; this.store.save(); }, 150).unref();
    this.emit('change');
  }
  list(principal = null) {
    return this.store.data.jobs.filter(j => !principal || (j.clientId === principal.clientId && j.scopes.every(s => principal.scopes.includes(s)))).map(({ events, ...j }) => ({ ...j, eventCount: events.length })).reverse();
  }
  get(jobId, principal = null) {
    const j = this.store.data.jobs.find(j => j.id === jobId); assert(j, 'Unknown job', 404);
    assert(!principal || (j.clientId === principal.clientId && j.scopes.every(s => principal.scopes.includes(s))), 'Job is not accessible to this OAuth connection and scope', 403); return j;
  }
  view(jobId, principal = null, after = 0, limit = 100) {
    const j = this.get(jobId, principal), events = j.events.filter(e => e.seq > after).slice(0, Math.min(limit, 200));
    const { events: _, ...summary } = j;
    return { ...summary, events, nextCursor: events.at(-1)?.seq || after, oldestCursor: j.events[0]?.seq || 0, hasMore: j.events.some(e => e.seq > (events.at(-1)?.seq || after)) };
  }
  event(jobId, type, data) {
    if (this.closed) return;
    const j = this.get(jobId); let payload = data;
    const text = JSON.stringify(data);
    if (text && Buffer.byteLength(text) > 32768) payload = { truncated: true, preview: text.slice(0, 32000) };
    j.seq += 1; j.events.push({ seq: j.seq, at: Date.now(), type, data: payload });
    while (j.events.length > 1000 || Buffer.byteLength(JSON.stringify(j.events)) > 1024 * 1024) j.events.shift();
    j.updatedAt = Date.now(); this.saveSoon();
  }
  create({ kind, title, principal, scopes = [], approval = true, key = null, request = null }, runner) {
    assert(!this.closing && !this.closed, 'Bridge is shutting down', 503);
    const clientId = principal?.clientId || 'local-owner';
    if (key) {
      const existing = this.store.data.jobs.find(j => j.clientId === clientId && j.idempotencyKey === key);
      if (existing) { assert(existing.kind === kind && existing.title === title, 'Idempotency key already used for a different operation', 409); return this.view(existing.id, principal); }
    }
    assert(this.store.data.jobs.filter(j => ['queued', 'running', 'awaiting_approval'].includes(j.status)).length < 16, 'Too many active jobs', 429);
    const j = { id: id(18), kind, title, clientId, scopes, idempotencyKey: key, request, status: approval ? 'awaiting_approval' : 'queued', createdAt: Date.now(), updatedAt: Date.now(), events: [], seq: 0 };
    this.store.data.jobs.push(j); this.work.set(j.id, runner);
    // Retain recent jobs without evicting live ones.
    while (this.store.data.jobs.length > 200) { const i = this.store.data.jobs.findIndex(v => !['queued', 'running', 'awaiting_approval'].includes(v.status)); if (i < 0) break; this.store.data.jobs.splice(i, 1); }
    this.event(j.id, 'job.created', { kind, approval }); this.store.save();
    if (!approval) setImmediate(() => this.run(j.id));
    return this.view(j.id, principal);
  }
  async run(jobId) {
    if (this.closing || this.closed) return;
    const j = this.get(jobId), runner = this.work.get(jobId);
    if (!runner || !['queued', 'awaiting_approval'].includes(j.status)) return;
    this.work.delete(jobId); const controller = new AbortController(); this.controllers.set(jobId, controller);
    j.status = 'running'; this.event(jobId, 'job.started', {});
    try {
      const result = await runner({ jobId, signal: controller.signal, emit: (type, data) => this.event(jobId, type, data), setControl: control => this.extra.set(jobId, control) });
      if (j.status !== 'cancelled') { j.status = 'completed'; j.result = result; }
    } catch (e) { if (j.status !== 'cancelled') { j.status = 'failed'; j.error = safeError(e); } }
    finally {
      this.controllers.delete(jobId); this.extra.delete(jobId); this.event(jobId, 'job.finished', { status: j.status }); if (!this.closed) this.store.save();
    }
  }
  approve(jobId, allow) {
    const j = this.get(jobId); assert(j.status === 'awaiting_approval', 'Job is not awaiting approval');
    if (allow) { j.status = 'queued'; setImmediate(() => this.run(jobId)); }
    else { this.work.delete(jobId); j.status = 'denied'; this.event(jobId, 'job.denied', {}); }
    this.store.save(); return this.view(jobId);
  }
  cancel(jobId, principal = null) {
    const j = this.get(jobId, principal);
    if (['running', 'queued', 'awaiting_approval'].includes(j.status)) {
      j.status = 'cancelled'; this.work.delete(jobId); this.controllers.get(jobId)?.abort(new Error('Cancelled by owner'));
      this.event(jobId, 'job.cancelled', {}); this.store.save();
    }
    return this.view(jobId, principal);
  }
  stopAll() { for (const j of [...this.store.data.jobs]) this.cancel(j.id); }
  async close() {
    if (this.closed) return;
    this.closing = true; this.stopAll();
    // Give tracked runners time to observe cancellation before releasing the instance lock.
    // An uncooperative custom runner cannot persist stale state after the final flush.
    const deadline = Date.now() + 3000;
    while (this.controllers.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    this.closed = true;
    if (this.saving) { clearTimeout(this.saving); this.saving = null; }
    this.store.save();
  }
}
