import os from 'node:os';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { Store, assert } from './util.mjs';

const MAX_ROLLOUTS = 20000;
const MAX_META_BYTES = 1024 * 1024;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_TEXT = 50000;
const MAX_RESULT_TEXT = 512 * 1024;

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
async function prefix(filename, maxBytes) {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat(), size = Math.min(stat.size, maxBytes), buf = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buf, 0, size, 0); return buf.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
function jsonLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}
function messageText(payload) {
  const content = payload?.content;
  if (typeof content === 'string') return content.slice(0, MAX_MESSAGE_TEXT);
  if (!Array.isArray(content)) return '';
  const chunks = [];
  for (const item of content) if (item && typeof item.text === 'string') chunks.push(item.text);
  return chunks.join('\n').slice(0, MAX_MESSAGE_TEXT);
}
async function scanJsonLines(filename, onValue) {
  const handle = await fs.open(filename, 'r'), chunk = Buffer.alloc(64 * 1024);
  let scanned = 0, parts = [], size = 0, skipping = false, stopped = false, eof = false;
  try {
    while (!stopped && scanned < MAX_SCAN_BYTES) {
      const want = Math.min(chunk.length, MAX_SCAN_BYTES - scanned);
      const { bytesRead } = await handle.read(chunk, 0, want, null);
      if (!bytesRead) { eof = true; break; }
      scanned += bytesRead; let start = 0;
      for (let i = 0; i < bytesRead; i++) if (chunk[i] === 10) {
        const part = chunk.subarray(start, i), total = size + part.length;
        if (!skipping && total <= MAX_LINE_BYTES) {
          const line = Buffer.concat([...parts, Buffer.from(part)], total).toString('utf8');
          try { if (await onValue(JSON.parse(line)) === false) { stopped = true; break; } } catch {}
        }
        parts = []; size = 0; skipping = false; start = i + 1;
      }
      if (stopped) break;
      const tail = chunk.subarray(start, bytesRead);
      if (!skipping) {
        if (size + tail.length <= MAX_LINE_BYTES) { parts.push(Buffer.from(tail)); size += tail.length; }
        else { parts = []; size = 0; skipping = true; }
      }
    }
  } finally { await handle.close(); }
  return { capped: !eof && scanned >= MAX_SCAN_BYTES, stopped };
}

