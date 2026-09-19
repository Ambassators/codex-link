import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, readFileSync, chmodSync, openSync, closeSync, fsyncSync } from 'node:fs';
import path from 'node:path';

export const id = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const challenge = value => createHash('sha256').update(value).digest('base64url');
export const now = () => Math.floor(Date.now() / 1000);
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export class HttpError extends Error {
  constructor(status, message, code = 'invalid_request') { super(message); this.status = status; this.code = code; }
}
export function assert(ok, message, status = 400) { if (!ok) throw new HttpError(status, message); }
export function atomicJson(filename, data) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const tmp = `${filename}.${id(8)}.tmp`;
  // Windows requires a writable handle when flushing file buffers.
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, filename);
  if (process.platform !== 'win32') chmodSync(filename, 0o600);
}
export function loadJson(filename, fallback) {
  try { return JSON.parse(readFileSync(filename, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return structuredClone(fallback); throw new Error(`Cannot read ${filename}: ${e.message}`); }
}
export class Store {
  constructor(filename, initial) { this.filename = filename; this.data = loadJson(filename, initial); }
  save() { atomicJson(this.filename, this.data); }
}
export function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
export function html(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(body);
}
export function redirect(res, url, headers = {}) { res.writeHead(303, { Location: url, 'Cache-Control': 'no-store', ...headers }); res.end(); }
export const escapeHtml = value => String(value).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
export function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(s => s.includes('=')).map(s => { const i = s.indexOf('='); return [s.slice(0, i).trim(), s.slice(i + 1).trim()]; }));
}
export async function readBody(req, limit = 1024 * 1024, form = false) {
  const type = (req.headers['content-type'] || '').split(';')[0];
  assert(type === (form ? 'application/x-www-form-urlencoded' : 'application/json'), 'Unsupported Content-Type', 415);
  assert(Number(req.headers['content-length'] || 0) <= limit, 'Request too large', 413);
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; assert(length <= limit, 'Request too large', 413); chunks.push(chunk); }
  try {
    const body = Buffer.concat(chunks).toString('utf8');
    if (form) {
      const values = new URLSearchParams(body); const out = Object.create(null);
      for (const [k, v] of values) { assert(!Object.hasOwn(out, k), `Duplicate parameter: ${k}`); out[k] = v; }
      return out;
    }
    const parsed = JSON.parse(body); assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'Expected a JSON object'); return parsed;
  } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'Malformed JSON'); }
}
export function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}
export function singleQuery(url) {
  const out = Object.create(null);
  for (const [k, v] of url.searchParams) { assert(!Object.hasOwn(out, k), `Duplicate parameter: ${k}`); out[k] = v; }
  return out;
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function safeError(e) { return e instanceof Error ? e.message : String(e); }
