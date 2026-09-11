import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv } from '../src/process.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export function inherited(command, args, { cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, [...(command.args || []), ...args], { cwd, env: cleanEnv(command.env), stdio: 'inherit', shell: false });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command.file)} exited with ${code}`)));
  });
}
export function option(name, fallback) {
  const i = process.argv.indexOf(name); if (i < 0) return fallback;
  if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return process.argv[i + 1];
}
