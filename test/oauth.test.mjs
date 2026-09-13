import test from 'node:test';
import assert from 'node:assert/strict';
import { OAuth } from '../src/oauth.mjs';
import { hash, id, challenge, now } from '../src/util.mjs';
import { fixture, register } from './helpers.mjs';

test('OAuth discovery uses canonical issuer and resource, S256 and DCR', t => {
  const { config } = fixture(t), oauth = new OAuth(config);
  assert.equal(oauth.resourceMetadata().resource, 'https://machine.example.ts.net/mcp');
  assert.deepEqual(oauth.metadata().code_challenge_methods_supported, ['S256']);
  assert.equal(oauth.metadata().authorization_response_iss_parameter_supported, true);
  assert.ok(!oauth.metadata().client_id_metadata_document_supported);
});
test('complete owner-paired authorization, issuer echo, bearer and code single-use', t => {
  const { config } = fixture(t), oauth = new OAuth(config), r = register(oauth), token = r.tokens();
  assert.equal(r.url.searchParams.get('iss'), oauth.issuer);
  assert.equal(r.url.searchParams.get('state'), 'test-state');
  assert.equal(oauth.verify(`Bearer ${token.access_token}`).clientId, r.client.client_id);
  assert.throws(() => r.tokens(), /Invalid authorization code/);
  assert.ok(!JSON.stringify(oauth.store.data).includes(token.access_token));
  assert.ok(!JSON.stringify(oauth.store.data).includes(token.refresh_token));
});
test('unpaired browser cannot approve and pairing tickets are single-use', t => {
  const { config } = fixture(t), oauth = new OAuth(config);
  const ticket = oauth.pairTicket().url.split('ticket=')[1]; oauth.pair(ticket);
  assert.throws(() => oauth.pair(ticket), /expired or already used/);
  const r = register(oauth); assert.throws(() => oauth.consent({ request_id: 'unknown', csrf: 'wrong', decision: 'allow' }, r.owner), /Invalid or expired/);
});
test('reject non-allowlisted redirects, PKCE downgrade and scope escalation', t => {
  const { config } = fixture(t), oauth = new OAuth(config);
  assert.throws(() => oauth.register({ redirect_uris: ['https://evil.example/callback'], token_endpoint_auth_method: 'none' }), /not allowlisted/);
  const r = register(oauth); r.params.code_verifier = id(48); assert.throws(() => r.tokens(), /PKCE/);
  const next = register(oauth, 'bridge:read'), token = next.tokens();
  assert.throws(() => oauth.verify(`Bearer ${token.access_token}`, ['shell:execute']), /Insufficient/);
});
test('resource binding rejects an intercepted code sent to another audience', t => {
  const { config } = fixture(t), oauth = new OAuth(config), r = register(oauth);
  r.params.resource = 'https://evil.example/mcp'; assert.throws(() => r.tokens(), /mismatch/);
});
test('refresh rotation detects replay and immediately revokes the entire family', t => {
  const { config } = fixture(t), oauth = new OAuth(config), r = register(oauth), first = r.tokens();
  const body = { grant_type: 'refresh_token', client_id: r.client.client_id, resource: oauth.resource, refresh_token: first.refresh_token };
  const second = oauth.token(body); assert.notEqual(first.refresh_token, second.refresh_token);
  assert.ok(oauth.verify(`Bearer ${second.access_token}`));
  assert.throws(() => oauth.token(body), /reuse/);
  assert.throws(() => oauth.verify(`Bearer ${second.access_token}`), /Invalid or expired/);
});
test('opaque grants persist across restart, while owner browser sessions do not', t => {
  const { config } = fixture(t), oauth = new OAuth(config), r = register(oauth), token = r.tokens();
  const restarted = new OAuth(config); assert.ok(restarted.verify(`Bearer ${token.access_token}`));
  assert.equal(restarted.owner({ headers: { cookie: `__Secure-codex_link_owner=${r.ownerCookie}` } }), null);
  restarted.revokeAll(); assert.throws(() => restarted.verify(`Bearer ${token.access_token}`), /Invalid or expired/);
});
test('access and refresh tokens have no time limit, survive cleanup and restart, and remain revocable', t => {
  const { config } = fixture(t), oauth = new OAuth(config), r = register(oauth), first = r.tokens();
  assert.equal(Object.hasOwn(first, 'expires_in'), false);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 100 * 365 * 86400000 });
  const restarted = new OAuth(config); restarted.cleanup();
  assert.equal(restarted.verify(`Bearer ${first.access_token}`).clientId, r.client.client_id);
  assert.equal(restarted.connections()[0].expires, null);
  const second = restarted.token({ grant_type: 'refresh_token', client_id: r.client.client_id, resource: restarted.resource, refresh_token: first.refresh_token });
  assert.equal(Object.hasOwn(second, 'expires_in'), false);
  assert.ok(restarted.verify(`Bearer ${second.access_token}`));
  restarted.revoke({ client_id: r.client.client_id, token: second.refresh_token });
  assert.throws(() => restarted.verify(`Bearer ${first.access_token}`), /Invalid or expired/);
  assert.throws(() => restarted.verify(`Bearer ${second.access_token}`), /Invalid or expired/);
  assert.throws(() => restarted.token({ grant_type: 'refresh_token', client_id: r.client.client_id, resource: restarted.resource, refresh_token: second.refresh_token }), /Invalid refresh token/);
});
test('legacy migration preserves active connections without reviving revoked, expired, or differently bound grants', t => {
  const { config } = fixture(t), oauth = new OAuth(config), rows = [];
  for (const state of ['active', 'revoked', 'expired', 'other-issuer', 'other-resource']) {
    const r = register(oauth), token = r.tokens(), access = oauth.store.data.tokens[hash(token.access_token)];
    const grant = oauth.store.data.grants[access.grant];
    rows.push({ r, token, grant, access, state });
  }
  for (const { access, grant, token, state } of rows) {
    access.exp = now() - 3600;
    grant.exp = state === 'expired' ? now() - 1 : now() + 86400;
    grant.revoked = state === 'revoked';
    if (state === 'other-issuer') grant.issuer = 'https://other.example';
    if (state === 'other-resource') grant.resource += '/other';
    oauth.store.data.refresh[hash(token.refresh_token)].exp = grant.exp;
  }
  const used = id();
  oauth.store.data.refresh[hash(used)] = { grant: rows[0].grant.id, exp: now() + 86400, used: true };
  delete oauth.store.data.permanentTokensVersion; oauth.store.save();
  const restarted = new OAuth(config); restarted.cleanup();
  assert.ok(restarted.verify(`Bearer ${rows[0].token.access_token}`));
  for (const row of rows.slice(1)) assert.throws(() => restarted.verify(`Bearer ${row.token.access_token}`), /Invalid or expired/);
  const active = rows[0];
  assert.ok(restarted.token({ grant_type: 'refresh_token', client_id: active.r.client.client_id, resource: restarted.resource, refresh_token: active.token.refresh_token }).access_token);
  assert.throws(() => restarted.token({ grant_type: 'refresh_token', client_id: active.r.client.client_id, resource: restarted.resource, refresh_token: used }), /reuse/);
  const again = new OAuth(config);
  assert.throws(() => again.verify(`Bearer ${active.token.access_token}`), /Invalid or expired/);
});
test('confidential DCR clients require the registered authentication method', t => {
  const { config } = fixture(t), oauth = new OAuth(config);
  const c = oauth.register({ redirect_uris: config.value.redirectUris, token_endpoint_auth_method: 'client_secret_basic' });
  assert.throws(() => oauth.authenticateClient({ client_id: c.client_id }), /authentication failed/);
  const header = `Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64')}`;
  assert.equal(oauth.authenticateClient({}, header).client_id, c.client_id);
  assert.throws(() => oauth.authenticateClient({ client_secret: c.client_secret }, header), /Multiple client/);
});
test('expired access token and changed issuer are rejected', t => {
  const { config } = fixture(t), oauth = new OAuth(config), r = register(oauth), token = r.tokens();
  oauth.store.data.tokens[hash(token.access_token)].exp = 0;
  assert.throws(() => oauth.verify(`Bearer ${token.access_token}`), /Invalid or expired/);
  const second = register(oauth).tokens(); config.setOrigin('https://new.example.ts.net');
  assert.throws(() => oauth.verify(`Bearer ${second.access_token}`), /Invalid or expired/);
});

test('prototype property names are never treated as registered OAuth clients', t => {
  const { config } = fixture(t), oauth = new OAuth(config);
  for (const client_id of ['__proto__', 'constructor', 'toString']) {
    assert.throws(() => oauth.authorization({ client_id }, null), /Unknown OAuth client/);
    assert.throws(() => oauth.authenticateClient({ client_id }), /Client authentication failed/);
  }
});

test('DCR clients remain valid after authorization revocation and token expiry', t => {
  const { config } = fixture(t), oauth = new OAuth(config), r = register(oauth); r.tokens();
  const c = oauth.store.data.clients[r.client.client_id]; c.created -= 40 * 86400;
  oauth.revokeAll(); oauth.store.data.grants = {}; oauth.cleanup();
  assert.equal(oauth.authenticateClient({ client_id: c.client_id }).client_id, c.client_id);
});
test('removed engine scopes are never advertised', t => {
  const { config } = fixture(t), oauth = new OAuth(config);
  config.value.allowAdvanced = true;
  assert.ok(oauth.metadata().scopes_supported.every(s => !s.startsWith('codex:')));
  assert.ok(oauth.resourceMetadata().scopes_supported.every(s => !s.startsWith('codex:')));
});
