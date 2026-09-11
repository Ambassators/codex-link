import path from 'node:path';
import { promises as fs } from 'node:fs';
import { assert, hash, id } from './util.mjs';

export class Workspaces {
  constructor(config) { this.config = config; this.locks = new Map(); }
  list() { return this.config.value.workspaces.map(w => ({ ...w })); }
  get(name) { const w = this.config.value.workspaces.find(w => w.name === name); assert(w, 'Unknown workspace', 404); return w; }
  async resolve(name, relative = '.', { create = false, directory = false } = {}) {
    const w = this.get(name);
    assert(typeof relative === 'string' && relative.length <= 4096 && !relative.includes('\0'), 'Invalid path');
    assert(!path.isAbsolute(relative) && !/^[A-Za-z]:/.test(relative) && !relative.startsWith('\\'), 'Use a workspace-relative path');
    // Reject Windows alternate data streams and device names on all platforms for portable semantics.
    const pieces = relative.replaceAll('\\', '/').split('/');
    assert(pieces.every(p => !p.includes(':') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) && !/[. ]$/.test(p.replace(/^\.{1,2}$/, ''))), 'Unsafe or non-portable path');
    const dest = path.resolve(w.root, ...pieces);
    const inside = value => { const rel = path.relative(w.root, value); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
    assert(inside(dest), 'Path escapes workspace', 403);
    assert(await fs.realpath(w.root) === w.root, 'Workspace root changed; re-register it', 403);
    let ancestor = dest;
    while (true) {
      try { assert(inside(await fs.realpath(ancestor)), 'Symlink escapes workspace', 403); break; }
      catch (e) { if (e.code !== 'ENOENT' || !create) throw e; const next = path.dirname(ancestor); assert(next !== ancestor, 'Cannot resolve path'); ancestor = next; }
    }
    if (!create) {
      const stat = await fs.stat(dest);
      if (directory) assert(stat.isDirectory(), 'Expected a directory');
      else assert(stat.isFile() || stat.isDirectory(), 'Special files are not supported');
    }
    return dest;
  }
  async read(name, relative, maxBytes = 512 * 1024) {
    const file = await this.resolve(name, relative), st = await fs.stat(file);
    assert(st.isFile(), 'Expected a regular file'); assert(st.size <= maxBytes, `File exceeds ${maxBytes} bytes; use shell for large files`, 413);
    const data = await fs.readFile(file); assert(data.length <= maxBytes, 'File grew while reading', 413); return { data, sha256: hash(data) };
  }
  async text(name, relative) {
    const r = await this.read(name, relative); assert(!r.data.includes(0), 'Binary file; use image_read for images');
    let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(r.data); } catch { throw new Error('Not valid UTF-8; use shell for other encodings'); }
    return { path: relative, text, sha256: r.sha256, bytes: r.data.length };
  }
  async listDirectory(name, relative = '.') {
    const dir = await this.resolve(name, relative, { directory: true });
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return { path: relative, truncated: entries.length > 1000, entries: entries.slice(0, 1000).map(e => ({ name: e.name, type: e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other' })) };
  }
  async serial(name, fn) {
    const prior = this.locks.get(name) || Promise.resolve();
    const next = prior.catch(() => {}).then(fn); this.locks.set(name, next);
    try { return await next; } finally { if (this.locks.get(name) === next) this.locks.delete(name); }
  }
  async write(name, relative, content, expectedHash = null) {
    return this.serial(name, async () => {
      const file = await this.resolve(name, relative, { create: true });
      assert(Buffer.byteLength(content) <= 2 * 1024 * 1024, 'Write exceeds 2 MiB', 413);
      let before = null, mode = 0o600;
      try {
        const st = await fs.lstat(file); assert(st.isFile() && st.nlink === 1, 'Refusing to overwrite a symlink, hard link, directory or special file', 403); mode = st.mode;
        before = (await this.read(name, relative, 2 * 1024 * 1024)).sha256;
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      assert(expectedHash === before, before ? 'File changed or expectedHash missing; read the file first' : 'File no longer exists; expectedHash must be null to create', 409);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await this.resolve(name, relative, { create: true });
      const temp = path.join(path.dirname(file), `.codex-link-${id(12)}.tmp`);
      try {
        await fs.writeFile(temp, content, { flag: 'wx', mode });
        const handle = await fs.open(temp, 'r'); try { await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temp, file);
      } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
      return { path: relative, previousSha256: before, sha256: hash(content), bytes: Buffer.byteLength(content) };
    });
  }
  async edit(name, relative, oldText, newText, expectedHash) {
    assert(oldText.length > 0, 'oldText cannot be empty');
    const before = await this.text(name, relative);
    assert(before.sha256 === expectedHash, 'File changed; read it again', 409);
    assert(before.text.split(oldText).length - 1 === 1, 'oldText must occur exactly once');
    return this.write(name, relative, before.text.replace(oldText, () => newText), expectedHash);
  }
}
export function imageType(data) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('Supported images: PNG, JPEG, WebP (validated by signature)');
}
