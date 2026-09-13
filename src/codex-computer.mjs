import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeComputer, validateInteraction } from './native-computer.mjs';
import { CodexAppServerClient, codexAppServerInstalled } from './codex-app-server-client.mjs';
import { assert } from './util.mjs';
const token = () => randomBytes(24).toString('base64url');
const ownerKey = p => `${p.clientId}:${p.grantId || ''}`;
const textContent = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

export function parseCodexApps(result) {
  if (Array.isArray(result.structuredContent?.apps)) return result.structuredContent.apps.filter(a => typeof a.id === 'string' && a.id).map(a => ({ appName: a.displayName || a.id, appId: a.id, executable: a.id, windowId: a.id, running: !!a.isRunning, targetKind: 'app-key-window' }));
  return textContent(result).split('\n').flatMap(line => {
    const match = line.match(/^(.+?) — (\/.*?) — ([\w.-]+)(?: \[([^\]]*)\])?\s*$/);
    if (!match) return [];
    const [, appName, executable, appId, flags = ''] = match;
    return [{ appName, executable, appId, windowId: appId, running: flags.split(',').map(f => f.trim()).includes('running'), targetKind: 'app-key-window' }];
  });
}

/** macOS adapter for the installed Codex runtime, with no custom click fallback. */
export class CodexComputer extends NativeComputer {
  constructor(owner, { clientFactory = () => new CodexAppServerClient(), now = Date.now, settleMs = 1000 } = {}) {
    super(owner, { platform: 'darwin', now });
    this.clientFactory = clientFactory; this.clients = new Set(); this.relay = true; this.settleMs = settleMs;
  }
  manifest() {
    return { ...super.manifest(), backend: 'Codex Computer Use via app-server', relay: true,
      installed: codexAppServerInstalled(), legacyEnabled: false, targetKind: 'app-key-window',
      inputModes: ['background'], javascriptTools: ['computer_js', 'computer_js_reset', 'computer_js_result'], permissionAuthority: 'Codex Computer Use; runtime consent is never bypassed',
      limitations: ['Targets the app key window, not a pinned native window.', 'Codex controls input delivery and focus.', 'Requires the signed-in Codex desktop app and its enabled Computer Use plugin.', 'The app-server integration is experimental.'] };
  }
  capabilities() { return Promise.resolve(this.manifest()); }
  async invoke(request) {
    assert(request.op === 'request_permissions', 'The custom macOS helper has been replaced by Codex Computer Use');
    return { message: 'Codex Computer Use manages macOS permissions. App-consent requests appear in Codex Link Activity when starting a session.' };
  }
  decision(target, mode) {
    // Explicit blocks continue to apply even when local per-action prompts are disabled.
    if (this.rules().some(r => r.appId === target.appId && r.decision === 'block')) return 'block';
    return super.decision(target, mode);
  }
  stop() {
    for (const id of [...this.sessions.keys()]) this.closeInternal(id);
    super.stop();
    for (const client of this.clients) client.close(); this.clients.clear();
  }
  closeInternal(id) {
    const s = this.sessions.get(id);
    if (s) { clearTimeout(s.expiryTimer); s.client?.close(); this.clients.delete(s.client); }
    super.closeInternal(id);
  }
  async windows() {
    this.assertEnabled();
    const client = this.clientFactory(); this.clients.add(client);
    try {
      await client.initialize();
      const windows = parseCodexApps(await client.call('list_apps', {}));
      this.assertEnabled();
      return { targetKind: 'app-key-window', windows: windows.map(w => ({ ...w, permissions: { background: this.decision(w, 'background') }, titleRedacted: true })) };
    } finally { client.close(); this.clients.delete(client); }
  }
  async prepareStart(args, principal) {
    this.assertEnabled(); this.prune();
    const generation = this.generation;
    assert(!args.mode || args.mode === 'background', 'Codex Computer Use manages app input itself. Use background mode; explicit foreground takeover is not exposed by this runtime.');
    const { windows } = await this.windows();
    const target = windows.find(w => w.windowId === args.windowId);
    assert(target, 'App not found. Call computer_windows again and use its app ID as windowId.');
    assert(this.decision(target, 'background') !== 'block', 'Application access is blocked locally', 403);
    return { target, mode: 'background', generation, owner: ownerKey(principal), needsApproval: this.decision(target, 'background') !== 'allow' };
  }
  async start(prepared, principal, context = {}) {
    this.assertEnabled(); this.prune();
    assert(prepared.owner === ownerKey(principal) && prepared.generation === this.generation, 'Session request was revoked', 403);
    assert(this.sessions.size < 8 && this.decision(prepared.target, prepared.mode) !== 'block', 'Session unavailable or app blocked', 403);
    const client = this.clientFactory(); this.clients.add(client);
    const expiresAt = Math.min(this.now() + 15 * 60 * 1000, this.permissionDeadline());
    const callContext = { ...context, timeoutMs: Math.max(1, Math.min(10 * 60 * 1000, expiresAt - this.now())) };
    try {
      await client.initialize(callContext);
      // Elicitation is forwarded to the owner before any app capture or input.
      await client.call('get_app_state', { app: prepared.target.appId }, callContext);
      this.assertEnabled();
      assert(prepared.generation === this.generation && this.now() < expiresAt && this.sessions.size < 8, 'Session revoked or expired', 403);
      const id = token(), s = { id, client, target: prepared.target, owner: ownerKey(principal), mode: prepared.mode, expiresAt, observation: null };
      s.expiryTimer = setTimeout(() => this.closeInternal(id), Math.max(1, expiresAt - this.now())); s.expiryTimer.unref?.();
      this.sessions.set(id, s);
      return { sessionId: id, target: s.target, mode: s.mode, backend: this.manifest().backend, expiresAt, observationRequired: true,
        warning: 'The installed Codex runtime controls the app key window. Observe after each action to verify its effect.' };
    } catch (error) { client.close(); this.clients.delete(client); throw error; }
  }
  queue(s, principal, fn) {
    const generation = this.generation, key = s.target.appId;
    const pending = (this.queues.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      assert(generation === this.generation && this.session(s.id, principal) === s, 'Computer operation cancelled', 403);
      try { return await fn(); } catch (error) { if (s.client.closed) this.closeInternal(s.id); throw error; }
    });
    this.queues.set(key, pending);
    pending.finally(() => { if (this.queues.get(key) === pending) this.queues.delete(key); }).catch(() => {});
    return pending;
  }
  async observe(args, principal, context = {}) {
    const s = this.session(args.sessionId, principal);
    return this.queue(s, principal, async () => {
      s.observation = null;
      const result = await s.client.call('get_app_state', { app: s.target.appId }, { ...context, timeoutMs: Math.max(1, Math.min(25000, s.expiresAt - this.now())) });
      this.session(s.id, principal);
      const info = this.recordObservation(s, result, args);
      const { tree, ...metadata } = info;
      return { content: [{ type: 'text', text: JSON.stringify(metadata) }, ...result.content.filter(c => (c.type !== 'image' || args.includeImage !== false) && (c.type !== 'text' || args.includeTree !== false))], structuredContent: info };
    });
  }
  recordObservation(s, result, args = {}) {
    const observationId = token(), createdAt = this.now();
    s.observation = { id: observationId, createdAt, hasImage: args.includeImage !== false && result.content.some(c => c.type === 'image') };
    return { sessionId: s.id, observationId, expiresAt: Math.min(createdAt + 30000, s.expiresAt), target: s.target,
      coordinateSpace: 'original-codex-screenshot-pixels', contentIsUntrusted: true, hasImage: s.observation.hasImage,
      ...(args.includeTree !== false ? { tree: textContent(result) } : {}),
      note: 'Use element indexes from this state. Observations last 30 seconds and one action. Pixel actions require an observation containing an image. Size/depth limits are not applied by this runtime.' };
  }
  observationCurrent(result, principal) {
    try {
      const s = this.session(result.sessionId, principal);
      return !!result.observationId && s.observation?.id === result.observationId && this.now() < result.expiresAt;
    } catch { return false; }
  }
  async stateAfterAction(s, principal, context) {
    const deadline = Date.now() + this.settleMs;
    let previous, result, stable = false;
    do {
      context.signal?.throwIfAborted(); this.session(s.id, principal);
      result = await s.client.call('get_app_state', { app: s.target.appId }, { ...context, timeoutMs: Math.max(1, Math.min(25000, s.expiresAt - this.now())) });
      this.session(s.id, principal); context.signal?.throwIfAborted();
      const tree = textContent(result);
      if (tree && tree === previous) { stable = true; break; }
      previous = tree;
      if (Date.now() >= deadline) break;
      await delay(Math.min(100, deadline - Date.now()), undefined, { signal: context.signal });
    } while (Date.now() < deadline);
    // Keep screenshots out of persisted jobs. Semantic actions use this text
    // state directly; pixel actions explicitly request a screenshot.
    return { ...this.recordObservation(s, result, { includeImage: false }), stateStable: stable };
  }
  validateInteraction(a) {
    if (a.action === 'scroll') {
      const allowed = ['sessionId', 'observationId', 'idempotencyKey', 'action', 'elementId', 'direction', 'pages'];
      assert(Object.keys(a).every(k => allowed.includes(k)), 'Codex scrolling requires elementId, direction and optional pages; pixel scroll steps are not supported.');
      assert(typeof a.elementId === 'string' && a.elementId.length > 0 && ['up', 'down', 'left', 'right'].includes(a.direction), 'Scroll requires an observed elementId and direction');
      assert(a.pages === undefined || Number.isFinite(a.pages) && a.pages > 0 && a.pages <= 30, 'pages must be greater than zero and at most 30');
    } else validateInteraction(a);
    assert(['click', 'double_click', 'drag', 'scroll', 'type', 'key', 'invoke', 'set_value'].includes(a.action), `Codex Computer Use does not expose ${a.action} through this adapter; use its observed element indexes with invoke or set_value.`);
    if (a.action === 'drag') assert(!a.button || a.button === 'left', 'Codex drag supports the left button only');
  }
  async interact(args, principal, context = {}) {
    this.validateInteraction(args);
    const s = this.session(args.sessionId, principal);
    return this.queue(s, principal, async () => {
      assert(s.observation?.id === args.observationId && this.now() - s.observation.createdAt < 30000, 'Observation is stale or already used; call computer_observe again', 409);
      if (['click', 'double_click', 'drag'].includes(args.action)) assert(s.observation.hasImage, 'Pixel input requires a screenshot observation');
      let name, input = { app: s.target.appId };
      switch (args.action) {
        case 'click': case 'double_click': name = 'click'; Object.assign(input, { x: args.x, y: args.y, mouse_button: args.button || 'left', click_count: args.action === 'double_click' ? 2 : 1 }); break;
        case 'invoke': name = 'click'; input.element_index = args.elementId; break;
        case 'set_value': name = 'set_value'; Object.assign(input, { element_index: args.elementId, value: args.text }); break;
        case 'type': name = 'type_text'; input.text = args.text; break;
        case 'key': name = 'press_key'; input.key = args.keys.map(k => ({ command: 'super', cmd: 'super', control: 'ctrl', option: 'alt', enter: 'Return', return: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape', space: 'space', backspace: 'BackSpace', delete: 'Delete', left: 'Left', right: 'Right', up: 'Up', down: 'Down', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next' }[k.toLowerCase()] || (/^f\d{1,2}$/i.test(k) ? k.toUpperCase() : k))).join('+'); break;
        case 'drag': name = 'drag'; Object.assign(input, { from_x: args.x, from_y: args.y, to_x: args.toX, to_y: args.toY }); break;
        case 'scroll': name = 'scroll'; Object.assign(input, { element_index: args.elementId, direction: args.direction, pages: args.pages ?? 1 }); break;
      }
      for (const other of this.sessions.values()) if (other.target.appId === s.target.appId) other.observation = null;
      const result = await s.client.call(name, input, { ...context, timeoutMs: Math.max(1, Math.min(context.requestApproval ? 600000 : 25000, s.expiresAt - this.now())) });
      this.session(s.id, principal);
      const completed = { sessionId: s.id, actionCompleted: true, backend: 'Codex Computer Use', message: textContent(result).slice(0, 12000) };
      try {
        return { ...completed, ...await this.stateAfterAction(s, principal, context), needsObservation: false };
      } catch (error) {
        s.observation = null;
        return { ...completed, needsObservation: true, stateError: error.message, next: 'The action completed, but fresh state is unavailable. Call computer_observe; do not repeat the action.' };
      }
    });
  }
}
