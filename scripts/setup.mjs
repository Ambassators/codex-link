import path from 'node:path';
import { existsSync } from 'node:fs';
import { Config, dataDirectory } from '../src/config.mjs';
import { acquireLock } from '../src/main.mjs';
import { findExecutable } from '../src/process.mjs';
import { Tailscale } from '../src/tailscale.mjs';
import { ROOT, inherited, option } from './common.mjs';

async function setup() {
  if (process.argv.includes('--help')) {
    console.log(`Usage: node scripts/setup.mjs [--computer] [--python PATH] [--skip-funnel]\nOptionally installs the desktop Python helper and configures Tailscale Funnel. Run the platform bootstrap first for system dependencies. Stop a running Codex Link instance before setup.`); return;
  }
  if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node.js 22 or newer is required');
  if (typeof process.getuid === 'function' && process.getuid() === 0) throw Error('Run setup as your normal desktop user, not root');
  const home = dataDirectory(), unlock = acquireLock(home);
  try {
    const config = new Config(home); console.log(`Codex Link setup\nState: ${home}`);
    if (process.argv.includes('--computer')) {
      const python = option('--python', process.env.CODEX_LINK_PYTHON || findExecutable(process.platform === 'win32' ? 'python' : 'python3'));
      if (!python) throw Error('Python is missing; install Python 3.12 and pass --python /absolute/path/to/python');
      const venv = path.join(home, 'computer-venv');
      const executable = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      if (!existsSync(executable)) await inherited({ file: python, args: [] }, ['-m', 'venv', venv]);
      await inherited({ file: executable, args: [] }, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.join(ROOT, 'computer/requirements.txt')]);
      config.value.pythonCommand = { file: executable, args: [] }; config.save();
      console.log('Desktop helper installed. It remains disabled until enabled locally. OS Accessibility/Screen Recording prompts require your consent.');
    }
    if (!process.argv.includes('--skip-funnel')) {
      try {
        const result = await new Tailscale(config).enable({ emit: (type, data) => console.log(`[${type}] ${data.text || JSON.stringify(data)}`) });
        console.log(`Public OAuth-protected MCP: ${result.mcpUrl}`);
      } catch (e) {
        console.error(`Funnel setup needs attention: ${e.message}\nThe local app can still start. Use Setup → Configure Tailscale after completing the OS/account/policy prompts.`);
      }
    }
    console.log('\nSetup finished. Run npm start and open its private local URL.\nIn Setup: add a folder, enable the connection, and connect ChatGPT.\nDo not forward port 43120.');
  } finally { unlock(); }
}
setup().catch(e => { console.error(`Setup failed: ${e.message}`); process.exitCode = 1; });
