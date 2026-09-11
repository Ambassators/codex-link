import { randomBytes, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './process.mjs';
import { assert } from './util.mjs';

const ROOT = fileURLToPath(new URL('../computer/', import.meta.url));
const SESSION_MS = 15 * 60 * 1000;
const OBSERVATION_MS = 30 * 1000;
const TOKEN = () => randomBytes(24).toString('base64url');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MODES = ['background', 'foreground'];
export const applicationKey = target => digest([target.appId, target.executable]);
export const sameTarget = (a, b) => !!a && !!b && ['appId', 'executable', 'pid', 'processStart', 'windowId'].every(k => a[k] === b[k]);
const ownerKey = principal => `${principal.clientId}:${principal.grantId || ''}`;
const text = (value, name, max = 4096) => {
  assert(typeof value === 'string' && value.length > 0 && value.length <= max, `Invalid ${name}`);
  return value;
};
const integer = (value, name, min, max) => {
  assert(Number.isInteger(value) && value >= min && value <= max, `Invalid ${name}`);
  return value;
};

export function validateInteraction(a) {
  const common = ['sessionId', 'observationId', 'action', 'idempotencyKey'];
  const variants = {
    move: ['x', 'y'], click: ['x', 'y', 'button'], double_click: ['x', 'y', 'button'],
    drag: ['x', 'y', 'toX', 'toY', 'button'], scroll: ['x', 'y', 'amount', 'horizontal'],
    type: ['text'], key: ['keys'], invoke: ['elementId'], set_value: ['elementId', 'text'],
    select: ['elementId'], toggle: ['elementId'], expand: ['elementId'], collapse: ['elementId'],
    focus: []
  };
  assert(Object.hasOwn(variants, a.action), 'Unknown computer action');
  for (const key of Object.keys(a)) assert([...common, ...variants[a.action]].includes(key), `Unexpected ${key} for ${a.action}`);
  for (const key of ['sessionId', 'observationId']) text(a[key], key, 128);
  if (['move', 'click', 'double_click', 'drag', 'scroll'].includes(a.action)) {
    integer(a.x, 'x', 0, 32767); integer(a.y, 'y', 0, 32767);
  }
  if (a.action === 'drag') { integer(a.toX, 'toX', 0, 32767); integer(a.toY, 'toY', 0, 32767); }
  if (a.button !== undefined) assert(['left', 'right', 'middle'].includes(a.button), 'Invalid mouse button');
  if (a.action === 'scroll') {
    integer(a.amount, 'amount', -30, 30);
    if (a.horizontal !== undefined) assert(typeof a.horizontal === 'boolean', 'horizontal must be boolean');
  }
  if (['type', 'set_value'].includes(a.action)) {
    assert(typeof a.text === 'string' && a.text.length <= 20000 && !a.text.includes('\0'), 'Text must be at most 20000 characters without NUL');
  }
  if (a.action === 'key') {
    assert(Array.isArray(a.keys) && a.keys.length > 0 && a.keys.length <= 5, 'Provide one to five keys');
    a.keys.forEach(k => text(k, 'key', 32));
    assert(new Set(a.keys.map(k => k.toLowerCase())).size === a.keys.length, 'Duplicate keys are not allowed');
  }
  if (['invoke', 'set_value', 'select', 'toggle', 'expand', 'collapse'].includes(a.action)) text(a.elementId, 'elementId', 128);
  return a;
}

export function imagePoint(frame, x, y) {
  assert(frame && [frame.x, frame.y, frame.width, frame.height, frame.imageWidth, frame.imageHeight].every(Number.isFinite), 'Observation has no usable image geometry');
  assert(frame.width > 0 && frame.height > 0 && frame.imageWidth > 0 && frame.imageHeight > 0, 'Invalid image geometry');
  assert(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < frame.imageWidth && y < frame.imageHeight, 'Coordinates are outside this observation');
  return { x: frame.x + x * frame.width / frame.imageWidth, y: frame.y + y * frame.height / frame.imageHeight };
}

/** A bounded, client-bound native desktop runtime. Native helpers have no listeners. */
export class NativeComputer {
  constructor(owner, { platform = process.platform, arch = process.arch, transport = null, now = Date.now } = {}) {
    this.owner = owner;
    this.config = owner.config;
    this.platform = platform;
    this.arch = arch;
    this.transport = transport;
    this.now = now;
    this.sessions = new Map();
    this.queues = new Map();
    this.controllers = new Map();
    this.generation = 0;
  }
  executable() {
    const name = `codex-link-computer${this.platform === 'win32' ? '.exe' : ''}`;
    return path.join(ROOT, 'bin', `${this.platform}-${this.arch}`, name);
  }
  manifest() {
    return {
      protocol: 1, platform: this.platform, architecture: this.arch,
      backend: this.platform === 'darwin' ? 'macOS ScreenCaptureKit + Accessibility + Quartz' : this.platform === 'win32' ? 'Windows UI Automation + Win32' : 'unsupported',
      installed: !!this.transport || existsSync(this.executable()),
      enabled: this.owner.enabled(),
      defaultMode: this.platform === 'darwin' ? 'background' : 'foreground',
      sessionSeconds: SESSION_MS / 1000, observationSeconds: OBSERVATION_MS / 1000,
      lockedUse: false, independentSystemCursor: false,
      legacyEnabled: this.config.value.computerLegacyEnabled === true
    };
  }
  assertEnabled() {
    assert(this.owner.enabled() && !this.config.value.remotePaused, 'Enable computer control in the local panel first', 403);
  }
  permissionDeadline() {
    return this.config.value.computerAlwaysEnabled ? Infinity : this.config.value.computerEnabledUntil || 0;
  }
  stop() {
    this.generation++;
    for (const controller of this.controllers.keys()) controller.abort();
    this.sessions.clear();
  }
  rules() { return this.config.value.computerAppRules || []; }
  decision(target, mode) {
    const rules = this.rules().filter(r => r.appId === target.appId && r.executable === target.executable);
    if (rules.some(r => r.decision === 'block')) return 'block';
    return rules.some(r => r.mode === mode && r.decision === 'allow') ? 'allow' : 'ask';
  }
  setRules(rules) {
    assert(Array.isArray(rules) && rules.length <= 100, 'Provide at most 100 application rules');
    const clean = [], seen = new Set();
    for (const rule of rules) {
      assert(rule && typeof rule === 'object' && !Array.isArray(rule), 'Invalid application rule');
      assert(Object.keys(rule).every(k => ['appId', 'executable', 'mode', 'decision'].includes(k)), 'Unknown application rule field');
      const r = { appId: text(rule.appId, 'appId', 512), executable: text(rule.executable, 'executable'), mode: rule.mode, decision: rule.decision };
      assert(MODES.includes(r.mode) && ['allow', 'block'].includes(r.decision), 'Invalid application permission');
      const key = digest([r.appId, r.executable, r.mode]);
      assert(!seen.has(key), 'Duplicate application rule'); seen.add(key); clean.push(r);
    }
    this.stop();
    this.config.value.computerAppRules = clean;
    this.config.save();
    return clean;
  }
  summary() {
    this.prune();
    return { ...this.manifest(), rules: this.rules(), sessions: [...this.sessions.values()].map(s => ({ id: s.id, appId: s.target.appId, appName: s.target.appName, windowId: s.target.windowId, mode: s.mode, expiresAt: s.expiresAt })) };
  }
  prune() {
    for (const [id, s] of this.sessions) if (s.expiresAt <= this.now()) this.closeInternal(id);
  }
  session(id, principal) {
    this.assertEnabled(); this.prune();
    const s = this.sessions.get(id);
    assert(s && s.owner === ownerKey(principal), 'Computer session is expired or belongs to another connection', 403);
    assert(this.decision(s.target, s.mode) !== 'block', 'Application access is blocked locally', 403);
    return s;
  }
  closeInternal(id) {
    this.sessions.delete(id);
    for (const [controller, sessionId] of this.controllers) if (sessionId === id) controller.abort();
  }
  end(id, principal) {
    const s = this.sessions.get(id);
    assert(!s || s.owner === ownerKey(principal), 'Computer session belongs to another connection', 403);
    this.closeInternal(id);
    return { closed: true, sessionId: id };
  }
  async invoke(request, context = {}, { session = null, gated = true, timeoutMs = 20000 } = {}) {
    const envelope = { protocol: 1, ...request, ownerPids: [process.pid, process.ppid] };
    const input = JSON.stringify(envelope);
    assert(Buffer.byteLength(input) <= 128 * 1024, 'Native request exceeds 128 KiB');
    if (gated) this.assertEnabled();
    assert(['darwin', 'win32'].includes(this.platform), 'Native computer use supports macOS and Windows only');
    assert(this.transport || existsSync(this.executable()), 'Native helper is not built. Run node scripts/build-computer.mjs locally, then restart Codex Link.');
    const controller = new AbortController();
    this.controllers.set(controller, session?.id || null);
    const abort = () => controller.abort();
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) abort();
    const generation = this.generation;
    const deadline = Math.min(this.now() + timeoutMs, session?.expiresAt ?? Infinity, gated ? this.permissionDeadline() : Infinity);
    const remaining = Math.max(1, deadline - this.now());
    const timer = setTimeout(abort, remaining); timer.unref?.();
    try {
      assert(!controller.signal.aborted, 'Computer operation cancelled');
      let data;
      if (this.transport) data = await this.transport(envelope, { signal: controller.signal });
      else {
        const result = await runProcess({ file: this.executable(), args: [] }, [], { input, signal: controller.signal, timeoutMs: remaining, maxOutput: 8 * 1024 * 1024 });
        try { data = JSON.parse(result.stdout); } catch { throw new Error('Native helper returned invalid JSON; inspect local diagnostics'); }
        assert(result.exitCode === 0 || data?.error, 'Native helper failed');
      }
      assert(!controller.signal.aborted && generation === this.generation, 'Computer operation cancelled or permission expired', 403);
      if (gated) this.assertEnabled();
      if (data?.error) {
        const error = new Error(typeof data.error === 'string' ? data.error : data.error.message || 'Native computer operation failed');
        error.code = data.error.code || 'native_error'; throw error;
      }
      assert(data && typeof data === 'object' && data.protocol === 1, 'Native helper protocol mismatch');
      return data;
    } finally {
      clearTimeout(timer); this.controllers.delete(controller);
      context.signal?.removeEventListener('abort', abort);
    }
  }
  async capabilities() {
    const base = this.manifest();
    if (!base.installed || !['darwin', 'win32'].includes(this.platform)) return base;
    try { return { ...base, native: await this.invoke({ op: 'status' }, {}, { gated: false, timeoutMs: 5000 }) }; }
    catch (error) { return { ...base, diagnosticError: error.message }; }
  }
  async windows(principal) {
    this.prune();
    const { windows = [] } = await this.invoke({ op: 'windows' });
    assert(Array.isArray(windows) && windows.length <= 256, 'Invalid native window list');
    return { windows: windows.map(w => {
      const allowed = [...this.sessions.values()].some(s => s.owner === ownerKey(principal) && sameTarget(s.target, w));
      const { title, ...metadata } = w;
      return { ...metadata, ...(allowed ? { title } : {}), titleRedacted: !allowed,
        permissions: Object.fromEntries(MODES.map(mode => [mode, this.decision(w, mode)])) };
    }) };
  }
  async prepareStart(args, principal) {
    this.assertEnabled(); this.prune();
    assert(this.sessions.size < 8, 'Too many computer sessions; close an existing session');
    const generation = this.generation;
    const { target } = await this.invoke({ op: 'describe', windowId: text(args.windowId, 'windowId', 128) });
    this.validateTarget(target);
    const mode = args.mode || (this.platform === 'darwin' ? 'background' : 'foreground');
    assert(MODES.includes(mode), 'Invalid input mode');
    assert(this.decision(target, mode) !== 'block', 'Application access is blocked locally', 403);
    return { target, mode, generation, owner: ownerKey(principal), needsApproval: this.decision(target, mode) !== 'allow' };
  }
  validateTarget(target) {
    assert(target && typeof target === 'object', 'Native helper returned no target');
    for (const key of ['appId', 'executable', 'windowId', 'processStart']) text(target[key], key);
    integer(target.pid, 'pid', 1, 2147483647);
    assert(!target.blocked, target.blockReason || 'This application cannot be automated', 403);
  }
  async start(prepared, principal, context = {}) {
    this.assertEnabled(); this.prune();
    assert(prepared.owner === ownerKey(principal) && prepared.generation === this.generation, 'Session request was revoked', 403);
    assert(this.sessions.size < 8 && this.decision(prepared.target, prepared.mode) !== 'block', 'Session unavailable or app blocked', 403);
    const { target } = await this.invoke({ op: 'describe', windowId: prepared.target.windowId }, context);
    this.validateTarget(target);
    assert(sameTarget(target, prepared.target), 'Window or application changed while approval was pending; request a new session', 409);
    assert(this.sessions.size < 8 && prepared.generation === this.generation, 'Session limit reached or request revoked', 409);
    const id = TOKEN(), expiresAt = Math.min(this.now() + SESSION_MS, this.permissionDeadline());
    const session = { id, target, owner: ownerKey(principal), mode: prepared.mode, expiresAt, observation: null };
    this.sessions.set(id, session);
    return { sessionId: id, target, mode: session.mode, expiresAt, observationRequired: true,
      warning: session.mode === 'foreground' ? 'This session can take over the system pointer and keyboard. Stay off the target desktop while an action runs.' : 'Background actions depend on app support. No automatic foreground fallback or private cursor is provided.' };
  }
  queue(session, principal, fn) {
    const generation = this.generation;
    // Foreground work uses the legacy driver's global queue too. Background work is serialized per process.
    const key = `${session.target.pid}:${session.target.processStart}`;
    const applicationTail = this.queues.get(key) || Promise.resolve();
    const previous = session.mode === 'foreground' ? Promise.allSettled([this.owner.tail, applicationTail]) : applicationTail;
    const pending = previous.catch(() => {}).then(async () => {
      assert(generation === this.generation && this.session(session.id, principal) === session, 'Computer operation cancelled', 403);
      return fn();
    });
    if (session.mode === 'foreground') this.owner.tail = pending;
    this.queues.set(key, pending);
    pending.finally(() => { if (this.queues.get(key) === pending) this.queues.delete(key); }).catch(() => {});
    return pending;
  }
  async observe(args, principal, context = {}) {
    const s = this.session(args.sessionId, principal);
    return this.queue(s, principal, async () => {
      const started = this.now();
      const result = await this.invoke({ op: 'observe', target: s.target, mode: s.mode,
        includeImage: args.includeImage !== false, includeTree: args.includeTree !== false,
        maxNodes: args.maxNodes ?? 250, maxDepth: args.maxDepth ?? 8, maxImageSide: args.maxImageSide ?? 1800 }, context, { session: s });
      assert(sameTarget(result.target, s.target), 'Target changed during observation', 409);
      assert(Array.isArray(result.elements) && result.elements.length <= 500, 'Invalid accessibility response');
      const elements = new Map();
      for (const element of result.elements) {
        assert(typeof element.id === 'string' && typeof element.fingerprint === 'string' && Array.isArray(element.path), 'Invalid accessibility element');
        assert(!elements.has(element.id), 'Duplicate accessibility element'); elements.set(element.id, element);
      }
      const observationId = TOKEN();
      s.observation = { id: observationId, createdAt: started, frame: result.frame, target: result.target, elements };
      const imageGeometry = result.frame?.imageWidth > 0 && result.frame?.imageHeight > 0;
      const visibleElements = result.elements.map(({ path, fingerprint, bounds, ...element }) => {
        if (!bounds || !imageGeometry) return { ...element, bounds, boundsCoordinateSpace: 'native-desktop' };
        const f = result.frame;
        return { ...element, bounds: { x: (bounds.x - f.x) * f.imageWidth / f.width, y: (bounds.y - f.y) * f.imageHeight / f.height,
          width: bounds.width * f.imageWidth / f.width, height: bounds.height * f.imageHeight / f.height }, boundsCoordinateSpace: 'observation-image-pixels' };
      });
      return { ...result, elements: visibleElements, sessionId: s.id, observationId, expiresAt: Math.min(started + OBSERVATION_MS, s.expiresAt),
        coordinateSpace: imageGeometry ? 'observation-image-pixels' : 'native-desktop', contentIsUntrusted: true };
    });
  }
  async interact(args, principal, context = {}) {
    validateInteraction(args);
    const s = this.session(args.sessionId, principal);
    return this.queue(s, principal, async () => {
      const observation = s.observation;
      assert(observation && observation.id === args.observationId && this.now() - observation.createdAt < OBSERVATION_MS, 'Observation is stale or already used; call computer_observe again', 409);
      const { sessionId, observationId, idempotencyKey, elementId, ...action } = args;
      if (args.x !== undefined) Object.assign(action, imagePoint(observation.frame, args.x, args.y));
      if (args.toX !== undefined) {
        const point = imagePoint(observation.frame, args.toX, args.toY); action.toX = point.x; action.toY = point.y;
      }
      if (elementId) {
        const element = observation.elements.get(elementId);
        assert(element && !element.protected, 'Element is missing or protected; observe again');
        action.element = { path: element.path, fingerprint: element.fingerprint };
      }
      if (s.mode === 'background') {
        assert(!['focus', 'drag'].includes(args.action), 'This action requires an explicitly approved foreground session');
        if (this.platform === 'win32') assert(['invoke', 'set_value', 'select', 'toggle', 'expand', 'collapse'].includes(args.action), 'Windows background mode supports UI Automation actions only; request foreground mode for pointer/keyboard input');
      }
      // Consume observations before dispatch, including on errors. Never replay an uncertain UI side effect.
      for (const other of this.sessions.values()) if (other.target.pid === s.target.pid) other.observation = null;
      const result = await this.invoke({ op: 'interact', target: observation.target, frame: observation.frame, mode: s.mode, ...action }, context, { session: s });
      if (s.mode === 'background' && result.foregroundChanged) {
        this.closeInternal(s.id);
        return { ...result, sessionId: s.id, sessionClosed: true, needsObservation: true, warning: 'The application changed foreground focus during background input. This session was closed; no focus restoration or replay was attempted.' };
      }
      return { ...result, sessionId: s.id, needsObservation: true };
    });
  }
}
