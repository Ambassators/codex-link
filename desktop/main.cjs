const { app, BrowserWindow, shell, session, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let bridge, window, unlock, exiting = false;

// Explicitly visible desktop app; no autostart, hidden background agent, preload, or remote Node integration.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    const root = app.isPackaged ? path.join(process.resourcesPath, 'bridge') : path.resolve(__dirname, '..');
    const { dataDirectory } = await import(pathToFileURL(path.join(root, 'src/config.mjs')).href);
    const { acquireLock } = await import(pathToFileURL(path.join(root, 'src/main.mjs')).href);
    const { createBridge } = await import(pathToFileURL(path.join(root, 'src/server.mjs')).href);
    unlock = acquireLock(dataDirectory()); bridge = await createBridge({ chooseFolder: async () => {
      const result = await dialog.showOpenDialog(window, { title: 'Choose a folder to share', properties: ['openDirectory'], buttonLabel: 'Share folder' });
      return result.canceled ? null : result.filePaths[0];
    } });
    const localOrigin = new URL(bridge.adminUrl).origin;
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
    session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write');
    window = new BrowserWindow({ width: 1380, height: 950, minWidth: 760, minHeight: 620, title: 'Codex Link', autoHideMenuBar: true, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, spellcheck: false } });
    const external = async url => {
      try {
        const u = new URL(url);
        if (u.protocol !== 'https:' || u.username || u.password) return;
        // Only local UI content can ask to open a browser. Arbitrary schemes are never passed to the OS.
        await shell.openExternal(u.href);
      } catch (e) { console.error('Cannot open browser:', e.message); }
    };
    window.webContents.setWindowOpenHandler(({ url }) => { void external(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== localOrigin) { event.preventDefault(); void external(url); } });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.once('ready-to-show', () => window.show());
    await window.loadURL(bridge.adminUrl);
  }).catch(async e => { dialog.showErrorBox('Codex Link could not start', e.message); if (bridge) await bridge.close(); unlock?.(); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (exiting) return; event.preventDefault(); exiting = true;
    Promise.resolve(bridge?.close()).finally(() => { unlock?.(); app.quit(); });
  });
}
