// Manual native acceptance fixture. Launch with Electron on macOS, then use
// Codex Link's background observe/click tools without opening another AX client.
// Expected: starts with accessibility false; the button appears in the default
// tree after Electron's ~2 second debounce, despite 24 layout wrappers; click => 1
// while another app remains active. Launch through `open -g -a ... --args ...`
// so Launch Services supplies the process launch identity required by the helper.
const { app, BrowserWindow } = require('electron');
let fixtureWindow;

app.setName('Codex Link AX Fixture');
app.whenReady().then(async () => {
  app.on('accessibility-support-changed', (_event, enabled) => {
    console.log(JSON.stringify({ event: 'accessibility', enabled }));
  });
  const window = fixtureWindow = new BrowserWindow({ width: 600, height: 400, show: false, webPreferences: { sandbox: true } });
  window.webContents.on('console-message', details => console.log(details.message));
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <!doctype html><title>Background click fixture</title>
    <style>body{font:20px system-ui;padding:36px}button{font:inherit;padding:16px}div{display:flex;flex-direction:column}</style>
    <h1>Background click fixture</h1>
    ${'<div role="group">'.repeat(24)}<button onclick="this.textContent='Clicked ' + (++window.count); console.log(JSON.stringify({event:'click',count:window.count}))">Click target</button>${'</div>'.repeat(24)}
    <script>window.count=0</script>
  `));
  window.showInactive();
  console.log(JSON.stringify({ event: 'ready', pid: process.pid, accessibility: app.isAccessibilitySupportEnabled() }));
});
app.on('window-all-closed', () => app.quit());
