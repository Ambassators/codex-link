import https from 'node:https';
import { isIP } from 'node:net';

// Public resolvers are essential: MagicDNS can resolve an unpublished Funnel
// hostname to the local machine, making an ordinary fetch falsely pass.
export async function resolvePublicAddresses(hostname, { signal } = {}) {
  const results = await Promise.allSettled([
    'https://dns.google/resolve', 'https://cloudflare-dns.com/dns-query'
  ].flatMap(endpoint => ['A', 'AAAA'].map(async type => {
    const url = new URL(endpoint); url.searchParams.set('name', hostname); url.searchParams.set('type', type);
    const response = await fetch(url, { headers: { Accept: 'application/dns-json' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`DNS service returned HTTP ${response.status}`);
    const data = await response.json();
    if (![0, 3].includes(data.Status)) throw new Error('Public DNS lookup failed');
    return (data.Answer || []).filter(a => [1, 28].includes(a.type)).map(a => a.data);
  })));
  if (signal?.aborted) throw signal.reason;
  const answers = results.filter(r => r.status === 'fulfilled');
  if (!answers.length) throw new Error('Could not reach public DNS services. Check your internet connection.');
  return [...new Set(answers.flatMap(r => r.value))].filter(isPublicAddress);
}

export function isPublicAddress(address) {
  if (isIP(address) === 6) return !/^(::|f[cd]|fe[89ab])/i.test(address);
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 100 && b >= 64 && b <= 127)
    && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
    && !(a === 198 && [18, 19].includes(b));
}

export function probePublicAddress(origin, address, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL('/healthz', origin);
    // Pin the public answer while retaining the hostname for Host/SNI and TLS
    // certificate verification. Never fall back to the system's private DNS.
    const request = https.get(url, { signal, agent: false, lookup: (_host, options, callback) => {
      const family = isIP(address);
      callback(null, options.all ? [{ address, family }] : address, family);
    } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 8192) request.destroy(new Error('Unexpected health response')); });
      response.on('error', reject);
      response.on('end', () => {
        try { const data = JSON.parse(body); resolve(response.statusCode === 200 && data.ok === true && data.service === 'codex-link'); }
        catch { resolve(false); }
      });
    });
    const timeout = setTimeout(() => request.destroy(new Error('Public connection timed out')), 7000);
    request.on('close', () => clearTimeout(timeout)); request.on('error', reject);
  });
}

export async function checkPublicConnection(origin, { signal, resolve = resolvePublicAddresses, probe = probePublicAddress } = {}) {
  const result = (status, message) => ({ origin, status, message, checkedAt: Date.now() });
  if (!origin) return result('disabled', 'Connection disabled.');
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return result('unknown', 'Public HTTPS access has not been verified.');
    const addresses = await resolve(url.hostname, { signal });
    if (!addresses.length) return result('dns_missing', 'Your public address is not available in DNS yet. Retry in a few minutes, or click Reconnect.');
    const checks = await Promise.allSettled(addresses.slice(0, 3).map(address => probe(origin, address, { signal })));
    if (checks.some(r => r.status === 'fulfilled' && r.value)) return result('ready', 'Public connection verified.');
    return result('unreachable', 'Your public address exists, but Codex Link cannot be reached through it. Click Reconnect.');
  } catch (e) {
    if (signal?.aborted) throw e;
    return result('unknown', e.message || 'Could not verify public connectivity.');
  }
}
