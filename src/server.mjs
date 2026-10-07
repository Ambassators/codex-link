import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { Config, SCOPES } from './config.mjs';
import { OAuth } from './oauth.mjs';
import { Workspaces } from './workspaces.mjs';
import { CodexImport } from './codex-import.mjs';
import { Jobs } from './jobs.mjs';
import { Computer } from './computer.mjs';
import { Tailscale } from './tailscale.mjs';
import { checkPublicConnection } from './connection-health.mjs';
import { Tools } from './tools.mjs';
import { Updates } from './updates.mjs';
import { handleMcp } from './mcp.mjs';
import { findExecutable, pythonCommand } from './process.mjs';
import { id, hash, equal, assert, HttpError, json, html, readBody, securityHeaders, safeError } from './util.mjs';

const UI = fileURLToPath(new URL('../ui/', import.meta.url));
function listen(server, port) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); }); }); }
function close(server) { return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
class Limiter {
  constructor() { this.buckets = new Map(); }
  check(key, limit) {
    const t = Date.now(), v = this.buckets.get(key);
    if (!v || v.until < t) {
      if (this.buckets.size >= 2000) for (const [k, b] of this.buckets) if (b.until < t) this.buckets.delete(k);
      assert(this.buckets.has(key) || this.buckets.size < 2000, 'Rate limiter is at capacity; retry in a minute', 429);
      this.buckets.set(key, { until: t + 60000, count: 1 });
    }
    else { v.count++; assert(v.count <= limit, 'Rate limit exceeded; retry in a minute', 429); }
    if (this.buckets.size > 2000) for (const [k, b] of this.buckets) if (b.until < t) this.buckets.delete(k);
  }
}
export async function createBridge({ home, config = new Config(home), adminPort, publicPort, chooseFolder, codexHome, autoEnableConnection = false, checkConnection = checkPublicConnection } = {}) {
  const adminToken = id(48), bootAt = Date.now(), limiter = new Limiter();
  const auditFile = path.join(config.home, 'audit.jsonl');
  const audit = (event, details = {}) => {
    try { if (statSync(auditFile).size > 5 * 1024 * 1024) renameSync(auditFile, `${auditFile}.previous`); } catch (e) { if (e.code !== 'ENOENT') console.error('Audit rotation:', e.message); }
    appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), event, details }) + '\n', { mode: 0o600 });
  };
  const oauth = new OAuth(config, audit), workspaces = new Workspaces(config), jobs = new Jobs(config);
  const computer = new Computer(config), tailscale = new Tailscale(config), codexImport = new CodexImport(config, workspaces, codexHome);
  const updates = new Updates();
  const services = { updates, config, oauth, workspaces, jobs, computer, tailscale, codexImport, audit };
  const tools = new Tools(services); services.tools = tools;
  const localPrincipal = { clientId: 'local-owner', grantId: 'local', scopes: SCOPES };
  let actualAdminPort = adminPort ?? config.value.adminPort, actualPublicPort = publicPort ?? config.value.publicPort;
  let connectionHealth = { origin: '', status: 'unknown', message: 'Public connectivity has not been checked.', checkedAt: null };
  let healthController, healthTimer, healthGeneration = 0;
  const refreshConnection = async () => {
    const generation = ++healthGeneration, origin = config.value.publicOrigin;
    healthController?.abort(); healthController = new AbortController();
    connectionHealth = { origin, status: origin ? 'checking' : 'disabled', message: origin ? 'Checking public connectivity…' : 'Connection disabled.', checkedAt: null };
    try {
      const result = await checkConnection(origin, { signal: healthController.signal });
      if (generation === healthGeneration && origin === config.value.publicOrigin) connectionHealth = result;
    } catch (e) {
      if (generation === healthGeneration && !healthController.signal.aborted) connectionHealth = { origin, status: 'unknown', message: 'Could not verify public connectivity.', checkedAt: Date.now() };
    }
    return connectionHealth;
  };
  const enableConnection = (reconnect = false) => {
    const existing = jobs.list().find(j => j.kind === 'setup' && ['queued', 'running'].includes(j.status));
    if (existing) return jobs.view(existing.id);
    return jobs.create({ kind: 'setup', title: 'Enable MCP connection', principal: localPrincipal, approval: false }, async c => {
      const result = await tailscale.enable(c, { reconnect });
      if (result.changedOrigin) oauth.revokeAll();
      c.emit('setup.message', { text: 'Checking the public connection…' });
      const health = await refreshConnection();
      c.emit('setup.message', { text: health.message });
      return { ...result, connectionHealth: health };
    });
  };
  let diagnostics = null;
  const state = () => ({
    folderPicker: typeof chooseFolder === 'function', app: 'Codex Link', version: '0.2.0', platform: process.platform, uptimeSeconds: Math.floor((Date.now() - bootAt) / 1000),
    publicOrigin: config.value.publicOrigin, mcpUrl: config.value.publicOrigin ? `${config.value.publicOrigin}/mcp` : null,
    connectionHealth,
    settings: Object.fromEntries(['remotePaused', 'autoApproveWrites', 'autoApproveShell', 'dangerousModeEnabled', 'computerAlwaysEnabled', 'funnelManaged', 'redirectUris'].map(k => [k, config.value[k]])),
    decisionsComputer: computer.decisions.settings(),
    decisionsSessions: computer.native.summary().sessions.filter(s => computer.native.sessions.get(s.id)?.owner === 'local-owner:local'),
    computerNative: { ...computer.native.summary(), replSessions: computer.repl?.summary() || [] }, computerEnabledUntil: config.value.computerEnabledUntil, workspaces: workspaces.list(),
    projectSetupComplete: !!config.value.projectSetupComplete, codexImport: codexImport.summary(),
    updates: updates.list(oauth.connections()),
    jobs: jobs.list().map(({ request, result, ...j }) => j), connections: oauth.connections(), diagnostics
  });
  const disableDangerousMode = () => {
    if (!config.value.dangerousModeEnabled) return;
    config.value.dangerousModeEnabled = false;
    config.value.autoApproveWrites = false;
    config.value.autoApproveShell = false;
  };
  async function admin(req, res) {
    securityHeaders(res);
    const host = req.headers.host;
    assert([`127.0.0.1:${actualAdminPort}`, `localhost:${actualAdminPort}`].includes(host), 'Invalid local Host', 403);
    const url = new URL(req.url, `http://127.0.0.1:${actualAdminPort}`);
    assert(!req.headers.origin || [`http://127.0.0.1:${actualAdminPort}`, `http://localhost:${actualAdminPort}`].includes(req.headers.origin), 'Invalid local Origin', 403);
    if (req.method === 'GET' && ['/', '/app.js', '/native-computer.js', '/style.css'].includes(url.pathname)) {
      const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      res.writeHead(200, { 'Content-Type': filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(readFileSync(path.join(UI, filename)));
    }
    assert(equal(req.headers['x-codex-link-admin'], adminToken), 'Open the control-panel URL printed by the app to authenticate.', 401);
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state());
    if (req.method === 'GET' && url.pathname === '/api/job') {
      const j = jobs.get(url.searchParams.get('id'));
      // The activity inspector follows the tail; explicit cursors remain available to API clients.
      const after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : Math.max(0, (j.events.at(-200)?.seq || 1) - 1);
      return json(res, 200, jobs.view(j.id, null, after, 200));
    }
    if (req.method === 'GET' && url.pathname === '/api/computer/native') return json(res, 200, { ...computer.native.summary(), replSessions: computer.repl?.summary() || [], diagnostics: await computer.native.capabilities() });
    if (req.method === 'GET' && url.pathname === '/api/computer/windows') return json(res, 200, await computer.native.windows(localPrincipal));
    if (req.method === 'GET' && url.pathname === '/api/tools') return json(res, 200, { tools: tools.list() });
    if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
      const out = { tailscale: await tailscale.status(), node: process.version, ripgrep: findExecutable('rg') };
      try { out.computer = { installed: !!pythonCommand(config) }; } catch (e) { out.computer = { installed: false, error: e.message }; }
      out.nativeComputer = await computer.native.capabilities();
      diagnostics = out; return json(res, 200, out);
    }
    assert(req.method === 'POST', 'Not found', 404);
    const body = await readBody(req, 4 * 1024 * 1024);
    switch (url.pathname) {
      case '/api/computer/openai': return json(res, 200, computer.decisions.configure(body));
      case '/api/computer/openai/run': return json(res, 200, (await tools.call('computer_api_run', body, localPrincipal)).structuredContent);
      case '/api/computer/session/start': return json(res, 200, (await tools.call('computer_session_start', body, localPrincipal)).structuredContent);
      case '/api/updates': return json(res, 200, updates.add(body, oauth.connections()));
      case '/api/updates/cancel': return json(res, 200, updates.cancel(body.id));
      case '/api/workspaces': return json(res, 200, config.addWorkspace(body.name, body.root));
      case '/api/import/codex': return json(res, 200, await codexImport.importAll());
      case '/api/project-setup/complete': {
        config.value.projectSetupComplete = true; config.save(); return json(res, 200, state());
      }
      case '/api/workspaces/choose': {
        assert(typeof chooseFolder === 'function', 'Folder picker is available in the desktop app', 400);
        const root = await chooseFolder();
        return json(res, 200, root ? config.addWorkspace('', root) : { cancelled: true });
      }
      case '/api/workspaces/remove': {
        jobs.stopAll(); computer.stop(); config.value.workspaces = config.value.workspaces.filter(w => w.name !== body.name); config.save(); return json(res, 200, {});
      }
      case '/api/settings': {
        config.patch(body);
        if (config.value.remotePaused) {
          disableDangerousMode(); jobs.stopAll(); computer.stop(); config.value.computerEnabledUntil = 0; config.value.computerAlwaysEnabled = false;
        }
        config.save(); return json(res, 200, state());
      }
      case '/api/origin': {
        const previous = config.value.publicOrigin; config.setOrigin(body.origin);
        if (previous !== config.value.publicOrigin) oauth.revokeAll(); void refreshConnection(); return json(res, 200, state());
      }
      case '/api/pair': return json(res, 200, oauth.pairTicket());
      case '/api/approve': {
        assert(typeof body.allow === 'boolean', 'allow must be boolean');
        return json(res, 200, jobs.approve(body.jobId, body.allow));
      }
      case '/api/cancel': return json(res, 200, jobs.cancel(body.jobId));
      case '/api/stop': {
        config.value.remotePaused = true; disableDangerousMode(); config.value.computerEnabledUntil = 0; config.value.computerAlwaysEnabled = false; config.save(); jobs.stopAll(); computer.stop(); audit('owner.emergency_stop'); return json(res, 200, state());
      }
      case '/api/revoke': { disableDangerousMode(); config.value.computerEnabledUntil = 0; config.value.computerAlwaysEnabled = false; config.save(); oauth.revokeAll(); jobs.stopAll(); computer.stop(); return json(res, 200, state()); }
      case '/api/dangerous': {
        assert(typeof body.enabled === 'boolean', 'enabled must be boolean');
        config.value.dangerousModeEnabled = body.enabled;
        config.value.autoApproveWrites = body.enabled;
        config.value.autoApproveShell = body.enabled;
        config.value.computerEnabledUntil = 0;
        config.value.computerAlwaysEnabled = body.enabled;
        config.save();
        if (!body.enabled) { computer.stop(); for (const j of jobs.store.data.jobs) if (['computer', 'computer_api'].includes(j.kind)) jobs.cancel(j.id); }
        if (body.enabled) for (const j of jobs.store.data.jobs) if (j.status === 'awaiting_approval' && !j.permissionRequest && j.kind !== 'computer_api') jobs.approve(j.id, true);
        audit('owner.dangerous_mode', { enabled: body.enabled }); return json(res, 200, state());
      }
      case '/api/computer/permissions': {
        assert(process.platform === 'darwin', 'This permission request is macOS-only');
        assert(Object.keys(body).length === 0, 'Unexpected permission request fields');
        audit('owner.computer_os_permission_request');
        return json(res, 200, await computer.native.invoke({ op: 'request_permissions' }, {}, { gated: false, timeoutMs: 20000 }));
      }
      case '/api/computer/policy': {
        assert(Object.keys(body).every(k => ['rules', 'legacyEnabled'].includes(k)), 'Unknown computer policy field');
        assert(Array.isArray(body.rules), 'Application rules are required');
        if (Object.hasOwn(body, 'legacyEnabled')) assert(typeof body.legacyEnabled === 'boolean', 'legacyEnabled must be boolean');
        computer.native.setRules(body.rules);
        computer.stop();
        for (const job of jobs.store.data.jobs) if (['computer', 'computer_api'].includes(job.kind)) jobs.cancel(job.id);
        if (Object.hasOwn(body, 'legacyEnabled')) config.value.computerLegacyEnabled = body.legacyEnabled;
        config.save(); audit('owner.computer_policy', { rules: body.rules.length, legacyEnabled: config.value.computerLegacyEnabled === true });
        return json(res, 200, computer.native.summary());
      }
      case '/api/computer/session/end': {
        assert(typeof body.sessionId === 'string', 'sessionId is required');
        computer.native.closeInternal(body.sessionId);
        computer.repl?.closeInternal(body.sessionId);
        audit('owner.computer_session_closed', { sessionId: body.sessionId });
        return json(res, 200, computer.native.summary());
      }
      case '/api/computer': {
        assert(typeof body.enabled === 'boolean', 'enabled must be boolean');
        if (Object.hasOwn(body, 'persistent')) assert(typeof body.persistent === 'boolean', 'persistent must be boolean');
        disableDangerousMode();
        const persistent = body.enabled && body.persistent === true;
        config.value.computerAlwaysEnabled = persistent;
        config.value.computerEnabledUntil = body.enabled && !persistent ? Date.now() + 15 * 60 * 1000 : 0; config.save();
        if (!body.enabled) { computer.stop(); for (const j of jobs.store.data.jobs) if (['computer', 'computer_api'].includes(j.kind)) jobs.cancel(j.id); }
        audit('owner.computer_permission', { enabled: body.enabled, persistent }); return json(res, 200, state());
      }
      case '/api/tailscale/enable': {
        return json(res, 200, enableConnection(true));
      }
      case '/api/tailscale/disable': {
        const result = await tailscale.disable(); config.value.publicOrigin = ''; disableDangerousMode(); config.value.computerEnabledUntil = 0; config.value.computerAlwaysEnabled = false; config.save(); oauth.revokeAll(); jobs.stopAll(); computer.stop();
        void refreshConnection();
        return json(res, 200, result);
      }
      default: throw new HttpError(404, 'Not found');
    }
  }
  async function remote(req, res) {
    // Record discovery outcomes without credentials, query strings, or request bodies.
    // A local health check alone cannot show whether an MCP client reached us.
    const discoveryPath = req.url.split('?')[0];
    if (['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration', '/mcp'].includes(discoveryPath) && !req.headers.authorization) {
      res.once('finish', () => audit('oauth.discovery', { method: req.method, path: discoveryPath, status: res.statusCode }));
    }
    securityHeaders(res);
    const origin = config.value.publicOrigin;
    const allowedHost = origin ? new URL(origin).host : '';
    assert([allowedHost, `127.0.0.1:${actualPublicPort}`, `localhost:${actualPublicPort}`].includes(req.headers.host), 'Invalid Host header', 403);
    const url = new URL(req.url, origin || `http://127.0.0.1:${actualPublicPort}`);
    assert(!req.headers.origin || [origin, 'https://chatgpt.com'].includes(req.headers.origin), 'Invalid Origin header', 403);
    if (origin.startsWith('https:')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    // Ignore forwarded identity headers. Funnel is a public transport, not the authorization authority.
    limiter.check(url.pathname === '/mcp' ? `mcp:${hash(req.headers.authorization || '')}` : `auth:${url.pathname}`, url.pathname === '/mcp' ? 600 : 60);
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, service: 'codex-link' });
    if (req.method === 'GET' && url.pathname === '/') return html(res, 200, '<!doctype html><html lang="en"><meta charset="utf-8"><title>Codex Link</title><h1>Codex Link</h1><p>This is an OAuth-protected MCP endpoint. Its owner control panel is not exposed here.</p></html>');
    assert(origin, 'Public origin is not configured. Use the local setup panel.', 503);
    if (url.pathname === '/mcp') return handleMcp(req, res, services);
    return oauth.handle(req, res, url);
  }
  function guard(handler) {
    return (req, res) => Promise.resolve().then(() => handler(req, res)).catch(e => {
      if (res.headersSent) { res.destroy(); return; }
      const status = e.status || 500;
      if (status === 500) console.error(safeError(e));
      json(res, status, { error: e.code || 'server_error', error_description: status === 500 ? 'Internal error; inspect the local app console' : e.message });
    });
  }
  const adminServer = http.createServer({ requestTimeout: 30000, headersTimeout: 15000, maxHeaderSize: 16384 }, guard(admin));
  const publicServer = http.createServer({ requestTimeout: 30000, headersTimeout: 15000, maxHeaderSize: 16384 }, guard(remote));
  try {
    actualAdminPort = await listen(adminServer, actualAdminPort); actualPublicPort = await listen(publicServer, actualPublicPort);
  } catch (e) { await close(adminServer); await close(publicServer); throw e; }
  config.value.adminPort = actualAdminPort; config.value.publicPort = actualPublicPort; config.save();
  if (autoEnableConnection && (!config.value.publicOrigin || config.value.funnelManaged)) enableConnection();
  else if (autoEnableConnection) void refreshConnection();
  if (autoEnableConnection) { healthTimer = setInterval(() => { if (!jobs.list().some(j => j.kind === 'setup' && ['queued', 'running'].includes(j.status))) void refreshConnection(); }, 30000); healthTimer.unref(); }
  audit('bridge.started', { adminPort: actualAdminPort, publicPort: actualPublicPort });
  return { ...services, state, adminToken, adminPort: actualAdminPort, publicPort: actualPublicPort,
    adminUrl: `http://127.0.0.1:${actualAdminPort}/#token=${adminToken}`,
    async close() { clearInterval(healthTimer); ++healthGeneration; healthController?.abort(); config.value.computerEnabledUntil = 0; computer.stop(); await jobs.close(); await Promise.all([close(adminServer), close(publicServer)]); audit('bridge.stopped'); }
  };
}
