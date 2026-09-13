import { str, obj, integer } from './schema.mjs';
import { assert, hash, id } from './util.mjs';

const scope = ['computer:use', 'shell:execute'];
const description = `Use the installed Codex Computer Use JavaScript REPL. Variables and app objects persist across calls for this OAuth connection. Browser APIs are exposed upstream but currently fail here when they require active Codex turn metadata. Call this directly; no computer_session_start or observationId is needed. First call (and after reset): execute exactly one of await cua.getState(), let app = await cua.getApp("AppName or bundle ID"), let browser = await cua.getBrowser({url}), or let tab = await cua.createBrowserTab(browserId, url, options). Read the returned API instructions before continuing. Use only the documented cua APIs. After UI actions get fresh AX state before deciding the next action. Use nodeRepl.write for text and nodeRepl.emitImage for images. Results and first-use documentation pass through unchanged. This is JavaScript execution, requires computer:use and shell:execute, and is not a workspace sandbox. Local app blocks disable this tool; Codex app/browser permissions still apply. Normally returns text/images directly. If pending, use computer_js_result with its jobId, never resubmit the code. Sessions expire after 15 minutes idle or when desktop access stops. Set a unique idempotencyKey if retries might be needed; reuse exactly the same arguments/key on retry. A lost response can mean input executed: never repeat uncertain actions with a new key.`;

export function installComputerReplTools(tools, { inlineWaitMs = 15000, resultTtlMs = 15 * 60 * 1000, maxBytes = 32 * 1024 * 1024 } = {}) {
  if (!tools.computer.native.relay || !tools.computer.repl) return;
  const results = new Map(); let bytes = 0;
  const prune = () => {
    for (const [key, r] of results) if (r.expiresAt <= Date.now() || !tools.jobs.store.data.jobs.some(j => j.id === key)) { bytes -= r.bytes; results.delete(key); }
  };
  const remember = (jobId, principal, result) => {
    prune(); const size = Buffer.byteLength(JSON.stringify(result));
    assert(size <= maxBytes, 'Computer Use result exceeds the result cache limit; input may have executed');
    while (bytes + size > maxBytes && results.size) { const [key, r] = results.entries().next().value; bytes -= r.bytes; results.delete(key); }
    results.set(jobId, { grantId: principal.grantId, result, bytes: size, expiresAt: Date.now() + resultTtlMs }); bytes += size;
  };
  const read = async (jobId, p, waitMs) => {
    let j = tools.jobs.get(jobId, p);
    assert(j.computerRepl && j.grantId === p.grantId, 'Computer Use result belongs to another connection', 403);
    if (['queued', 'running'].includes(j.status) && waitMs) await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); tools.jobs.off('change', changed); resolve(); };
      const changed = () => { if (!['queued', 'running'].includes(j.status)) finish(); };
      const timer = setTimeout(finish, waitMs); tools.jobs.on('change', changed); changed();
    });
    j = tools.jobs.get(jobId, p); prune();
    const info = { jobId, status: j.status, idempotencyKey: j.idempotencyKey };
    if (j.status === 'completed') {
      const entry = results.get(jobId);
      if (!entry) return { isError: true, content: [{ type: 'text', text: 'Execution completed, but its in-memory result expired or was cleared. Do not replay the code; observe current state with a new call.' }], _meta: { codexLink: info } };
      return { ...entry.result, _meta: { ...entry.result._meta, codexLink: info } };
    }
    if (['queued', 'running', 'awaiting_approval'].includes(j.status)) return { content: [{ type: 'text', text: JSON.stringify({ ...info, next: 'Call computer_js_result with jobId; do not resubmit the code.', ...(j.permissionRequest ? { permissionRequest: j.permissionRequest } : {}) }) }], structuredContent: info };
    return { isError: true, content: [{ type: 'text', text: j.error || `Computer Use execution ${j.status}. Do not replay uncertain input.` }], _meta: { codexLink: info } };
  };
  const execute = async (tool, a, p) => {
    tools.computer.repl.assertEnabled();
    const requestArgs = { ...a, idempotencyKey: a.idempotencyKey || `cua-${id(18)}` };
    const key = requestArgs.idempotencyKey, payloadHash = hash(JSON.stringify({ kind: 'computer', args: requestArgs, tool }));
    const previous = tools.jobs.store.data.jobs.find(j => j.clientId === p.clientId && j.idempotencyKey === key);
    if (previous) { assert(previous.computerRepl && previous.grantId === p.grantId && previous.payloadHash === payloadHash, 'Idempotency key used by a different operation or connection', 409); return read(previous.id, p, inlineWaitMs); }
    const args = tool === 'js_reset' ? {} : { code: a.code, ...(a.title ? { title: a.title } : {}), ...(a.timeout_ms ? { timeout_ms: a.timeout_ms } : {}) };
    const job = tools.jobs.create({ kind: 'computer', title: a.title || (tool === 'js_reset' ? 'Reset Computer Use JavaScript' : 'Computer Use JavaScript'), principal: p, scopes: scope,
      approval: tools.computer.repl.needsApproval(p) && !tools.config.value.dangerousModeEnabled,
      key, request: { ...args, warning: 'Allows JavaScript execution for this connection. Codex app/browser permissions remain in effect.' }
    }, async context => {
      const result = await tools.computer.repl.execute(tool, args, p, context);
      remember(context.jobId, p, result);
      return { computerRepl: true, fetchWith: 'computer_js_result', jobId: context.jobId };
    });
    const stored = tools.jobs.get(job.id); stored.computerRepl = true; stored.grantId = p.grantId; stored.payloadHash = payloadHash; tools.jobs.store.save();
    return read(job.id, p, inlineWaitMs);
  };
  tools.add('computer_js', description, obj({ code: str('JavaScript using the documented cua and nodeRepl APIs', 100000), title: str('Short description of this call', 240), timeout_ms: integer(1, 600000, 'Execution timeout in milliseconds; default 30000'), idempotencyKey: str('Optional unique retry key. Reuse identical code and arguments when retrying.', 128) }, ['code']), scope, false, (a, p) => execute('js', a, p), true);
  tools.add('computer_js_reset', 'Reset this connection’s Codex Computer Use JavaScript runtime. Variables and app/tab bindings are discarded; this does not close apps or browser tabs. The next computer_js call must follow first-use instructions. Does not undo completed actions.', obj({ idempotencyKey: str('Optional unique retry key', 128) }), scope, false, (a, p) => execute('js_reset', a, p));
  tools.add('computer_js_result', 'Retrieve a pending computer_js or computer_js_reset result as native text/images. Does not execute code again. Use only the returned jobId; app approval still requires the local owner. Results are retained temporarily in memory.', obj({ jobId: str('jobId returned by a pending Computer Use call', 128), wait_ms: integer(0, 20000, 'Wait for completion, up to 20 seconds; default 15000') }, ['jobId']), scope, true, (a, p) => read(a.jobId, p, a.wait_ms ?? inlineWaitMs));
}
