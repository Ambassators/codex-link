import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPublicConnection, resolvePublicAddresses, isPublicAddress } from '../src/connection-health.mjs';

const origin = 'https://fixture.tail-test.ts.net';
test('missing public DNS cannot be mistaken for a healthy private route', async () => {
  let probed = false;
  const health = await checkPublicConnection(origin, { resolve: async () => [], probe: async () => { probed = true; return true; } });
  assert.equal(health.status, 'dns_missing'); assert.equal(probed, false);
});
test('a public DNS record alone is not proof that the bridge is reachable', async () => {
  assert.equal((await checkPublicConnection(origin, { resolve: async () => ['203.0.113.1'], probe: async () => false })).status, 'unreachable');
  assert.equal((await checkPublicConnection(origin, { resolve: async () => ['203.0.113.1'], probe: async () => { throw new Error('TLS failure'); } })).status, 'unreachable');
});
test('a working public route is accepted when another ingress fails', async () => {
  const attempts = [];
  const health = await checkPublicConnection(origin, { resolve: async () => ['203.0.113.1', '203.0.113.2'], probe: async (url, address) => {
    attempts.push([url, address]); return address.endsWith('.2');
  } });
  assert.equal(health.status, 'ready'); assert.equal(attempts.length, 2);
});
test('resolver failures are unknown rather than a claim that DNS is missing', async () => {
  const health = await checkPublicConnection(origin, { resolve: async () => { throw new Error('Offline'); } });
  assert.equal(health.status, 'unknown');
});
test('public DNS queries ignore private answers and tolerate a failed resolver', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(String(url));
    if (url.hostname === 'dns.google') throw new Error('Offline');
    return { ok: true, json: async () => ({ Status: 0, Answer: [{ type: 1, data: '100.105.180.60' }, { type: 1, data: '127.0.0.1' }, { type: 1, data: '203.0.113.1' }, { type: 28, data: '2606:4700::1111' }] }) };
  });
  assert.deepEqual(await resolvePublicAddresses('fixture.tail-test.ts.net'), ['203.0.113.1', '2606:4700::1111']);
  assert.equal(urls.length, 4); assert.ok(urls.every(url => url.includes('name=fixture.tail-test.ts.net')));
  for (const address of ['::1', '::ffff:127.0.0.1', 'fd7a:115c:a1e0::1', 'fe80::1', '192.168.1.1', '172.16.0.1']) assert.equal(isPublicAddress(address), false);
});
