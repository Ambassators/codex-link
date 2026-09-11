import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = process.argv.slice(2);
if (options.some(a => !/^--(platform=(darwin|win32)|arch=(arm64|x64))$/.test(a))) throw new Error('Usage: node scripts/build-computer.mjs [--platform=darwin|win32] [--arch=arm64|x64]');
const platform = options.find(a => a.startsWith('--platform='))?.split('=')[1] || process.platform;
const arch = options.find(a => a.startsWith('--arch='))?.split('=')[1] || process.arch;
if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Supported targets: macOS and Windows, arm64 and x64.');
const output = path.join(root, 'computer', 'bin', `${platform}-${arch}`);
mkdirSync(output, { recursive: true });
const executable = path.join(output, `codex-link-computer${platform === 'win32' ? '.exe' : ''}`);
function run(file, args) {
  const result = spawnSync(file, args, { cwd: root, stdio: 'inherit', timeout: 300000, windowsHide: true, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} failed with exit ${result.status}`);
}
if (platform === 'darwin') {
  if (process.platform !== 'darwin') throw new Error('Build the macOS helper on a Mac with Xcode Command Line Tools.');
  run('xcrun', ['swiftc', '-parse-as-library', '-O', '-target', `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos14.0`,
    '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit', '-framework', 'ImageIO', '-framework', 'UniformTypeIdentifiers', '-framework', 'Carbon',
    path.join(root, 'computer/macos/Computer.swift'), '-o', executable]);
  // Ad-hoc developer signing is not Developer ID signing or notarization.
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'dev.codexlink.computer', executable]);
} else {
  // Self-contained publish: end users do not need a separately installed .NET runtime.
  run('dotnet', ['publish', 'computer/windows/Computer.csproj', '-c', 'Release', '-r', `win-${arch}`, '--self-contained', 'true', '-o', output, '-p:PublishSingleFile=true', '-p:DebugType=None']);
}
const sourceDir = path.join(root, 'computer', platform === 'darwin' ? 'macos' : 'windows');
const sources = readdirSync(sourceDir).filter(f => /\.(swift|cs|csproj|manifest)$/.test(f)).sort();
const sourceHash = createHash('sha256');
for (const file of sources) sourceHash.update(file).update(readFileSync(path.join(sourceDir, file)));
writeFileSync(path.join(output, 'build.json'), JSON.stringify({ protocol: 1, platform, arch, sourceSha256: sourceHash.digest('hex'), builtAt: new Date().toISOString() }, null, 2) + '\n');
if (platform === process.platform && arch === process.arch) run(executable, ['--self-test']);
console.log(`\nNative helper built: ${executable}\nNo computer-control permissions were enabled.`);
