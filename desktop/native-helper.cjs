const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
function target(context) {
  const platform = context.electronPlatformName;
  const arch = typeof context.arch === 'string' ? context.arch : ({ 1: 'x64', 3: 'arm64' })[context.arch];
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw Error('Native computer packaging supports macOS/Windows arm64 and x64 only.');
  const directory = path.join(root, 'computer', 'bin', `${platform}-${arch}`);
  const executable = path.join(directory, `codex-link-computer${platform === 'win32' ? '.exe' : ''}`);
  if (!fs.existsSync(executable) || !fs.existsSync(path.join(directory, 'build.json'))) throw Error(`Build the native helper first: npm run computer:build -- --platform=${platform} --arch=${arch}`);
  const build = JSON.parse(fs.readFileSync(path.join(directory, 'build.json'), 'utf8'));
  const sourceDir = path.join(root, 'computer', platform === 'darwin' ? 'macos' : 'windows');
  const hash = crypto.createHash('sha256');
  for (const file of fs.readdirSync(sourceDir).filter(f => /\.(swift|cs|csproj|manifest)$/.test(f)).sort()) hash.update(file).update(fs.readFileSync(path.join(sourceDir, file)));
  if (build.protocol !== 1 || build.platform !== platform || build.arch !== arch || build.sourceSha256 !== hash.digest('hex')) throw Error(`Native helper for ${platform}-${arch} is stale. Rebuild it before packaging.`);
  return { platform, arch, directory, executable };
}
module.exports = { target };
