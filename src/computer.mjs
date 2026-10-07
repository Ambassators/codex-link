import { fileURLToPath } from 'node:url';
import { NativeComputer } from './native-computer.mjs';
import { CodexComputer } from './codex-computer.mjs';
import { ComputerRepl } from './computer-repl.mjs';
import { DecisionsComputer } from './decisions-computer.mjs';
import { pythonCommand, runProcess } from './process.mjs';
import { assert } from './util.mjs';
export class Computer {
  constructor(config) { this.config = config; this.tail = Promise.resolve(); this.controllers = new Set(); this.generation = 0; this.native = process.platform === 'darwin' ? new CodexComputer(this) : new NativeComputer(this); this.repl = this.native.relay ? new ComputerRepl(this) : null; this.decisions = new DecisionsComputer(this); }
  stop() { this.repl?.stop(); this.native.stop(); this.generation++; for (const c of this.controllers) c.abort(); }
  enabled() { return this.config.value.computerAlwaysEnabled || this.config.value.computerEnabledUntil > Date.now(); }
  legacyEnabled() { return !this.native.relay && (this.config.value.dangerousModeEnabled === true || this.config.value.computerLegacyEnabled === true); }
  async action(args, context = {}) {
    assert(this.legacyEnabled(), 'Unscoped legacy desktop control is disabled. Use the native session tools, or explicitly enable legacy access in the local panel.', 403);
    assert(this.enabled(), 'Computer control is disabled. The owner must enable it in the local UI.', 403);
    const generation = this.generation;
    const run = async () => {
      assert(generation === this.generation, 'Computer operation cancelled', 403);
      assert(this.enabled(), 'Computer-control session expired', 403);
      const controller = new AbortController(); this.controllers.add(controller);
      const abort = () => controller.abort();
      context.signal?.addEventListener('abort', abort, { once: true });
      if (context.signal?.aborted) abort();
      let result;
      try { result = await runProcess(pythonCommand(this.config), [fileURLToPath(new URL('../computer/bridge.py', import.meta.url))], {
        input: JSON.stringify(args), signal: controller.signal, timeoutMs: 20000, maxOutput: 8 * 1024 * 1024
      }); } finally { this.controllers.delete(controller); context.signal?.removeEventListener('abort', abort); }
      let data; try { data = JSON.parse(result.stdout); } catch { throw new Error(result.stderr || 'Desktop helper returned invalid output'); }
      assert(result.exitCode === 0 && !data.error, data.error || result.stderr || 'Desktop operation failed'); return data;
    };
    const pending = this.tail.catch(() => {}).then(run); this.tail = pending; return pending;
  }
}
