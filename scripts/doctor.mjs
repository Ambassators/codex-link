import path from 'node:path';
import { dataDirectory } from '../src/config.mjs';
import { loadJson } from '../src/util.mjs';
import { pythonCommand, findExecutable, runProcess } from '../src/process.mjs';
import { Tailscale } from '../src/tailscale.mjs';

// Inspect without resetting physical-presence permissions or rewriting a running app's config.
const home = dataDirectory(), config = { home, value: loadJson(path.join(home, 'config.json'), {}) };
const report = { platform: process.platform, architecture: process.arch, node: process.version, stateDirectory: home, ripgrep: findExecutable('rg'), git: findExecutable('git'), publicOrigin: config.value.publicOrigin || null, tailscale: await new Tailscale(config).status() };
try {
  const r = await runProcess(pythonCommand(config), ['-c', "import importlib.metadata as m; print('PyAutoGUI=' + m.version('PyAutoGUI') + ' Pillow=' + m.version('Pillow'))"]);
  report.computer = { dependenciesInstalled: r.exitCode === 0, versions: r.stdout.trim(), error: r.stderr.trim(), permissions: 'Not tested: screen capture/input requires a real logged-in desktop and local consent.' };
} catch (e) { report.computer = { dependenciesInstalled: false, error: e.message }; }
console.log(JSON.stringify(report, null, 2));
if (!report.ripgrep) process.exitCode = 1;
