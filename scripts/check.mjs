import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './common.mjs';
function scan(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(e => {
    if (['node_modules', '.git', '.backups', 'release', 'generated', '__pycache__', 'bin', 'obj'].includes(e.name)) return [];
    const p = path.join(folder, e.name); return e.isDirectory() ? scan(p) : /\.(mjs|cjs|js)$/.test(e.name) ? [p] : [];
  });
}
let failed = 0; const files = scan(ROOT);
for (const file of files) { const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }); if (result.status !== 0) { console.error(file, result.stderr || result.error); failed++; } }
console.log(`JavaScript syntax: ${files.length - failed}/${files.length} files passed.`); process.exitCode = failed ? 1 : 0;