export class CodexImport {
  constructor(config, workspaces, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
    this.config = config; this.workspaces = workspaces; this.home = path.resolve(home);
    this.store = new Store(path.join(config.home, 'imports.json'), { version: 1, codexConversations: [] });
    if (!Array.isArray(this.store.data.codexConversations)) { this.store.data.codexConversations = []; this.store.save(); }
  }
  summary() { return { available: existsSync(this.home), conversations: this.store.data.codexConversations.length }; }
  async rolloutFiles() {
    const files = []; let truncated = false;
    const visit = async (dir, sourceRoot, archived, depth) => {
      if (depth > 6 || files.length >= MAX_ROLLOUTS) { truncated = true; return; }
      let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      for (const entry of entries) {
        if (files.length >= MAX_ROLLOUTS) { truncated = true; break; }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(full, sourceRoot, archived, depth + 1);
        else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) files.push({ file: full, sourceRoot, archived });
      }
    };
    for (const [name, archived] of [['sessions', false], ['archived_sessions', true]]) {
      const root = path.join(this.home, name); let real = root;
      try { real = await fs.realpath(root); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await visit(root, real, archived, 0);
    }
    return { files, truncated };
  }
  async titleIndex() {
    const index = new Map(), filename = path.join(this.home, 'session_index.jsonl');
    try {
      for (const row of jsonLines((await prefix(filename, MAX_INDEX_BYTES)).toString('utf8'))) {
        if (typeof row?.id === 'string') index.set(row.id, { title: typeof row.thread_name === 'string' ? row.thread_name : '', updatedAt: row.updated_at || '' });
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return index;
  }
  async metadata(entry, titles) {
    let rows; try { rows = jsonLines((await prefix(entry.file, MAX_META_BYTES)).toString('utf8')); } catch { return null; }
    const row = rows.find(x => x?.type === 'session_meta'); if (!row) return null;
    const meta = row.payload?.meta || row.payload || {}, cwd = meta.cwd;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
    let rolloutPath; try { rolloutPath = await fs.realpath(entry.file); } catch { return null; }
    if (!inside(entry.sourceRoot, rolloutPath)) return null;
    let cwdReal = null;
    try { const r = await fs.realpath(cwd); if ((await fs.stat(r)).isDirectory()) cwdReal = r; } catch {}
    const id = String(meta.id || meta.session_id || path.basename(entry.file, '.jsonl'));
    const indexed = titles.get(id) || {}, stat = await fs.stat(rolloutPath);
    return {
      id, title: indexed.title || `Codex conversation ${id.slice(0, 8)}`, cwd: cwdReal || cwd,
      cwdAvailable: !!cwdReal, rolloutPath, sourceRoot: entry.sourceRoot, archived: entry.archived,
      updatedAt: indexed.updatedAt || row.timestamp || stat.mtime.toISOString()
    };
  }
  async discover() {
    if (!existsSync(this.home)) return { conversations: [], truncated: false };
    const titles = await this.titleIndex(), { files, truncated } = await this.rolloutFiles(), found = [];
    for (let i = 0; i < files.length; i += 16) {
      const batch = await Promise.all(files.slice(i, i + 16).map(x => this.metadata(x, titles)));
      found.push(...batch.filter(Boolean));
    }
    const byId = new Map();
    for (const item of found) {
      const old = byId.get(item.id);
      if (!old || String(item.updatedAt) > String(old.updatedAt)) byId.set(item.id, item);
    }
    return { conversations: [...byId.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))), truncated };
  }
  workspaceFor(cwd, onlyName) {
    const matches = this.workspaces.list().filter(w => (!onlyName || w.name === onlyName) && inside(w.root, cwd)).sort((a, b) => b.root.length - a.root.length);
    return matches[0] || null;
  }
  safeProject(root) {
    const home = path.resolve(os.homedir()), fsRoot = path.parse(root).root;
    return root !== fsRoot && root !== home && !inside(this.home, root);
  }
  async importAll() {
    const { conversations, truncated } = await this.discover();
    const projects = [...new Set(conversations.filter(c => c.cwdAvailable).map(c => c.cwd))];
    let addedProjects = 0, skippedProjects = 0;
    for (const root of projects) {
      const existing = this.workspaceFor(root);
      if (existing || !this.safeProject(root)) { if (!existing) skippedProjects++; continue; }
      try { this.config.addWorkspace('', root); addedProjects++; } catch { skippedProjects++; }
    }
    this.store.data.codexConversations = conversations; this.store.save();
    this.config.value.projectSetupComplete = true; this.config.save();
    const accessibleConversations = conversations.filter(c => this.workspaceFor(c.cwd)).length;
    return { conversations: conversations.length, accessibleConversations, projects: projects.length, addedProjects, skippedProjects, truncated };
  }
  list({ workspace, offset = 0, limit = 50 } = {}) {
    if (workspace) this.workspaces.get(workspace);
    const rows = [];
    for (const c of this.store.data.codexConversations) {
      const w = this.workspaceFor(c.cwd, workspace); if (!w) continue;
      rows.push({ id: c.id, title: c.title, workspace: w.name, updatedAt: c.updatedAt, archived: !!c.archived });
    }
    return { conversations: rows.slice(offset, offset + limit), total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null };
  }
  async read({ id, after = 0, limit = 50 }) {
    const c = this.store.data.codexConversations.find(x => x.id === id); assert(c, 'Unknown imported conversation', 404);
    const workspace = this.workspaceFor(c.cwd); assert(workspace, 'Conversation project is not currently shared', 403);
    let file; try { file = await fs.realpath(c.rolloutPath); } catch { throw new Error('Imported conversation moved; import from Codex again'); }
    assert(inside(c.sourceRoot, file), 'Imported conversation source changed', 403);
    const messages = []; let index = 0, resultBytes = 0, hitLimit = false;
    const scan = await scanJsonLines(file, row => {
      if (row?.type !== 'response_item' || !['user', 'assistant'].includes(row.payload?.role)) return;
      const text = messageText(row.payload); if (!text) return;
      index++; if (index <= after) return;
      const bytes = Buffer.byteLength(text);
      if (messages.length >= limit || resultBytes + bytes > MAX_RESULT_TEXT) { hitLimit = true; return false; }
      resultBytes += bytes; messages.push({ sequence: index, role: row.payload.role, text, timestamp: row.timestamp || null });
    });
    return {
      conversation: { id: c.id, title: c.title, workspace: workspace.name, updatedAt: c.updatedAt, archived: !!c.archived },
      messages, nextAfter: messages.length && (hitLimit || scan.capped) ? messages.at(-1).sequence : null,
      truncated: hitLimit || scan.capped
    };
  }
}
