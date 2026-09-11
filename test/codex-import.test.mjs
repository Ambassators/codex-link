import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fixture } from './helpers.mjs';
import { Workspaces } from '../src/workspaces.mjs';
import { CodexImport } from '../src/codex-import.mjs';

test('Codex import adds projects and indexes conversations without copying transcript text', async t => {
  const { base, config } = fixture(t), project = path.join(base, 'imported-project'), codexHome = path.join(base, 'codex-home');
  const sessions = path.join(codexHome, 'sessions', '2026', '09', '10'); mkdirSync(project); mkdirSync(sessions, { recursive: true });
  const id = '0199-test-thread', rollout = path.join(sessions, `rollout-2026-09-10T12-00-00-${id}.jsonl`);
  writeFileSync(rollout, [
    JSON.stringify({ timestamp: '2026-09-10T12:00:00Z', type: 'session_meta', payload: { id, cwd: project } }),
    JSON.stringify({ timestamp: '2026-09-10T12:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'private prompt text' }] } }),
    JSON.stringify({ timestamp: '2026-09-10T12:00:02Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'private answer text' }] } })
  ].join('\n') + '\n');
  writeFileSync(path.join(codexHome, 'session_index.jsonl'), JSON.stringify({ id, thread_name: 'Imported thread', updated_at: '2026-09-10T12:00:02Z' }) + '\n');
  const importer = new CodexImport(config, new Workspaces(config), codexHome), result = await importer.importAll();
  assert.equal(result.conversations, 1); assert.equal(result.addedProjects, 1); assert.equal(config.value.projectSetupComplete, true);
  const list = importer.list(); assert.equal(list.total, 1); assert.equal(list.conversations[0].title, 'Imported thread');
  const read = await importer.read({ id, limit: 10 }); assert.deepEqual(read.messages.map(x => [x.role, x.text]), [['user', 'private prompt text'], ['assistant', 'private answer text']]);
  assert.doesNotMatch(readFileSync(path.join(config.home, 'imports.json'), 'utf8'), /private prompt text|private answer text/);
});

test('Codex import refuses to auto-share the user home directory', async t => {
  const { base, config } = fixture(t), codexHome = path.join(base, 'codex-home'), sessions = path.join(codexHome, 'sessions', '2026', '09', '10');
  mkdirSync(sessions, { recursive: true });
  const id = '0199-home-thread';
  writeFileSync(path.join(sessions, `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: os.homedir() } }) + '\n');
  const importer = new CodexImport(config, new Workspaces(config), codexHome), result = await importer.importAll();
  assert.equal(result.addedProjects, 0); assert.ok(result.skippedProjects >= 1);
});
