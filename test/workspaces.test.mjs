import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Workspaces, imageType } from '../src/workspaces.mjs';
import { fixture } from './helpers.mjs';

test('create/read/compare-and-swap/edit preserve UTF-8 and reject stale writes', async t => {
  const { config, root } = fixture(t), w = new Workspaces(config);
  const created = await w.write('project', 'src/readme.md', 'Hello 🌍\n', null);
  const read = await w.text('project', 'src/readme.md'); assert.equal(read.sha256, created.sha256);
  const edited = await w.edit('project', 'src/readme.md', 'Hello', 'Welcome', read.sha256);
  assert.notEqual(edited.sha256, read.sha256); assert.equal((await w.text('project', 'src/readme.md')).text, 'Welcome 🌍\n');
  await assert.rejects(w.write('project', 'src/readme.md', 'bad', read.sha256), /File changed/);
  await assert.rejects(w.write('project', 'src/readme.md', 'bad', null), /expectedHash/);
});
test('reject POSIX/Windows traversal, alternate streams, drive paths and reserved names', async t => {
  const { config } = fixture(t), w = new Workspaces(config);
  for (const name of ['../outside', '..\\outside', '/etc/passwd', 'C:\\Windows\\win.ini', 'file:stream', 'NUL.txt', 'foo.']) await assert.rejects(w.resolve('project', name, { create: true }));
});
test('reject symlink escape and hard-link overwrite', async t => {
  const { config, base, root } = fixture(t), w = new Workspaces(config), outside = path.join(base, 'outside');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret'), 'secret');
  try { await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (e.code === 'EPERM') return t.skip('OS does not permit test symlink creation'); throw e; }
  await assert.rejects(w.read('project', 'escape/secret'), /Symlink escapes/);
  await fs.link(path.join(outside, 'secret'), path.join(root, 'hardlink'));
  await assert.rejects(w.write('project', 'hardlink', 'overwrite', null), /hard link/);
});
test('concurrent writes serialize and only one compare-and-swap succeeds', async t => {
  const { config } = fixture(t), w = new Workspaces(config);
  const created = await w.write('project', 'race.txt', 'base', null);
  const results = await Promise.allSettled([w.write('project', 'race.txt', 'one', created.sha256), w.write('project', 'race.txt', 'two', created.sha256)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});
test('literal replacement does not expand $ replacement sequences', async t => {
  const { config } = fixture(t), w = new Workspaces(config), first = await w.write('project', 'literal.txt', 'old', null);
  await w.edit('project', 'literal.txt', 'old', '$& $1 $$', first.sha256);
  assert.equal((await w.text('project', 'literal.txt')).text, '$& $1 $$');
});
test('image payload signatures are verified', () => {
  assert.equal(imageType(Buffer.from([137,80,78,71,13,10,26,10])), 'image/png');
  assert.throws(() => imageType(Buffer.from('<svg>untrusted</svg>')), /Supported images/);
});
