import { tailscaleCommand, runProcess } from './process.mjs';
import { assert } from './util.mjs';

export class Tailscale {
  constructor(config) { this.config = config; }
  async status({ signal } = {}) {
    let command;
    try { command = tailscaleCommand(this.config); }
    catch (e) { return { installed: false, connected: false, error: e.message }; }
    try {
      const result = await runProcess(command, ['status', '--json'], { signal, timeoutMs: 12000 });
      if (result.exitCode !== 0) return { installed: true, connected: false, error: result.stderr || result.stdout };
      let data;
      try { data = JSON.parse(result.stdout); }
      catch { throw new Error('Tailscale did not return its connection status. Open Tailscale, check that it is running, then try again.'); }
      return { installed: true, connected: data.BackendState === 'Running', state: data.BackendState, dnsName: data.Self?.DNSName?.replace(/\.$/, ''), authUrl: data.AuthURL || null };
    } catch (e) {
      if (signal?.aborted) throw e;
      return { installed: true, connected: false, error: e.message };
    }
  }
  async enable(context) {
    const command = tailscaleCommand(this.config);
    context.emit('setup.message', { text: 'Checking the Tailscale connection…' });
    let status = await this.status({ signal: context.signal });
    assert(!status.error, status.error);
    if (!status.connected) {
      context.emit('setup.message', { text: 'Tailscale login may open a browser or print a login URL. Complete its sign-in before continuing.' });
      const up = await runProcess(command, ['up'], { signal: context.signal, timeoutMs: 10 * 60 * 1000, onOutput: (stream, text) => context.emit(`tailscale.${stream}`, { text }) });
      assert(up.exitCode === 0, up.stderr || up.stdout || 'Tailscale could not connect'); status = await this.status({ signal: context.signal });
      assert(!status.error, status.error);
    }
    assert(status.connected && status.dnsName?.endsWith('.ts.net'), 'Tailscale is not ready or MagicDNS is unavailable');
    const port = this.config.value.funnelPort;
    const existing = await runProcess(command, ['funnel', 'status', '--json'], { signal: context.signal, timeoutMs: 15000 });
    assert(existing.exitCode === 0, existing.stderr || 'Cannot inspect existing Funnel configuration');
    const previous = JSON.parse(existing.stdout || '{}');
    // Never reset or overwrite somebody else's Funnel/Serve listener.
    if (!this.config.value.funnelManaged) {
      assert(!previous.TCP?.[String(port)] && !Object.keys(previous.Web || {}).some(k => k.endsWith(`:${port}`)), `Tailscale port ${port} already has a listener. Choose a dedicated Funnel port in config.json or remove that listener yourself.`);
    }
    const origin = `https://${status.dnsName}${port === 443 ? '' : ':' + port}`;
    const before = this.config.value.publicOrigin;
    this.config.setOrigin(origin);
    const host = `${status.dnsName}:${port}`;
    const alreadyEnabled = this.config.value.funnelManaged && previous.TCP?.[String(port)]?.HTTPS === true
      && previous.Web?.[host]?.Handlers?.['/']?.Proxy === `http://127.0.0.1:${this.config.value.publicPort}`
      && previous.AllowFunnel?.[host] === true;
    try {
      if (alreadyEnabled) {
        this.config.save();
        return { publicOrigin: origin, mcpUrl: `${origin}/mcp`, changedOrigin: before !== origin };
      }
      const result = await runProcess(command, ['funnel', '--bg', `--https=${port}`, `http://127.0.0.1:${this.config.value.publicPort}`], { signal: context.signal, timeoutMs: 10 * 60 * 1000, onOutput: (stream, text) => context.emit(`tailscale.${stream}`, { text }) });
      assert(result.exitCode === 0, result.stderr || result.stdout || 'Funnel could not start. Follow the policy-approval link in the setup output.');
      this.config.value.funnelManaged = true; this.config.save();
      return { publicOrigin: origin, mcpUrl: `${origin}/mcp`, changedOrigin: before !== origin, next: 'Pair your browser, then manually create the ChatGPT MCP connection using OAuth.' };
    } catch (e) { this.config.value.publicOrigin = before; this.config.save(); throw e; }
  }
  async disable() {
    assert(this.config.value.funnelManaged, 'This app does not own a Funnel listener');
    const result = await runProcess(tailscaleCommand(this.config), ['funnel', `--https=${this.config.value.funnelPort}`, 'off'], { timeoutMs: 15000 });
    assert(result.exitCode === 0, result.stderr || 'Could not disable Funnel');
    this.config.value.funnelManaged = false; this.config.save(); return { disabled: true };
  }
}
