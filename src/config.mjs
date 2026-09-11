import os from 'node:os';
import path from 'node:path';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { Store, assert, id } from './util.mjs';

export const SCOPES = ['bridge:read', 'files:read', 'files:write', 'shell:execute', 'computer:use'];
export const DEFAULT_SCOPES = [...SCOPES];
export function dataDirectory() {
  if (process.env.CODEX_LINK_HOME) return path.resolve(process.env.CODEX_LINK_HOME);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'CodexLink');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'CodexLink');
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'codex-link');
}
export class Config {
  constructor(home = dataDirectory()) {
    this.home = home;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.store = new Store(path.join(home, 'config.json'), {
      version: 1, instanceId: id(12), publicOrigin: '', publicPort: 43121, adminPort: 43120,
      redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      workspaces: [], projectSetupComplete: false, pythonCommand: null, tailscaleCommand: null,
      autoApproveWrites: false,
      autoApproveShell: false, dangerousModeEnabled: false, computerEnabledUntil: 0, computerAlwaysEnabled: false,
      computerLegacyEnabled: false, computerAppRules: [],
      remotePaused: false,
      funnelPort: 443, funnelManaged: false
    });
    // Existing installs that already shared a folder have implicitly completed project setup.
    if (typeof this.store.data.projectSetupComplete !== 'boolean') this.store.data.projectSetupComplete = Array.isArray(this.store.data.workspaces) && this.store.data.workspaces.length > 0;
    // Retire engine settings from older installations without touching external credentials.
    for (const key of ['codexCommand', 'codexVersion', 'autoApproveCodex', 'experimentalApi', 'allowAdvanced', 'sandbox', 'approvalPolicy']) delete this.store.data[key];
    if (typeof this.store.data.dangerousModeEnabled !== 'boolean') this.store.data.dangerousModeEnabled = false;
    if (typeof this.store.data.computerAlwaysEnabled !== 'boolean') this.store.data.computerAlwaysEnabled = false;
    if (typeof this.store.data.computerLegacyEnabled !== 'boolean') this.store.data.computerLegacyEnabled = false;
    if (!Array.isArray(this.store.data.computerAppRules)) this.store.data.computerAppRules = [];
    // Temporary computer permission expires on every app restart; explicit permanent mode does not.
    this.store.data.computerEnabledUntil = 0;
    this.store.save();
  }
  get value() { return this.store.data; }
  save() { this.store.save(); }
  setOrigin(origin, allowLocal = false) {
    const u = new URL(origin);
    assert(u.pathname === '/' && !u.search && !u.hash && !u.username && !u.password, 'Use a bare origin, without a path or credentials');
    assert(u.protocol === 'https:' || (allowLocal && u.protocol === 'http:' && u.hostname === '127.0.0.1'), 'Public origin must use HTTPS');
    this.value.publicOrigin = u.origin; this.save();
  }
  addWorkspace(name, root) {
    if (!name && typeof root === 'string') {
      const base = path.basename(root).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'folder';
      name = base; let suffix = 2;
      while (this.value.workspaces.some(w => w.name === name)) name = `${base}-${suffix++}`;
    }
    assert(typeof name === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(name), 'Workspace name must use letters, numbers, underscores or hyphens');
    assert(!this.value.workspaces.some(w => w.name === name), 'Workspace name already exists');
    assert(typeof root === 'string' && path.isAbsolute(root), 'Choose an absolute workspace directory');
    root = realpathSync(root); assert(statSync(root).isDirectory(), 'Workspace must be a directory');
    assert(root !== path.parse(root).root, 'Do not expose an entire drive');
    const rel = path.relative(root, this.home);
    assert(rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel), 'Workspace must not contain Codex Link credentials; use a project subdirectory');
    this.value.workspaces.push({ name, root }); this.save(); return { name, root };
  }
  patch(patch) {
    const bools = ['autoApproveWrites', 'autoApproveShell', 'remotePaused'];
    for (const name of bools) if (Object.hasOwn(patch, name)) { assert(typeof patch[name] === 'boolean', `${name} must be boolean`); this.value[name] = patch[name]; }
    if (patch.redirectUris) {
      assert(Array.isArray(patch.redirectUris) && patch.redirectUris.length <= 20, 'Too many redirect URIs');
      for (const uri of patch.redirectUris) {
        const u = new URL(uri); assert(u.protocol === 'https:' && !u.hash && !u.username && !u.password, 'Redirects must be exact HTTPS URIs');
      }
      this.value.redirectUris = [...new Set(patch.redirectUris)];
    }
    this.save();
  }
}
