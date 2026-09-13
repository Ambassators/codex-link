import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { assert } from './util.mjs';

export const codexComputerExecutable = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient');
const MAX_FRAME = 24 * 1024 * 1024;

/** One private upstream connection per app session. Failed input is never replayed. */
export class CodexComputerClient {
  constructor({ executable = codexComputerExecutable(), args = ['mcp'], spawnProcess = spawn } = {}) {
    this.pending = new Map(); this.seq = 0; this.buffer = ''; this.closed = false; this.context = null;
    this.child = spawnProcess(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > MAX_FRAME) return this.close(new Error('Codex Computer Use response exceeded the size limit'));
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); } catch { this.close(new Error('Invalid Codex Computer Use response')); }
      }
    });
    // Drain diagnostics without persisting app contents or credentials.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.close(new Error('Codex Computer Use input closed')));
    this.child.on('error', () => this.close(new Error('Could not launch Codex Computer Use. Install it in Codex first.')));
    this.child.on('exit', () => this.close(new Error('Codex Computer Use disconnected; start a new session')));
  }
  send(message) {
    assert(!this.closed, 'Codex Computer Use connection is closed');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  receive(message) {
    if (message.method && Object.hasOwn(message, 'id')) {
      this.respond(message).catch(() => this.close(new Error('Codex Computer Use permission request failed'))); return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || 'Codex Computer Use request failed'));
    else pending.resolve(message.result);
  }
  async respond(message) {
    if (message.method !== 'elicitation/create') return this.send({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } });
    const schema = message.params?.requestedSchema;
    // Only the runtime's empty app-consent form is supported; never invent form data.
    const supported = schema?.type === 'object' && Object.keys(schema.properties || {}).length === 0 && !(schema.required?.length);
    if (!supported || !this.context?.requestApproval) { this.consentCancelled = true; return this.send({ id: message.id, result: { action: 'cancel' } }); }
    const allow = await this.context.requestApproval({ source: 'Codex Computer Use', message: String(message.params.message || 'Allow app access?').slice(0, 2000) });
    if (!allow) this.consentDeclined = true;
    this.send({ id: message.id, result: allow ? { action: 'accept', content: {} } : { action: 'decline' } });
  }
  request(method, params, { signal, timeoutMs = 30000 } = {}) {
    if (this.closed) return Promise.reject(new Error('Codex Computer Use connection is closed'));
    if (signal?.aborted) { this.close(); return Promise.reject(new Error('Computer operation cancelled')); }
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const abort = () => this.close(new Error('Computer operation cancelled or timed out; do not replay uncertain input'));
      const timer = setTimeout(abort, timeoutMs); timer.unref?.();
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.send({ id, method, params }); } catch (error) { this.close(error); }
    });
  }
  async initialize(context = {}) {
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: { elicitation: {} }, clientInfo: { name: 'codex-link', version: '0.2.0' } }, context);
    this.send({ method: 'notifications/initialized' });
    const result = await this.request('tools/list', {}, context);
    this.tools = new Set(result.tools?.map(tool => tool.name));
    for (const required of ['list_apps', 'get_app_state', 'click']) assert(this.tools.has(required), `Codex Computer Use is missing ${required}; update the installed runtime`);
  }
  async call(name, args, context = {}) {
    assert(this.tools?.has(name), `Installed Codex Computer Use does not support ${name}`);
    assert(!this.context, 'Concurrent calls on one Codex Computer Use connection are not allowed');
    this.context = context; this.consentDeclined = false; this.consentCancelled = false;
    try {
      const result = await this.request('tools/call', { name, arguments: args }, context);
      assert(!this.consentCancelled, 'Codex Computer Use requested consent outside session setup. Start a new session so the owner can approve it.');
      assert(!this.consentDeclined, 'Codex Computer Use app permission was denied');
      assert(result && Array.isArray(result.content), 'Invalid Codex Computer Use tool result');
      if (result.isError) throw new Error(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 4000) || 'Codex Computer Use failed');
      return result;
    } finally { this.context = null; }
  }
  close(error = new Error('Codex Computer Use session closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear(); this.buffer = '';
    this.child.kill();
  }
}
