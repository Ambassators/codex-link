import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config } from '../../src/config.mjs';
import { createBridge } from '../../src/server.mjs';
const base = mkdtempSync(path.join(os.tmpdir(), 'codex-link-browser-')), root = path.join(base, 'ui-test-project'); mkdirSync(root);
writeFileSync(path.join(root, 'README.md'), '# Browser integration test\nThis is a disposable workspace, not a Codex-generated result.\n');
const config = new Config(path.join(base, 'state')), bridge = await createBridge({ config, adminPort: 0, publicPort: 0 });
config.setOrigin(`http://127.0.0.1:${bridge.publicPort}`, true);
console.log(JSON.stringify({ adminUrl: bridge.adminUrl, publicUrl: config.value.publicOrigin, root }));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await bridge.close(); rmSync(base, { recursive: true, force: true }); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
