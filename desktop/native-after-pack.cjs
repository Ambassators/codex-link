const path = require('node:path');
const fs = require('node:fs');
const { target } = require('./native-helper.cjs');
exports.default = async context => {
  // macOS uses the user's installed Codex runtime; never bundle or re-sign it.
  if (context.electronPlatformName === 'darwin') return;
  const native = target(context);
  const resources = native.platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const destination = path.join(resources, 'bridge', 'computer', 'bin', `${native.platform}-${native.arch}`);
  fs.mkdirSync(destination, { recursive: true });
  // Copy the complete self-contained publish directory, but only for this target.
  fs.cpSync(native.directory, destination, { recursive: true });
  if (native.platform === 'darwin') fs.chmodSync(path.join(destination, 'codex-link-computer'), 0o755);
};
