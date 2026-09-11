import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Config } from '../src/config.mjs';
import { id, challenge } from '../src/util.mjs';
export function fixture(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'codex-link-test-')), home = path.join(base, 'state'), root = path.join(base, 'project');
  mkdirSync(root); const config = new Config(home); config.addWorkspace('project', root); config.setOrigin('https://machine.example.ts.net');
  t.after(() => rmSync(base, { recursive: true, force: true })); return { base, home, root, config };
}
export function register(oauth, scope = 'bridge:read files:read files:write shell:execute computer:use') {
  const client = oauth.register({ redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'none', client_name: 'Test client' });
  const verifier = id(48), ticket = oauth.pairTicket().url.split('ticket=')[1], ownerCookie = oauth.pair(ticket);
  const owner = oauth.owner({ headers: { cookie: `__Secure-codex_link_owner=${ownerCookie}` } });
  const request = oauth.authorization({ client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code', state: 'test-state', resource: oauth.resource, scope, code_challenge_method: 'S256', code_challenge: challenge(verifier) }, owner);
  const url = new URL(oauth.consent({ request_id: request.requestId, csrf: request.csrf, decision: 'allow' }, owner));
  const params = { grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], resource: oauth.resource, code: url.searchParams.get('code'), code_verifier: verifier };
  return { client, owner, ownerCookie, params, url, tokens: () => oauth.token(params) };
}
export async function waitJob(jobs, jobId, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const j = jobs.get(jobId); if (!['queued', 'running', 'awaiting_approval'].includes(j.status)) return j; await new Promise(r => setTimeout(r, 20)); }
  throw Error(`Job timeout: ${JSON.stringify(jobs.view(jobId))}`);
}
