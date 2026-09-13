// Owner-only controls. No app rules or desktop permissions are changed on load.
const panel = document.getElementById('native-computer-panel');
const helperSetup = document.getElementById('computer-helper-setup');
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
let current = null, windows = [], busy = false, lastState = '';
let permissionButton;
const status = node('p', 'Loading native backend status…', 'muted');
const errors = node('p', '', 'muted'); errors.setAttribute('role', 'status'); errors.setAttribute('aria-live', 'polite');
const ruleList = node('div'), sessionList = node('div');
const picker = node('select'); picker.setAttribute('aria-label', 'Application window to configure');
const mode = node('select'); mode.setAttribute('aria-label', 'Allowed input mode');
for (const name of ['background', 'foreground']) { const option = node('option', name === 'background' ? 'Background / semantic input' : 'Foreground mouse and keyboard'); option.value = name; mode.append(option); }
const legacy = node('input'); legacy.type = 'checkbox'; legacy.id = 'native-legacy-opt-in';
const diagnostics = node('pre'); diagnostics.style.whiteSpace = 'pre-wrap'; diagnostics.style.overflowWrap = 'anywhere';
async function api(path, body) {
  const token = sessionStorage.getItem('codex-link-admin') || '';
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Codex-Link-Admin': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw Error(value.error_description || value.error || `HTTP ${response.status}`);
  return value;
}
function button(text, fn, className = 'quiet') {
  const element = node('button', text, className); element.type = 'button';
  element.addEventListener('click', async () => {
    if (busy) return; busy = true; element.disabled = true; errors.textContent = '';
    try { await fn(); await refresh(); } catch (error) { errors.textContent = error.message; }
    finally { busy = false; element.disabled = false; }
  });
  return element;
}
function render(state) {
  if (state.diagnostics) diagnostics.textContent = JSON.stringify(state.diagnostics, null, 2);
  const fingerprint = JSON.stringify({ ...state, diagnostics: undefined });
  if (lastState === fingerprint) return; lastState = fingerprint;
  if (!current) mode.value = state.defaultMode;
  if (permissionButton) permissionButton.hidden = state.platform !== 'darwin';
  current = state;
  for (const option of mode.options) option.disabled = !!state.relay && option.value !== 'background';
  if (state.relay) mode.value = 'background';
  legacy.disabled = !!state.relay;
  if (permissionButton && state.relay) permissionButton.hidden = true;
  if (helperSetup) helperSetup.hidden = state.installed !== false;
  status.textContent = `${state.backend}. ${state.relay ? (state.installed ? 'Codex runtime available. App approvals remain in effect.' : 'Install Codex and enable its Computer Use plugin.') : (state.installed ? 'Desktop helper installed.' : 'Desktop helper missing. See Desktop helper setup above.')} ${state.enabled ? 'Desktop lease enabled.' : 'Desktop lease disabled.'}`;
  legacy.checked = !!state.legacyEnabled;
  ruleList.replaceChildren(); sessionList.replaceChildren();
  if (!state.rules.length) ruleList.append(node('p', 'Every application and input mode asks for local approval by default.', 'muted'));
  for (const rule of state.rules) {
    const row = node('div', undefined, 'workspace');
    const description = node('div'); description.append(node('strong', `${rule.decision === 'block' ? 'Blocked' : 'Allowed'}: ${rule.appId}`), node('p', `${rule.mode} · ${rule.executable}`, 'muted'));
    description.style.overflowWrap = 'anywhere';
    row.append(description, button('Remove rule', async () => {
      if (!confirm('Remove this saved application rule? Active native computer sessions will be closed.')) return;
      await api('/api/computer/policy', { rules: current.rules.filter(r => !(r.appId === rule.appId && r.executable === rule.executable && r.mode === rule.mode)) });
    }));
    ruleList.append(row);
  }
  const allSessions = [...state.sessions, ...(state.replSessions || [])];
  if (!allSessions.length) sessionList.append(node('p', 'No computer sessions.', 'muted'));
  for (const session of allSessions) {
    const row = node('div', undefined, 'workspace');
    row.append(node('span', `${session.appName || session.appId} · ${session.mode} · expires ${new Date(session.expiresAt).toLocaleTimeString()}`),
      button('End session', () => api('/api/computer/session/end', { sessionId: session.id })));
    sessionList.append(row);
  }
  if (state.diagnostics) diagnostics.textContent = JSON.stringify(state.diagnostics, null, 2);
}
async function refresh(detailed = false) {
  const result = await api(detailed ? '/api/computer/native' : '/api/state');
  if (detailed) render(result); else if (result.computerNative) render(result.computerNative);
}
async function saveDecision(decision) {
  const selected = windows.find(w => w.windowId === picker.value);
  if (!selected) throw Error('List open application windows and select one first.');
  if (selected.blocked && decision === 'allow') throw Error(selected.blockReason || 'This application cannot be automated.');
  const warning = decision === 'block' ? 'Block native access to this application in both modes?' : `Allow ${mode.value} access to ${selected.appName || selected.appId} for every authorized computer-use client whenever the desktop lease is enabled?`;
  if (!confirm(`${warning}\n\nExecutable: ${selected.executable}\n\nThis saved rule survives restart. All current native sessions will close. This does not authorize purchases, sending messages, or other consequential actions.`)) return;
  const rules = current.rules.filter(r => !(r.appId === selected.appId && r.executable === selected.executable && r.mode === mode.value));
  rules.push({ appId: selected.appId, executable: selected.executable, mode: mode.value, decision });
  await api('/api/computer/policy', { rules });
}
if (panel) {
  panel.append(node('h3', 'Native application access'), status,
    node('p', 'macOS supports app-targeted background actions where the app permits them. Windows uses the foreground pointer and keyboard; background mode is limited to UI Automation. Neither backend unlocks the computer or provides an independent system cursor.', 'muted'));
  const controls = node('div', undefined, 'buttons');
  controls.append(button('List open application windows', async () => {
    ({ windows } = await api('/api/computer/windows'));
    picker.replaceChildren();
    for (const window of windows) { const option = node('option', `${window.appName || window.appId} · window ${window.windowId}${window.blocked ? ' · blocked' : ''}`); option.value = window.windowId; picker.append(option); }
    if (!windows.length) throw Error('No usable native application windows were found.');
  }), picker, mode, button('Save allow rule', () => saveDecision('allow')), button('Block application', () => saveDecision('block'), 'danger'));
  panel.append(controls, node('h4', 'Saved app rules'), ruleList, node('h4', 'Active sessions'), sessionList);
  const legacyDetails = node('details'), summary = node('summary', 'Legacy PyAutoGUI compatibility');
  const label = node('label', undefined, 'toggle'); label.htmlFor = legacy.id; label.append(legacy, node('span', 'Allow unscoped legacy desktop tools'));
  legacyDetails.append(summary, node('p', 'Off by default. Legacy screenshots/actions access the entire primary display and do not enforce native app rules. Keep this disabled for app-scoped permissions.', 'muted'), label);
  legacy.addEventListener('change', async () => {
    const checked = legacy.checked; legacy.disabled = true;
    try {
      if (checked && !confirm('Enable unscoped legacy PyAutoGUI access?\n\nIt bypasses native application rules and can capture or interact with anything on the primary desktop while desktop control is enabled.')) { legacy.checked = false; return; }
      await api('/api/computer/policy', { rules: current.rules, legacyEnabled: checked }); await refresh();
    } catch (error) { errors.textContent = error.message; legacy.checked = !checked; }
    finally { legacy.disabled = false; }
  });
  permissionButton = button('Request macOS screen/accessibility permissions', async () => {
    if (!confirm('Ask macOS to show the native helper’s permission prompts? You must approve any OS requests yourself.')) return;
    const result = await api('/api/computer/permissions', {}); errors.textContent = result.message || 'Review macOS permissions locally.';
  });
  permissionButton.hidden = true;
  const details = node('details'); details.append(node('summary', 'Native backend diagnostics'), button('Check OS permissions and build', () => refresh(true)), permissionButton, diagnostics);
  panel.append(legacyDetails, details, errors);
  refresh().catch(error => { errors.textContent = error.message; });
  setInterval(() => { if (!busy && !document.hidden) refresh().catch(error => { errors.textContent = error.message; }); }, 5000);
}
