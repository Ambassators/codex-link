const $ = id => document.getElementById(id);
let token = new URLSearchParams(location.hash.slice(1)).get('token');
if (token) { sessionStorage.setItem('codex-link-admin', token); history.replaceState(null, '', '/'); }
token ||= sessionStorage.getItem('codex-link-admin');
let state = null, selected = null, polling = false, setupJob = null, stepKey = null, networkBusy = false, noticeTimer;
let jobsExpanded = false;
let activeTab = null;
const snapshots = new Map();
function changed(name, value) { const next = JSON.stringify(value); if (snapshots.get(name) === next) return false; snapshots.set(name, next); return true; }
function element(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function button(text, fn, className) { const b = element('button', text, className); b.type = 'button'; b.addEventListener('click', () => act(fn, b)); return b; }
function notice(text, error = false) { clearTimeout(noticeTimer); $('message').textContent = text; $('message').className = `message${error ? ' error' : ''}`; if (!error) noticeTimer = setTimeout(() => $('message').classList.add('hidden'), 6500); }
async function api(path, body) {
  const res = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Codex-Link-Admin': token || '', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await res.json(); if (!res.ok) throw new Error(data.error_description || data.error || `HTTP ${res.status}`); return data;
}
async function requestMacComputerPermissions() {
  if (state?.platform !== 'darwin' || !state?.computerNative?.installed) return null;
  return api('/api/computer/permissions', {});
}
async function enableComputer(body = {}, successText = 'Computer use enabled.') {
  await api('/api/computer', { enabled: true, ...body });
  try {
    const permissions = await requestMacComputerPermissions();
    if (permissions && !(permissions.accessibility && permissions.screenCapture)) {
      notice(`${successText} macOS permission prompts were requested; approve Accessibility and Screen Recording if prompted.`);
      return;
    }
  } catch (error) {
    notice(`${successText} macOS permission prompting failed: ${error.message}`, true);
    return;
  }
  notice(successText);
}
async function act(fn, b) {
  if (b) b.disabled = true;
  try { await fn(); } catch (e) { notice(e.message, true); } finally { if (b) b.disabled = false; await refresh(); }
}
function bind(id, fn) { $(id).addEventListener('click', () => act(fn, $(id))); }
function form(id, fn) { $(id).addEventListener('submit', event => { event.preventDefault(); act(fn, $(id).querySelector('button')); }); }
function tab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach(b => { b.classList.toggle('active', b.dataset.tab === name); if (b.dataset.tab === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== name));
}
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => tab(b.dataset.tab)));
function safeLink(container, url, text) {
  try { const parsed = new URL(url); if (parsed.protocol !== 'https:') return; const a = element('a', text || url); a.href = parsed.href; a.target = '_blank'; a.rel = 'noreferrer'; container.append(a); } catch {}
}
function loginLinks(container, job) {
  container.replaceChildren(); const seen = new Set();
  for (const event of job.events) if (event.type.startsWith('tailscale.')) for (const match of String(event.data.text || '').matchAll(/https:\/\/[^\s<>]+/g)) {
    try { const u = new URL(match[0]); if ((u.hostname === 'tailscale.com' || u.hostname.endsWith('.tailscale.com')) && !seen.has(u.href)) { seen.add(u.href); safeLink(container, u.href, 'Continue in Tailscale ↗'); } } catch {}
  }
}
function selectJob(job) { selected = typeof job === 'string' ? job : job.id; tab('activity'); snapshots.delete('selected'); void act(loadJob); }
async function loadJob() {
  if (!selected) return;
  const j = await api(`/api/job?id=${encodeURIComponent(selected)}`);
  if (!changed('selected', j)) return;
  $('job-state').textContent = j.status.replaceAll('_', ' ');
  const log = $('job-detail'), nearBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 50;
  log.textContent = JSON.stringify(j, null, 2); if (nearBottom) log.scrollTop = log.scrollHeight;
  $('job-actions').replaceChildren(); loginLinks($('job-links'), j);
  if (['queued', 'running', 'awaiting_approval'].includes(j.status)) $('job-actions').append(button('Cancel request', () => api('/api/cancel', { jobId: j.id }), 'quiet'));
}
const SETTING_LABELS = {
  remotePaused: ['Pause incoming requests', 'Connected clients cannot start work while paused.'],
  autoApproveWrites: ['Approve file changes automatically', 'Allow file and image writes without asking each time.'],
  autoApproveShell: ['Approve shell commands automatically', 'Allow commands to run with your OS account privileges without asking each time.']
};
function render(s) {
  state = s;
  if (changed('update-connections', s.connections)) {
    const select = $('update-connection'), previous = select.value;
    select.replaceChildren();
    for (const g of s.connections) { const option = element('option', `${g.name || 'MCP client'} · ${g.id.slice(0, 8)}`); option.value = g.id; select.append(option); }
    if (s.connections.some(g => g.id === previous)) select.value = previous;
    select.disabled = !s.connections.length;
  }
  $('update-send').disabled = !s.connections.length;
  $('update-status').textContent = !s.connections.length ? 'Connect a client to send updates.' : s.settings.remotePaused ? 'Access is paused. Queued updates wait until access resumes.' : 'Updates are kept until this app restarts. Returned means included in a response, not acknowledged by the assistant.';
  if (changed('updates', s.updates || [])) {
    $('updates').replaceChildren();
    for (const update of (s.updates || []).slice(0, 10)) {
      const row = element('div', undefined, 'approval');
      row.append(element('p', update.text), element('p', `${update.connectionName} · ${update.status} · ${new Date(update.createdAt).toLocaleTimeString()}`, 'muted'));
      if (update.status === 'queued') row.append(button('Cancel update', () => api('/api/updates/cancel', { id: update.id }), 'quiet'));
      $('updates').append(row);
    }
  }
  const latestSetup = s.jobs.find(j => j.kind === 'setup');
  if (!setupJob && latestSetup && ['queued', 'running'].includes(latestSetup.status)) setupJob = latestSetup.id;
  networkBusy = !!setupJob && s.jobs.some(j => j.id === setupJob && ['queued', 'running'].includes(j.status));
  const connected = s.connections.length > 0, folder = s.workspaces.length > 0, address = !!s.mcpUrl && !networkBusy, projectsDone = !!s.projectSetupComplete;
  // Choose the landing page once. Polling must not override navigation, and
  // temporary connection outages must not restart onboarding for existing users.
  if (activeTab === null) tab(connected && projectsDone ? 'activity' : 'setup');
  const health = s.connectionHealth, reachable = health?.status === 'ready';
  const networkIssue = ['dns_missing', 'unreachable'].includes(health?.status);
  $('connection').textContent = s.settings.remotePaused ? 'Access paused' : networkIssue ? 'Connection unavailable' : connected ? (reachable ? 'Connection ready' : 'Client authorized') : 'Waiting for connection';
  $('connection').className = `pill ${s.settings.remotePaused || networkIssue ? 'warn' : connected && reachable ? 'good' : ''}`;
  const attention = !s.mcpUrl || networkBusy || networkIssue || latestSetup?.status === 'failed';
  if (changed('connection-attention', attention)) $('activity-connection').open = attention;
  $('activity-connection-status').textContent = networkBusy ? 'Enabling Tailscale connection…' : latestSetup?.status === 'failed' ? `Connection setup failed: ${latestSetup.error}` : !s.mcpUrl ? 'Connection disabled' : health?.message || 'Public connectivity has not been checked.';
  $('tailscale-enable').textContent = networkBusy ? 'Connecting…' : s.mcpUrl ? 'Reconnect' : 'Enable connection';
  $('stop').textContent = s.settings.remotePaused ? 'Resume access' : 'Pause access';
  $('stop').className = s.settings.remotePaused ? 'primary' : 'danger';
  $('endpoint').value = s.mcpUrl || ''; $('copy-endpoint').disabled = !address; $('pair').disabled = !address;
  $('choose-folder').hidden = !s.folderPicker;
  if (changed('picker', s.folderPicker)) { $('manual-folder').open = !s.folderPicker; $('manual-folder-label').hidden = !s.folderPicker; }
  $('workspace-root').placeholder = s.platform === 'win32' ? 'C:\\Users\\you\\Projects\\my-project' : '/Users/you/Projects/my-project';
  $('tailscale-disable').disabled = networkBusy || !s.settings.funnelManaged;
  $('revoke').disabled = !connected;
  $('tailscale-enable').disabled = networkBusy;
  $('setup-title').textContent = !connected ? 'Connect your computer' : projectsDone ? 'Your connection' : 'Bring in your projects';
  $('setup-description').textContent = !connected ? 'Enable the connection, connect ChatGPT, then bring in your projects.' : projectsDone ? 'Manage shared projects and access from your MCP clients.' : 'Your client is authorized. Import your Codex work or add projects manually.';
  $('network-summary').textContent = address ? health?.message || 'Your MCP server URL is configured; public access has not been verified.' : 'Create a secure URL for this computer.';
  $('client-summary').textContent = connected ? `${s.connections.length} authorized client${s.connections.length === 1 ? '' : 's'}` : 'Copy the URL and authorize access.';
  $('project-summary').textContent = projectsDone ? (folder ? `${s.workspaces.length} shared project${s.workspaces.length === 1 ? '' : 's'}` : 'Project setup skipped. You can add projects anytime.') : 'Import your existing Codex work or add projects manually.';
  $('codex-import').disabled = !s.codexImport?.available;
  $('codex-import-status').textContent = s.codexImport?.available ? (s.codexImport.conversations ? `${s.codexImport.conversations} conversation${s.codexImport.conversations === 1 ? '' : 's'} currently indexed.` : 'Local Codex data found.') : 'No local Codex data found at CODEX_HOME or ~/.codex.';
  for (const [id, done, current] of [['network', address, !address], ['client', connected, address && !connected], ['projects', projectsDone, connected && !projectsDone]]) {
    $(`${id}-state`).textContent = done ? 'Done' : current ? 'Next step' : 'Next';
    $(`step-${id}`).classList.toggle('complete', done);
  }
  const next = !address ? 'network' : !connected ? 'client' : !projectsDone ? 'projects' : 'ready';
  if (stepKey !== next) { stepKey = next; for (const id of ['network', 'client', 'projects']) $(`step-${id}`).open = id === next; }
  $('ready').classList.toggle('hidden', !(connected && projectsDone) || networkIssue);
  $('example-prompt').textContent = folder ? `Use Codex Link to list the files in ${s.workspaces[0].name}.` : 'Use Codex Link to show the connection status.';
  if (changed('workspaces', s.workspaces)) {
    $('workspaces').replaceChildren();
    for (const w of s.workspaces) {
      const row = element('div', undefined, 'workspace'); const text = element('div'); text.append(element('strong', w.name), element('div', w.root, 'muted'));
      row.append(text, button('Remove', async () => { if (confirm(`Stop sharing ${w.name}? Active requests will be stopped.`)) await api('/api/workspaces/remove', { name: w.name }); }, 'quiet')); $('workspaces').append(row);
    }
  }
  if (changed('settings', s.settings)) {
    $('settings').replaceChildren();
    for (const [key, [title, description]] of Object.entries(SETTING_LABELS)) {
      const label = element('label', undefined, 'toggle'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = s.settings[key];
      input.addEventListener('change', () => act(async () => {
        if (input.checked && key !== 'remotePaused' && !confirm(`${title}?\n\n${description}`)) { input.checked = false; return; }
        try { await api('/api/settings', { [key]: input.checked }); } catch (e) { input.checked = !input.checked; throw e; }
      }));
      const text = element('span'); text.append(element('b', title), element('small', description)); label.append(input, text); $('settings').append(label);
    }
    if (document.activeElement !== $('redirects')) $('redirects').value = s.settings.redirectUris.join('\n');
  }
  const pendingJobs = s.jobs.filter(j => j.status === 'awaiting_approval');
  $('approval-count').textContent = String(pendingJobs.length); $('approval-count').hidden = !pendingJobs.length;
  if (changed('approvals', pendingJobs)) {
    $('approvals').replaceChildren();
    if (!pendingJobs.length) $('approvals').append(element('p', 'No requests need approval.', 'muted'));
    for (const j of pendingJobs) {
      const card = element('div', undefined, 'approval'); card.append(element('strong', j.title), element('p', j.permissionRequest ? `${j.permissionRequest.source}: ${j.permissionRequest.message}` : 'Inspect the request before approving.', 'muted'));
      const actions = element('div', undefined, 'buttons'); actions.append(button('Inspect', async () => selectJob(j)), button('Approve once', () => api('/api/approve', { jobId: j.id, allow: true }), 'primary'), button('Deny', () => api('/api/approve', { jobId: j.id, allow: false }), 'quiet')); card.append(actions); $('approvals').append(card);
    }
  }
  if (changed('jobs', [s.jobs, selected, jobsExpanded])) {
    $('jobs-toggle').hidden = s.jobs.length <= 10;
    $('jobs-toggle').textContent = jobsExpanded ? 'Show fewer' : `Show all ${s.jobs.length} requests`;
    $('jobs-toggle').setAttribute('aria-expanded', String(jobsExpanded));
    $('jobs').replaceChildren();
    if (!s.jobs.length) $('jobs').append(element('p', 'Requests appear here when a connected client starts work.', 'muted'));
    for (const j of s.jobs.slice(0, jobsExpanded ? s.jobs.length : 10)) {
      const row = button('', async () => selectJob(j), `job${j.id === selected ? ' selected' : ''}`);
      row.append(element('span', j.title, 'job-title'), element('span', `${j.status.replaceAll('_', ' ')} · ${new Date(j.createdAt).toLocaleTimeString()}`, 'job-meta')); $('jobs').append(row);
    }
  }
  if (changed('grants', s.connections)) {
    $('grants').replaceChildren();
    if (!connected) $('grants').append(element('p', 'Your connection will appear here after authorization.', 'muted'));
    for (const g of s.connections) { const row = element('div', undefined, 'grant'); row.append(element('strong', g.name || 'MCP client'), element('span', 'Authorized', 'pill good')); $('grants').append(row); }
  }
  const permanentComputer = !!s.settings.computerAlwaysEnabled;
  const dangerousMode = !!s.settings.dangerousModeEnabled;
  const computerStatus = permanentComputer ? 'Desktop control is enabled permanently.' : s.computerEnabledUntil > Date.now() ? `Enabled until ${new Date(s.computerEnabledUntil).toLocaleTimeString()}` : 'Desktop control is disabled.';
  $('computer-status').textContent = computerStatus;
  $('activity-computer-status').textContent = dangerousMode ? 'Dangerous mode is enabled: local approvals and application rules are bypassed; native and legacy desktop control are enabled. Upstream runtime consent, if requested, still requires approval.' : computerStatus;
  $('activity-dangerous').textContent = dangerousMode ? 'Disable dangerous mode' : 'Dangerously skip permissions';
  $('activity-dangerous').className = dangerousMode ? 'quiet' : 'danger';
  $('activity-computer-permanent').textContent = permanentComputer ? 'Disable permanent access' : 'Enable permanently';
}

async function networkProgress() {
  if (!setupJob) return;
  const j = await api(`/api/job?id=${encodeURIComponent(setupJob)}`); loginLinks($('network-links'), j);
  networkBusy = ['running', 'queued'].includes(j.status); $('tailscale-enable').disabled = networkBusy;
  const latest = [...j.events].reverse().find(e => e.type === 'setup.message');
  $('network-progress').textContent = j.status === 'failed' ? `Connection setup failed: ${j.error}` : j.status === 'completed' ? (j.result?.connectionHealth?.message || 'Your connection URL is configured; public access has not been verified.') : j.status === 'cancelled' ? 'Connection setup cancelled. You can try again.' : latest?.data.text || 'Creating your connection URL…';
  if (!networkBusy) { setupJob = null; $('tailscale-enable').textContent = j.status === 'completed' ? 'Reconnect' : 'Try again'; if (j.status === 'failed') $('step-network').open = true; }
}
async function refresh() {
  if (polling) return; polling = true;
  try { render(await api('/api/state')); await Promise.all([loadJob(), networkProgress()]); } catch (e) { $('connection').textContent = 'App unavailable'; notice(e.message, true); } finally { polling = false; }
}
bind('stop', async () => { if (state?.settings.remotePaused) { await api('/api/settings', { remotePaused: false }); notice('Incoming requests are enabled.'); } else { await api('/api/stop', {}); notice('Access paused. Active requests stopped. Completed changes are kept.'); } });
$('jobs-toggle').addEventListener('click', () => { jobsExpanded = !jobsExpanded; if (state) render(state); });
bind('manage-connection', async () => tab('activity'));
bind('show-activity', async () => tab('activity'));
bind('activity-permissions', async () => tab('permissions'));
bind('copy-endpoint', async () => { if (!state?.mcpUrl) throw Error('Enable the connection first.'); await navigator.clipboard.writeText(state.mcpUrl); notice('MCP server URL copied. Paste it into your client.'); });
$('manual-projects-toggle').addEventListener('click', () => { $('manual-projects').classList.toggle('hidden'); if (!$('manual-projects').classList.contains('hidden')) $('choose-folder').focus(); });
bind('choose-folder', async () => { const result = await api('/api/workspaces/choose', {}); if (!result.cancelled) notice(`Sharing ${result.name}.`); });
bind('codex-import', async () => { const r = await api('/api/import/codex', {}); notice(`Imported ${r.conversations} conversation${r.conversations === 1 ? '' : 's'} and added ${r.addedProjects} project${r.addedProjects === 1 ? '' : 's'}.`); });
bind('projects-done', async () => { await api('/api/project-setup/complete', {}); notice('Project setup complete.'); });
bind('projects-skip', async () => { await api('/api/project-setup/complete', {}); notice('Project setup skipped. You can add projects later.'); });
bind('diagnostics', async () => { $('diagnostic-output').textContent = JSON.stringify(await api('/api/diagnostics'), null, 2); });
bind('tailscale-enable', async () => {
  networkBusy = true; $('network-progress').textContent = 'Starting connection setup…';
  try { const j = await api('/api/tailscale/enable', {}); setupJob = j.id; $('tailscale-enable').textContent = 'Connecting…'; } catch (e) { networkBusy = false; $('network-progress').textContent = e.message; throw e; }
});
bind('tailscale-disable', async () => { await api('/api/tailscale/disable', {}); notice('Public URL disabled.'); });
bind('pair', async () => {
  const result = await api('/api/pair', {}); $('pair-link').replaceChildren(); safeLink($('pair-link'), result.url, 'Open verification link ↗');
  $('pair-link').append(element('p', 'Link created. Open it in your ChatGPT browser to finish verification, then return to ChatGPT to authorize.', 'muted'));
});
bind('computer-enable', async () => { if (confirm('Allow screenshots, mouse and keyboard access for 15 minutes? On macOS, Codex Link will also request Accessibility and Screen Recording permission.')) await enableComputer({}, 'Computer use enabled for 15 minutes.'); });
bind('activity-dangerous', async () => {
  const enabled = !!state?.settings.dangerousModeEnabled;
  if (enabled) { await api('/api/dangerous', { enabled: false }); notice('Dangerous mode disabled.'); return; }
  if (!confirm('Dangerously skip permissions?\n\nThis approves pending and future requests from authorized clients, bypasses application rules, and enables native and unscoped legacy desktop control across app restarts. OS permissions and OAuth scopes still apply. Shell commands run as your OS user and are not sandboxed.')) return;
  await api('/api/dangerous', { enabled: true }); notice('Dangerous mode enabled.');
});
bind('activity-computer-permanent', async () => {
  const enabled = !!state?.settings.computerAlwaysEnabled;
  if (enabled) { await api('/api/computer', { enabled: false }); notice('Permanent computer use disabled.'); return; }
  if (!confirm('Enable computer use permanently?\n\nAuthorized clients with the computer:use OAuth scope can use screenshots, mouse and keyboard access across app restarts until you disable it, pause access, revoke clients, or disable the public connection.')) return;
  await enableComputer({ persistent: true }, 'Permanent computer use enabled.');
});
bind('computer-disable', () => api('/api/computer', { enabled: false }));
bind('revoke', async () => { if (confirm('Disconnect all clients and stop active requests?')) await api('/api/revoke', {}); });
form('update-form', async () => { await api('/api/updates', { grantId: $('update-connection').value, text: $('update-text').value }); $('update-text').value = ''; notice('Update queued for the next tool response.'); });
form('workspace-form', async () => { await api('/api/workspaces', { name: $('workspace-name').value.trim(), root: $('workspace-root').value.trim() }); $('workspace-form').reset(); notice('Folder added.'); });
form('origin-form', () => api('/api/origin', { origin: $('origin').value.trim() }));
form('redirect-form', async () => { await api('/api/settings', { redirectUris: $('redirects').value.split('\n').map(s => s.trim()).filter(Boolean) }); notice('Callback addresses saved.'); });
async function init() {
  if (!token) { notice('Open the desktop app or the private control-panel link printed in your terminal.', true); return; }
  await refresh();
  const runningSetup = state?.jobs.find(j => j.kind === 'setup' && ['running', 'queued'].includes(j.status));
  if (runningSetup) { setupJob = runningSetup.id; networkBusy = true; $('step-network').open = true; }
  setInterval(refresh, 1500);
}
init().catch(e => notice(e.message, true));
