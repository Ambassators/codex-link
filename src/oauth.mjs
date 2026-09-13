import path from 'node:path';
import { Store, id, hash, challenge, equal, now, assert, HttpError, json, html, redirect, escapeHtml, cookies, readBody, singleQuery } from './util.mjs';
import { SCOPES, DEFAULT_SCOPES } from './config.mjs';

const COOKIE = '__Secure-codex_link_owner';
// null explicitly means no time limit; missing/malformed expirations fail closed.
const expired = (row, t = now()) => row.exp !== null && (!Number.isFinite(row.exp) || row.exp <= t);
function page(title, content) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Codex Link</title><style>body{font:16px/1.6 system-ui;background:#111820;color:#e9f0f5;max-width:620px;margin:10vh auto;padding:28px}h1{line-height:1.15}button{padding:13px 22px;border:0;border-radius:8px;margin:10px 10px 0 0;cursor:pointer;font:inherit;background:#9de8cb;color:#12211c}code{overflow-wrap:anywhere}a{color:#9de8cb}.subtle{color:#aab8c4}li{margin:8px 0}</style><h1>${escapeHtml(title)}</h1>${content}</html>`;
}
const LABELS = {
  'bridge:read': 'View bridge status and this connection’s jobs',
  'files:read': 'Read and search approved project folders',
  'files:write': 'Create and modify files in approved project folders',
  'shell:execute': 'Run shell or PowerShell commands as your OS user (not a sandbox)',
  'computer:use': 'View and operate your desktop while the local computer-control switch is enabled',
};
export class OAuth {
  constructor(config, audit = () => {}) {
    this.config = config; this.audit = audit;
    this.store = new Store(path.join(config.home, 'oauth.json'), { clients: {}, codes: {}, tokens: {}, refresh: {}, grants: {} });
    this.migratePermanentTokens();
    this.tickets = new Map(); this.owners = new Map(); this.pending = new Map();
  }
  migratePermanentTokens() {
    const d = this.store.data;
    if (d.permanentTokensVersion === 1) return;
    const t = now(), migrated = new Set();
    for (const grant of Object.values(d.grants)) {
      if (grant.revoked || expired(grant, t) || grant.issuer !== this.issuer || grant.resource !== this.resource) continue;
      grant.exp = null; migrated.add(grant.id);
    }
    // Keep saved access tokens usable for still-authorized connections, even
    // when their old one-hour lifetime has elapsed. Never revive revoked grants.
    for (const token of Object.values(d.tokens)) if (migrated.has(token.grant)) token.exp = null;
    for (const token of Object.values(d.refresh)) {
      if (migrated.has(token.grant) && !expired(token, t)) token.exp = null;
    }
    d.permanentTokensVersion = 1; this.store.save();
  }
  get issuer() { return this.config.value.publicOrigin; }
  get resource() { return `${this.issuer}/mcp`; }
  metadata() {
    return {
      issuer: this.issuer, authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`, registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`, response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      authorization_response_iss_parameter_supported: true, scopes_supported: SCOPES
    };
  }
  resourceMetadata() { return { resource: this.resource, authorization_servers: [this.issuer], scopes_supported: SCOPES, bearer_methods_supported: ['header'], resource_name: 'Codex Link' }; }
  cleanup() {
    const t = now(), d = this.store.data;
    for (const [k, v] of Object.entries(d.codes)) if (v.exp <= t) delete d.codes[k];
    for (const table of [d.tokens, d.refresh]) for (const [k, v] of Object.entries(table)) if (expired(v, t)) delete table[k];
    // Never expire a client that the owner has authorized: ChatGPT reuses its DCR client across reauthorization.
    for (const [k, v] of Object.entries(d.clients)) if (!v.authorizedAt && v.created + 86400 < t && !Object.values(d.grants).some(g => g.client_id === k)) delete d.clients[k];
    for (const [k, v] of Object.entries(d.grants)) if (expired(v, t)) delete d.grants[k];
    for (const table of [this.tickets, this.owners, this.pending]) for (const [k, v] of table) if (v.exp <= t) table.delete(k);
  }
  register(body) {
    this.cleanup();
    const d = this.store.data;
    assert(Object.keys(d.clients).length < 100, 'Client registry is full. Unused registrations expire after 24 hours; authorized client registrations are retained.', 429);
    assert(Array.isArray(body.redirect_uris) && body.redirect_uris.length > 0 && body.redirect_uris.length <= 10, 'redirect_uris required');
    for (const uri of body.redirect_uris) assert(this.config.value.redirectUris.includes(uri), 'Redirect URI is not allowlisted. Add the exact URI in the local control panel.');
    const method = body.token_endpoint_auth_method || 'client_secret_basic';
    assert(['none', 'client_secret_post', 'client_secret_basic'].includes(method), 'Unsupported client authentication');
    assert(!body.grant_types || (Array.isArray(body.grant_types) && body.grant_types.every(t => ['authorization_code', 'refresh_token'].includes(t))), 'Unsupported grant type');
    assert(!body.response_types || (Array.isArray(body.response_types) && body.response_types.length === 1 && body.response_types[0] === 'code'), 'Only code responses are supported');
    const client_id = id(), secret = method === 'none' ? null : id(48);
    const client = { client_id, client_name: String(body.client_name || 'MCP client').slice(0, 120), redirect_uris: [...new Set(body.redirect_uris)], token_endpoint_auth_method: method, created: now(), secretHash: secret ? hash(secret) : null };
    d.clients[client_id] = client; this.store.save();
    this.audit('oauth.registered', { client_id, client_name: client.client_name });
    return { client_id, client_id_issued_at: client.created, client_name: client.client_name, redirect_uris: client.redirect_uris, token_endpoint_auth_method: method, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}) };
  }
  pairTicket() {
    assert(this.issuer, 'Configure the HTTPS origin first'); this.cleanup();
    const ticket = id(); this.tickets.set(hash(ticket), { exp: now() + 90 });
    return { url: `${this.issuer}/oauth/pair#ticket=${ticket}`, expiresIn: 90 };
  }
  pair(ticket) {
    const k = hash(String(ticket || '')), value = this.tickets.get(k);
    assert(value && value.exp > now(), 'Pairing link expired or already used', 403);
    this.tickets.delete(k);
    const session = id(); this.owners.set(hash(session), { exp: now() + 12 * 3600 });
    this.audit('oauth.browser_paired', {}); return session;
  }
  owner(req) {
    const cookie = cookies(req)[COOKIE]; if (!cookie) return null;
    const key = hash(cookie), value = this.owners.get(key);
    return value && value.exp > now() ? key : null;
  }
  authorization(query, owner) {
    this.cleanup(); const c = Object.hasOwn(this.store.data.clients, query.client_id) ? this.store.data.clients[query.client_id] : null;
    assert(c, 'Unknown OAuth client');
    assert(c.redirect_uris.includes(query.redirect_uri) && this.config.value.redirectUris.includes(query.redirect_uri), 'Redirect URI is not allowed');
    assert(query.response_type === 'code', 'Only authorization-code flow is supported');
    assert(query.code_challenge_method === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(query.code_challenge || ''), 'PKCE S256 is required');
    assert(query.resource === this.resource, 'Resource must exactly match protected resource metadata');
    assert(typeof query.state === 'string' && query.state.length >= 1 && query.state.length <= 2048, 'A bounded state parameter is required');
    const scopes = [...new Set((query.scope || DEFAULT_SCOPES.join(' ')).split(' ').filter(Boolean))];
    assert(scopes.length > 0 && scopes.every(s => SCOPES.includes(s)), 'Unknown or empty scope');
    if (!owner) return { paired: false };
    assert(this.pending.size < 100, 'Too many authorization requests', 429);
    const requestId = id(), csrf = id();
    this.pending.set(requestId, { ...query, scopes, owner, csrf, exp: now() + 300 });
    return { paired: true, requestId, csrf, name: c.client_name, redirect: query.redirect_uri, scopes };
  }
  consent(body, owner) {
    const pending = this.pending.get(body.request_id);
    assert(pending && pending.exp > now() && owner && equal(pending.owner, owner) && equal(pending.csrf, body.csrf), 'Invalid or expired consent request', 403);
    this.pending.delete(body.request_id);
    const target = new URL(pending.redirect_uri);
    target.searchParams.set('state', pending.state); target.searchParams.set('iss', this.issuer);
    if (body.decision !== 'allow') { target.searchParams.set('error', 'access_denied'); return target.href; }
    const code = id();
    this.store.data.clients[pending.client_id].authorizedAt = now();
    this.store.data.codes[hash(code)] = { client_id: pending.client_id, redirect_uri: pending.redirect_uri, resource: pending.resource, issuer: this.issuer, challenge: pending.code_challenge, scopes: pending.scopes, exp: now() + 60 };
    this.store.save(); target.searchParams.set('code', code);
    this.audit('oauth.authorized', { client_id: pending.client_id, scopes: pending.scopes });
    return target.href;
  }
  authenticateClient(body, authorization) {
    let clientId = body.client_id, secret = body.client_secret, method = secret === undefined ? 'none' : 'client_secret_post';
    if (authorization) {
      assert(/^Basic [A-Za-z0-9+/=]+$/.test(authorization), 'Invalid client authentication', 401);
      assert(secret === undefined, 'Multiple client authentication methods', 401);
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8'), i = decoded.indexOf(':');
      assert(i > 0, 'Malformed Basic authentication', 401);
      const decode = s => decodeURIComponent(s.replace(/\+/g, ' '));
      const basicId = decode(decoded.slice(0, i));
      assert(!clientId || clientId === basicId, 'Mismatched client id', 401);
      clientId = basicId; secret = decode(decoded.slice(i + 1)); method = 'client_secret_basic';
    }
    const client = Object.hasOwn(this.store.data.clients, clientId) ? this.store.data.clients[clientId] : null;
    if (!client || client.token_endpoint_auth_method !== method || (method !== 'none' && !equal(hash(String(secret)), client.secretHash))) throw new HttpError(401, 'Client authentication failed', 'invalid_client');
    return client;
  }
  issue(grant) {
    const access = id(48), refresh = id(48);
    this.store.data.tokens[hash(access)] = { grant: grant.id, exp: null };
    this.store.data.refresh[hash(refresh)] = { grant: grant.id, exp: grant.exp, used: false };
    this.store.save();
    // OAuth expires_in is omitted because access tokens have no expiration.
    return { access_token: access, token_type: 'Bearer', refresh_token: refresh, scope: grant.scopes.join(' ') };
  }
  token(body, authorization) {
    this.cleanup(); const d = this.store.data, client = this.authenticateClient(body, authorization);
    if (body.grant_type === 'authorization_code') {
      const key = hash(String(body.code || '')), code = d.codes[key];
      if (!code || code.exp <= now() || code.client_id !== client.client_id) throw new HttpError(400, 'Invalid authorization code', 'invalid_grant');
      const valid = code.redirect_uri === body.redirect_uri && code.resource === body.resource && code.issuer === this.issuer && /^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier || '') && equal(challenge(body.code_verifier), code.challenge);
      delete d.codes[key]; this.store.save();
      if (!valid) throw new HttpError(400, 'PKCE, redirect, or resource mismatch', 'invalid_grant');
      const grant = { id: id(), client_id: client.client_id, scopes: code.scopes, issuer: code.issuer, resource: code.resource, created: now(), exp: null, revoked: false };
      d.grants[grant.id] = grant; return this.issue(grant);
    }
    if (body.grant_type === 'refresh_token') {
      const refresh = d.refresh[hash(String(body.refresh_token || ''))], grant = refresh && d.grants[refresh.grant];
      if (!grant || grant.client_id !== client.client_id || grant.revoked || expired(refresh) || expired(grant) || grant.issuer !== this.issuer) throw new HttpError(400, 'Invalid refresh token', 'invalid_grant');
      if (refresh.used) { grant.revoked = true; this.store.save(); this.audit('oauth.refresh_replay', { grant: grant.id }); throw new HttpError(400, 'Refresh token reuse: authorization revoked', 'invalid_grant'); }
      if (body.resource !== grant.resource) throw new HttpError(400, 'Resource mismatch', 'invalid_target');
      if (body.scope && body.scope.split(' ').filter(Boolean).some(s => !grant.scopes.includes(s))) throw new HttpError(400, 'Scope escalation is not allowed', 'invalid_scope');
      // Narrowing is deliberately not supported; do not silently broaden a requested scope.
      if (body.scope && [...new Set(body.scope.split(' ').filter(Boolean))].sort().join(' ') !== [...grant.scopes].sort().join(' ')) throw new HttpError(400, 'Reauthorize to change scopes', 'invalid_scope');
      refresh.used = true; return this.issue(grant);
    }
    throw new HttpError(400, 'Unsupported grant type', 'unsupported_grant_type');
  }
  verify(header, scopes = []) {
    if (!/^Bearer [A-Za-z0-9_-]+$/i.test(header || '')) throw new HttpError(401, 'Bearer token required', 'invalid_token');
    const token = this.store.data.tokens[hash(header.slice(7))], grant = token && this.store.data.grants[token.grant];
    if (!token || expired(token) || !grant || expired(grant) || grant.revoked || grant.issuer !== this.issuer || grant.resource !== this.resource) throw new HttpError(401, 'Invalid or expired bearer token', 'invalid_token');
    if (scopes.some(s => !grant.scopes.includes(s))) throw new HttpError(403, 'Insufficient OAuth scope', 'insufficient_scope');
    return { clientId: grant.client_id, grantId: grant.id, scopes: grant.scopes };
  }
  require(principal, scopes) { if (scopes.some(s => !principal.scopes.includes(s))) throw new HttpError(403, 'Insufficient OAuth scope', 'insufficient_scope'); }
  revoke(body, authorization) {
    const client = this.authenticateClient(body, authorization), d = this.store.data, key = hash(String(body.token || ''));
    const row = d.tokens[key] || d.refresh[key], grant = row && d.grants[row.grant];
    if (grant?.client_id === client.client_id) { grant.revoked = true; this.store.save(); }
  }
  revokeAll() {
    for (const g of Object.values(this.store.data.grants)) g.revoked = true;
    this.store.data.codes = {}; this.owners.clear(); this.tickets.clear(); this.pending.clear(); this.store.save();
    this.audit('oauth.revoked_all', {});
  }
  connections() {
    this.cleanup();
    return Object.values(this.store.data.grants).filter(g => !g.revoked).map(g => ({ id: g.id, name: this.store.data.clients[g.client_id]?.client_name, scopes: g.scopes, created: g.created, expires: g.exp }));
  }
  async handle(req, res, url) {
    const route = url.pathname;
    if (req.method === 'GET' && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(route)) return json(res, 200, this.resourceMetadata());
    if (req.method === 'GET' && route === '/.well-known/oauth-authorization-server') return json(res, 200, this.metadata());
    if (req.method === 'POST' && route === '/oauth/register') return json(res, 201, this.register(await readBody(req, 16384)));
    if (req.method === 'POST' && route === '/oauth/token') return json(res, 200, this.token(await readBody(req, 16384, true), req.headers.authorization));
    if (req.method === 'POST' && route === '/oauth/revoke') { this.revoke(await readBody(req, 16384, true), req.headers.authorization); return json(res, 200, {}); }
    if (req.method === 'GET' && route === '/oauth/pair') return html(res, 200, page('Pair this browser', '<p id="status">Pairing with your local Codex Link control panel…</p><script src="/oauth/pair.js"></script>'));
    if (req.method === 'GET' && route === '/oauth/pair.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      return res.end(`const ticket=new URLSearchParams(location.hash.slice(1)).get('ticket');history.replaceState(null,'','/oauth/pair');fetch('/oauth/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})}).then(async r=>{if(!r.ok)throw Error((await r.json()).error_description);location.replace('/oauth/ready')}).catch(e=>{document.getElementById('status').textContent=e.message});`);
    }
    if (req.method === 'POST' && route === '/oauth/pair') {
      assert(req.headers.origin === this.issuer, 'Invalid pairing origin', 403);
      const session = this.pair((await readBody(req, 4096)).ticket);
      return json(res, 200, { paired: true }, { 'Set-Cookie': `${COOKIE}=${session}; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=43200` });
    }
    if (req.method === 'GET' && route === '/oauth/ready') return html(res, 200, page('Browser paired', '<p>Return to ChatGPT and connect Codex Link. On the authorization page, review the permissions and select <strong>Authorize</strong>. If that page is already open, reload it.</p><p class="subtle">Pairing lasts 12 hours and ends when Codex Link restarts. This verifies ownership of this computer.</p>'));
    if (req.method === 'GET' && route === '/oauth/authorize') {
      const auth = this.authorization(singleQuery(url), this.owner(req));
      if (!auth.paired) return html(res, 200, page('Owner verification required', '<p>In the local Codex Link control panel, select <strong>Verify my browser</strong>. Open the pairing link in this browser, then reload this page.</p><p>Only the computer’s owner can authorize a connection. There is no public signup or default password.</p>'));
      // Preserve Origin on the same-origin consent POST while hiding referrers from other sites.
      res.setHeader('Referrer-Policy', 'same-origin');
      // Chromium applies form-action to the final redirect too; allow only this validated callback origin.
      res.setHeader('Content-Security-Policy', String(res.getHeader('Content-Security-Policy')).replace("form-action 'self'", "form-action 'self' " + new URL(auth.redirect).origin));
      return html(res, 200, page('Authorize Codex Link', `<p><strong>${escapeHtml(auth.name)}</strong> requests access to this computer:</p><ul>${auth.scopes.map(s => `<li>${escapeHtml(LABELS[s])}</li>`).join('')}</ul><p class="subtle">Return address: <code>${escapeHtml(auth.redirect)}</code></p><p>Shell commands can access your OS account. Approve only a connection you initiated.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${auth.requestId}"><input type="hidden" name="csrf" value="${auth.csrf}"><button name="decision" value="allow">Authorize</button><button name="decision" value="deny">Deny</button></form>`));
    }
    if (req.method === 'POST' && route === '/oauth/authorize') {
      assert(req.headers.origin === this.issuer, 'Invalid consent origin', 403);
      const destination = this.consent(await readBody(req, 8192, true), this.owner(req));
      res.setHeader('Content-Security-Policy', String(res.getHeader('Content-Security-Policy')).replace("form-action 'self'", "form-action 'self' " + new URL(destination).origin));
      return redirect(res, destination);
    }
    throw new HttpError(404, 'Not found');
  }
}
