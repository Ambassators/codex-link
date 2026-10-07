import { assert, hash, sleep } from './util.mjs';
import { validate, str, obj, integer } from './schema.mjs';
import { runProcess, shellCommand, findExecutable } from './process.mjs';
import { imageType } from './workspaces.mjs';
import { installNativeComputerTools } from './native-computer-tools.mjs';
import { installComputerReplTools } from './computer-repl-tools.mjs';
import { installDecisionsComputerTools } from './decisions-computer.mjs';

export const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value && typeof value === 'object' && !Array.isArray(value) ? value : { value } });
export const imageResult = (data, mimeType, info = {}) => ({ content: [{ type: 'text', text: JSON.stringify(info) }, { type: 'image', mimeType, data }], structuredContent: info });
const ws = str('Name returned by workspace_list', 48), rel = str('Path relative to the approved workspace root');
const key = str('Unique idempotency key for a write/job. Reuse only to retry exactly the same operation.', 128);
const digest = { type: ['string', 'null'], description: 'SHA-256 returned by file_read; null ONLY when creating a new file.', pattern: '^[a-f0-9]{64}$' };
const empty = obj({});
function cleanRequest(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cleanRequest);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|password|client_secret|authorization|dataBase64)$/i.test(k) ? '[redacted from activity log]' : cleanRequest(v)]));
}
export class Tools {
  constructor(services) {
    Object.assign(this, services); this.definitions = new Map(); this.install(); installNativeComputerTools(this); installComputerReplTools(this); installDecisionsComputerTools(this);
  }
  add(name, description, inputSchema, scopes, readOnly, handler, openWorld = false) {
    const securitySchemes = [{ type: 'oauth2', scopes }];
    this.definitions.set(name, { descriptor: { name, description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: openWorld }, securitySchemes, _meta: { securitySchemes } }, scopes, handler });
  }
  list() { return [...this.definitions.values()].map(d => d.descriptor); }
  async call(name, args, principal) {
    const tool = this.definitions.get(name); assert(tool, 'Unknown tool', 404);
    this.oauth.require(principal, tool.scopes); validate(tool.descriptor.inputSchema, args);
    this.audit('tool.called', { name, clientId: principal.clientId });
    const result = await tool.handler(args, principal);
    return result?.content ? result : textResult(result);
  }
  job(kind, title, args, principal, scopes, approval, runner, auditRequest = args) {
    // Bind an idempotency key to the complete arguments, not merely a friendly title.
    const payloadHash = hash(JSON.stringify({ kind, args }));
    if (args.idempotencyKey) {
      const previous = this.jobs.store.data.jobs.find(j => j.clientId === principal.clientId && j.idempotencyKey === args.idempotencyKey);
      assert(!previous || previous.payloadHash === payloadHash, 'Idempotency key used with different arguments', 409);
    }
    const result = this.jobs.create({ kind, title, principal, scopes, approval: approval && !this.config.value.dangerousModeEnabled, key: args.idempotencyKey, request: cleanRequest(auditRequest) }, runner);
    this.jobs.get(result.id).payloadHash = payloadHash; this.jobs.store.save(); return result;
  }
  install() {
    this.add('bridge_status', 'Read bridge capabilities and permission state. Use workspace_list before accessing files. Long operations return jobs: poll job_get until completed; awaiting_approval requires the owner’s local UI.', empty, ['bridge:read'], true, () => ({
      name: 'Codex Link', version: '0.2.0', platform: process.platform, workspaces: this.workspaces.list().map(w => w.name),
      computerEnabled: this.computer.enabled(),
      computerAdapter: this.computer.native.manifest().backend, computerNative: this.computer.native.manifest(),
      notes: ['Shell execution is NOT workspace-sandboxed.', 'ChatGPT attachments are not automatically local files. Use image_write or a real workspace image path.', 'No remote approval tool exists. The owner approves in the local panel.']
    }));
    this.add('workspace_list', 'List explicitly approved project folders. A workspace name is required for file and search operations.', empty, ['files:read'], true, () => ({ workspaces: this.workspaces.list() }));
    this.add('conversation_list', 'List read-only conversations imported from Codex for currently shared project folders.', obj({ workspace: ws, offset: integer(0, 1000000, 'Conversation offset'), limit: integer(1, 100, 'Page size') }), ['files:read'], true, a => this.codexImport.list(a));
    this.add('conversation_read', 'Read text messages from a conversation imported from Codex. Original Codex files are never modified.', obj({ id: str('Imported conversation id', 256), after: integer(0, 10000000, 'Last message sequence'), limit: integer(1, 100, 'Page size') }, ['id']), ['files:read'], true, a => this.codexImport.read(a));
    this.add('file_list', 'List directory entries without following symlinks.', obj({ workspace: ws, path: rel }, ['workspace']), ['files:read'], true, a => this.workspaces.listDirectory(a.workspace, a.path || '.'));
    this.add('file_read', 'Read a UTF-8 file (up to 512 KiB) and its SHA-256. Use that hash for a compare-and-swap write or edit.', obj({ workspace: ws, path: rel }, ['workspace', 'path']), ['files:read'], true, a => this.workspaces.text(a.workspace, a.path));
    this.add('file_write', 'Create or replace a UTF-8 file. An existing file requires its current expectedHash. Returns an approval-gated job; inspect job_get before claiming success.', obj({ workspace: ws, path: rel, text: { type: 'string', maxLength: 1024 * 1024 }, expectedHash: digest, idempotencyKey: key }, ['workspace', 'path', 'text', 'expectedHash', 'idempotencyKey']), ['files:write'], false, (a, p) => this.job('file_write', `Write ${a.workspace}/${a.path}`, a, p, ['files:write'], !this.config.value.autoApproveWrites, async c => { assert(!c.signal.aborted, 'Cancelled'); return this.workspaces.write(a.workspace, a.path, a.text, a.expectedHash); }));
    this.add('file_edit', 'Replace exactly one matching text segment, guarded by expectedHash. Fails if the old text is absent, ambiguous, or the file changed. Returns a job.', obj({ workspace: ws, path: rel, oldText: str('Exact old text', 262144), newText: { type: 'string', maxLength: 262144 }, expectedHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, idempotencyKey: key }, ['workspace', 'path', 'oldText', 'newText', 'expectedHash', 'idempotencyKey']), ['files:write'], false, (a, p) => this.job('file_edit', `Edit ${a.workspace}/${a.path}`, a, p, ['files:write'], !this.config.value.autoApproveWrites, async c => { assert(!c.signal.aborted, 'Cancelled'); return this.workspaces.edit(a.workspace, a.path, a.oldText, a.newText, a.expectedHash); }));
    this.add('rg_search', 'Run ripgrep without a shell inside an approved directory. Respects ignore files, does not follow symlinks, bounds time/output, and treats the pattern as data. Exit code 1 means no matches.', obj({ workspace: ws, path: rel, pattern: str('ripgrep regular expression', 8192), glob: str('Optional file glob', 256), caseSensitive: { type: 'boolean' }, maxCount: integer(1, 500, 'Matches per file') }, ['workspace', 'pattern']), ['files:read'], true, async a => {
      const cwd = await this.workspaces.resolve(a.workspace, a.path || '.', { directory: true }), file = findExecutable('rg'); assert(file, 'ripgrep is not installed; run platform setup');
      const args = ['--json', '--no-follow', '--max-filesize', '2M', '--max-count', String(a.maxCount || 100)];
      if (a.caseSensitive === false) args.push('--ignore-case'); if (a.glob) args.push('--glob', a.glob); args.push('--', a.pattern, '.');
      const result = await runProcess({ file, args: [] }, args, { cwd, timeoutMs: 15000, maxOutput: 512 * 1024 });
      assert(result.exitCode === 0 || result.exitCode === 1, result.stderr || 'ripgrep failed'); return result;
    });
    this.add('image_read', 'Return a real PNG/JPEG/WebP workspace image as MCP image content, not a text-only base64 dump. Maximum 4 MiB.', obj({ workspace: ws, path: rel }, ['workspace', 'path']), ['files:read'], true, async a => {
      const { data, sha256 } = await this.workspaces.read(a.workspace, a.path, 4 * 1024 * 1024); return imageResult(data.toString('base64'), imageType(data), { path: a.path, sha256 });
    });
    this.add('image_write', 'Save explicitly supplied base64 image bytes as a workspace file. The chat host must actually provide bytes; attachment names are not file paths. Maximum 2 MiB decoded.', obj({ workspace: ws, path: rel, dataBase64: str('Raw base64, without a data URL prefix', 2800000), expectedHash: digest, idempotencyKey: key }, ['workspace', 'path', 'dataBase64', 'expectedHash', 'idempotencyKey']), ['files:write'], false, (a, p) => {
      assert(/^[A-Za-z0-9+/]+={0,2}$/.test(a.dataBase64), 'Invalid base64'); const bytes = Buffer.from(a.dataBase64, 'base64'); assert(bytes.length <= 2 * 1024 * 1024, 'Image is too large'); imageType(bytes);
      return this.job('image_write', `Save image ${a.workspace}/${a.path}`, a, p, ['files:write'], !this.config.value.autoApproveWrites, () => this.workspaces.write(a.workspace, a.path, bytes, a.expectedHash));
    });
    this.add('shell_start', 'Run a shell/PowerShell command as the local OS user. WARNING: cwd is not a sandbox; commands can access other files/network. Requires local approval by default. Returns a job with live stdout/stderr. Pipes, not a PTY.', obj({ workspace: ws, cwd: rel, shell: { enum: ['default', 'powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'sh'], type: 'string' }, command: str('Exact shell script to execute', 12000), timeoutSeconds: integer(1, 3600, 'Maximum running time'), keepStdin: { type: 'boolean' }, idempotencyKey: key }, ['workspace', 'command', 'idempotencyKey']), ['shell:execute'], false, (a, p) => this.job('shell', `Shell in ${a.workspace}: ${a.command.slice(0, 160)}`, a, p, ['shell:execute'], !this.config.value.autoApproveShell, async c => {
      const cwd = await this.workspaces.resolve(a.workspace, a.cwd || '.', { directory: true });
      const result = await runProcess(shellCommand(a.shell || 'default', a.command), [], { cwd, signal: c.signal, timeoutMs: (a.timeoutSeconds || 120) * 1000, keepStdin: !!a.keepStdin,
        onOutput: (stream, text) => c.emit(`shell.${stream}`, { text }), onSpawn: child => c.setControl({ stdin: text => { assert(child.stdin.writable, 'stdin is closed'); child.stdin.write(text); }, end: () => child.stdin.end() }) });
      return result;
    }), true);
    this.add('shell_input', 'Send input or EOF to a live shell job created with keepStdin. This is an execution action and may require local approval.', obj({ jobId: str('Shell job id'), text: { type: 'string', maxLength: 12000 }, eof: { type: 'boolean' }, idempotencyKey: key }, ['jobId', 'idempotencyKey']), ['shell:execute'], false, (a, p) => {
      const target = this.jobs.get(a.jobId, p); assert(target.kind === 'shell', 'Not a shell job');
      return this.job('shell_input', `Input to shell ${a.jobId}`, a, p, ['shell:execute'], !this.config.value.autoApproveShell, async () => {
        const control = this.jobs.extra.get(a.jobId); assert(control?.stdin, 'Shell input is unavailable'); if (a.text !== undefined) control.stdin(a.text); if (a.eof) control.end(); return { sent: true };
      });
    }, true);
    this.add('computer_screenshot', 'LEGACY, unscoped: prefer computer_observe with an approved window session. Requires the separate local legacy opt-in. Capture the primary display as MCP image content while computer control is locally enabled. The owner can enable a temporary or persistent session. Image coordinates match primary-display logical input coordinates. Can reveal sensitive screen contents.', empty, ['computer:use'], true, async () => {
      const { data, mimeType, ...info } = await this.computer.action({ action: 'screenshot' }); return imageResult(data, mimeType, info);
    });
    this.add('computer_action', 'LEGACY, unscoped: unavailable on macOS; use computer_js. On Windows prefer computer_interact with an approved window session. Requires the separate local legacy opt-in; native app rules do not constrain this tool. Operate the primary desktop while computer control is locally enabled. The owner can enable a temporary or persistent session. Uses standard mouse/keyboard automation. Move the mouse to a corner to trigger the fail-safe. Returns a job.', obj({ action: { type: 'string', enum: ['move', 'click', 'double_click', 'drag', 'type', 'key', 'scroll'] }, x: integer(0, 20000, 'Logical X'), y: integer(0, 20000, 'Logical Y'), button: { type: 'string', enum: ['left', 'right', 'middle'] }, text: { type: 'string', maxLength: 20000 }, keys: { type: 'array', items: str('PyAutoGUI key name', 40), maxItems: 5, minItems: 1 }, amount: integer(-30, 30, 'Scroll steps; positive means up'), idempotencyKey: key }, ['action', 'idempotencyKey']), ['computer:use'], false, (a, p) => {
      assert(this.computer.enabled(), 'Enable computer control locally first', 403);
      return this.job('computer', `Desktop: ${a.action}`, a, p, ['computer:use'], false, c => this.computer.action(a, c));
    }, true);
    this.add('job_list', 'List jobs accessible to this connection and its granted scopes.', empty, ['bridge:read'], true, (a, p) => ({ jobs: this.jobs.list(p).map(({ request, result, ...j }) => j) }));
    this.add('job_get', 'Read job status, final result, error and incremental events. If awaiting_approval, ask the owner to approve locally. Poll with nextCursor until terminal status; do not claim success before completed. waitSeconds can wait for a status change.', obj({ jobId: str('Job id'), after: integer(0, Number.MAX_SAFE_INTEGER, 'Last event sequence'), limit: integer(1, 100, 'Page size'), waitSeconds: integer(0, 20, 'Optional wait for new events') }, ['jobId']), ['bridge:read'], true, async (a, p) => {
      let value = this.jobs.view(a.jobId, p, a.after || 0, a.limit || 50); const deadline = Date.now() + (a.waitSeconds || 0) * 1000;
      while (!value.events.length && ['running', 'queued'].includes(value.status) && Date.now() < deadline) { await sleep(200); value = this.jobs.view(a.jobId, p, a.after || 0, a.limit || 50); }
      delete value.request; return value;
    });
    this.add('job_cancel', 'Cancel a job. Stops tracked child processes where possible. Does not undo file changes or terminate processes deliberately detached by arbitrary commands.', obj({ jobId: str('Job id') }, ['jobId']), ['bridge:read'], false, (a, p) => this.jobs.cancel(a.jobId, p));
  }
}
