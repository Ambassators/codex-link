const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

// Fail packaging if an unsigned or incorrectly identified app would be shipped.
exports.default = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose', app], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stderr.split('\n').includes(`Identifier=${context.packager.appInfo.id}`)) {
    throw new Error('Packaged macOS signature does not match the application bundle identifier.');
  }
  const requirement = execFileSync('/usr/bin/codesign', ['--display', '--requirements', '-', app], { encoding: 'utf8' });
  if (!requirement.includes('designated =>') || /(?:^|\s)cdhash\s/.test(requirement) || !/certificate|anchor/.test(requirement)) {
    throw new Error('Packaged macOS identity must be certificate-based so privacy permissions survive rebuilds.');
  }
};
