import { existsSync } from 'node:fs';
import { CodexComputerClient, codexComputerExecutable } from './codex-computer-client.mjs';
import { assert } from './util.mjs';

export function codexAppServerExecutable() {
  return [process.env.CODEX_CLI_PATH, '/Applications/ChatGPT.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Resources/codex'].find(p => p && existsSync(p));
}
export const codexAppServerInstalled = () => !!codexAppServerExecutable() && existsSync(codexComputerExecutable());
const literal = JSON.stringify;
const index = value => {
  assert(/^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)), 'Use a numeric element index from the latest observation');
  return Number(value);
};

/** Uses Codex's public app-server protocol and its configured CUA plugin.
 * No credentials, host identities or permission decisions are fabricated.
 */
export class CodexAppServerClient extends CodexComputerClient {
  constructor({ executable = codexAppServerExecutable(), args = ['app-server', '--stdio'], spawnProcess } = {}) {
    assert(executable, 'Install the Codex desktop app before using Computer Use');
    super({ executable, args, ...(spawnProcess ? { spawnProcess } : {}) });
    this.appId = null;
  }
  send(message) {
    assert(!this.closed, 'Codex app-server connection is closed');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  async initialize(context = {}) {
    await this.request('initialize', { clientInfo: { name: 'codex-link', title: 'Codex Link', version: '0.2.0' }, capabilities: { experimentalApi: true } }, context);
    this.send({ method: 'initialized' });
    const result = await this.request('thread/start', { ephemeral: true, cwd: process.cwd(), serviceName: 'codex-link-computer' }, context);
    assert(result.thread?.ephemeral === true && result.thread.id, 'Codex did not create an ephemeral Computer Use session');
    this.threadId = result.thread.id;
  }
  async respond(message) {
    if (message.method !== 'mcpServer/elicitation/request') return this.send({ id: message.id, error: { code: -32601, message: 'Codex Link does not handle this server request' } });
    const p = message.params;
    const schema = p?.requestedSchema;
    const supported = p?.threadId === this.threadId && p.serverName === 'cua_repl' && p.mode === 'form' && schema?.type === 'object' && !Object.keys(schema.properties || {}).length && !schema.required?.length;
    if (!supported || !this.context?.requestApproval) {
      this.consentCancelled = true;
      return this.send({ id: message.id, result: { action: 'cancel', content: null } });
    }
    const allowed = await this.context.requestApproval({ source: 'Codex Computer Use', message: String(p.message || 'Allow app access?').slice(0, 2000) });
    if (!allowed) this.consentDeclined = true;
    if (!this.closed) this.send({ id: message.id, result: { action: allowed ? 'accept' : 'decline', content: allowed ? {} : null } });
  }
  async evaluate(code, context) {
    const result = await this.request('mcpServer/tool/call', { threadId: this.threadId, server: 'cua_repl', tool: 'js', arguments: { code, title: 'Codex Link Computer Use', timeout_ms: Math.min(context.timeoutMs || 25000, 600000) } }, context);
    assert(!this.consentCancelled, 'Codex requested an unsupported approval or consent outside an approval-capable job; start a new session');
    assert(!this.consentDeclined, 'Codex Computer Use app permission was denied');
    assert(Array.isArray(result?.content), 'Invalid Codex app-server tool response');
    assert(!result.isError, result.content.filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 4000) || 'Codex Computer Use failed');
    return result;
  }
  async replCall(tool, args, context = {}) {
    assert(['js', 'js_reset'].includes(tool), 'Unsupported Computer Use REPL tool');
    assert(!this.context, 'Concurrent calls on one Computer Use runtime are not allowed');
    this.context = context; this.consentCancelled = false; this.consentDeclined = false;
    try {
      const result = await this.request('mcpServer/tool/call', { threadId: this.threadId, server: 'cua_repl', tool, arguments: args }, context);
      assert(!this.consentCancelled, 'Codex requested unsupported consent; the request was cancelled');
      assert(!this.consentDeclined, 'Codex Computer Use app permission was denied');
      assert(Array.isArray(result?.content), 'Invalid Codex Computer Use response');
      // Preserve upstream errors, documentation, images, and metadata as tool content.
      return result;
    } finally { this.context = null; }
  }
  async call(name, args, context = {}) {
    assert(!this.context, 'Concurrent calls on one Codex Computer Use connection are not allowed');
    this.context = context; this.consentCancelled = false; this.consentDeclined = false;
    try {
      if (name === 'list_apps') {
        assert(!this.appId, 'App inventory requires a separate connection');
        await this.evaluate('let inventory = await cua.getState();', context);
        const r = await this.evaluate('nodeRepl.write(JSON.stringify({ apps: inventory.apps }));', context);
        const parsed = r.content.filter(c => c.type === 'text').map(c => { try { return JSON.parse(c.text); } catch { return null; } }).find(v => Array.isArray(v?.apps));
        assert(parsed, 'Codex did not return an app inventory');
        return { content: [], structuredContent: parsed };
      }
      assert(typeof args.app === 'string' && args.app, 'An app ID is required');
      if (!this.appId) {
        assert(name === 'get_app_state', 'Observe the app before sending input');
        await this.evaluate(`let target = await cua.getApp(${literal(args.app)});`, context);
        this.appId = args.app;
      }
      assert(this.appId === args.app, 'A Computer Use connection cannot switch apps');
      let code;
      switch (name) {
        case 'get_app_state': code = 'await target.getAXStateAndScreenshot({disableDiffing:true});'; break;
        case 'click': code = `await target.click(${args.element_index !== undefined ? index(args.element_index) : literal([args.x, args.y])}, ${literal({ mouseButton: args.mouse_button || 'left', clickCount: args.click_count || 1 })});`; break;
        case 'set_value': code = `await target.setValue(${index(args.element_index)}, ${literal(args.value)});`; break;
        case 'type_text': code = `await target.typeText(${literal(args.text)});`; break;
        case 'press_key': code = `await target.pressKey(${literal(args.key)});`; break;
        case 'drag': code = `await target.drag(${literal([args.from_x, args.from_y])}, ${literal([args.to_x, args.to_y])});`; break;
        case 'scroll': code = `await target.scroll(${index(args.element_index)}, ${literal(args.direction)}, ${literal(args.pages ?? 1)});`; break;
        default: throw new Error(`Unsupported Codex Computer Use action: ${name}`);
      }
      // Capture fresh state after every input; an uncertain input is never retried.
      if (name !== 'get_app_state') code += ' await target.getAXState();';
      return await this.evaluate(code, context);
    } finally { this.context = null; }
  }
}
