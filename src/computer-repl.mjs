import { randomBytes } from 'node:crypto';
import { CodexAppServerClient } from './codex-app-server-client.mjs';
import { assert } from './util.mjs';

const ownerKey = p => `${p.clientId}:${p.grantId || ''}`;
const IDLE_MS = 15 * 60 * 1000;

/** One unmodified Codex CUA REPL per OAuth grant. No model turns are started. */
export class ComputerRepl {
  constructor(owner, { clientFactory = () => new CodexAppServerClient(), now = Date.now } = {}) {
    this.owner = owner; this.clientFactory = clientFactory; this.now = now;
    this.sessions = new Map(); this.queues = new Map(); this.generation = 0;
  }
  assertEnabled() {
    this.owner.native.assertEnabled();
    assert(this.owner.native.relay, 'The Codex Computer Use REPL requires the macOS app-server backend');
    // Arbitrary JavaScript cannot be reliably checked against local app rules.
    // Never silently let the REPL bypass an explicit local app block.
    assert(!this.owner.native.rules().some(r => r.decision === 'block'), 'Computer Use JavaScript is unavailable while local app blocks exist. The local owner must review app blocks before JavaScript input can be enabled.');
  }
  session(principal) {
    const key = ownerKey(principal), s = this.sessions.get(key);
    if (s && (s.client.closed || s.expiresAt <= this.now())) { this.closeInternal(s.id); return null; }
    return s;
  }
  needsApproval(principal) { return !this.session(principal) && !this.owner.config.value.autoApproveShell; }
  touch(s) {
    clearTimeout(s.timer);
    s.expiresAt = Math.min(this.now() + IDLE_MS, this.owner.native.permissionDeadline());
    s.timer = setTimeout(() => this.closeInternal(s.id), Math.max(1, s.expiresAt - this.now())); s.timer.unref?.();
  }
  summary() {
    return [...this.sessions.values()].map(s => ({ id: s.id, appName: 'Codex Computer Use JavaScript', mode: 'Codex app/browser permissions', expiresAt: s.expiresAt }));
  }
  closeInternal(id) {
    for (const [key, s] of this.sessions) if (s.id === id) { clearTimeout(s.timer); s.client.close(); this.sessions.delete(key); }
  }
  stop() {
    this.generation++;
    for (const s of [...this.sessions.values()]) this.closeInternal(s.id);
  }
  async execute(tool, args, principal, context = {}) {
    this.assertEnabled();
    const key = ownerKey(principal), generation = this.generation;
    const pending = (this.queues.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      this.assertEnabled(); assert(generation === this.generation && !context.signal?.aborted, 'Computer Use execution was cancelled');
      let s = this.session(principal);
      if (!s) {
        assert(this.sessions.size < 8, 'Too many Computer Use JavaScript sessions', 429);
        s = { id: randomBytes(24).toString('base64url'), client: this.clientFactory(), initialized: false };
        this.sessions.set(key, s);
      }
      this.touch(s);
      const timeoutMs = Math.max(1, Math.min((args.timeout_ms || 30000) + 5000, s.expiresAt - this.now()));
      const callContext = { ...context, timeoutMs };
      try {
        if (!s.initialized) { await s.client.initialize(callContext); s.initialized = true; }
        this.assertEnabled(); assert(generation === this.generation && !context.signal?.aborted, 'Computer Use execution was cancelled');
        const result = await s.client.replCall(tool, args, callContext);
        this.assertEnabled(); this.touch(s);
        return result;
      } catch (error) {
        // Transport/consent failures discard uncertain runtime state. JS errors
        // remain normal upstream tool results so the model can correct them.
        this.closeInternal(s.id); throw error;
      }
    });
    this.queues.set(key, pending);
    pending.finally(() => { if (this.queues.get(key) === pending) this.queues.delete(key); }).catch(() => {});
    return pending;
  }
}
