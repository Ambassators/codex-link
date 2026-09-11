import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess, shellCommand } from '../src/process.mjs';

test('real subprocess supports Unicode stdin/stdout and non-zero exit reporting', async () => {
  const command = { file: process.execPath, args: ['-e', "process.stdin.setEncoding('utf8'); process.stdin.on('data', s => process.stdout.write(s)); process.stdin.on('end', () => process.exitCode = 7)"] };
  const result = await runProcess(command, [], { input: 'héllo 世界\n' });
  assert.equal(result.stdout, 'héllo 世界\n'); assert.equal(result.exitCode, 7);
});
test('real subprocess abort terminates running work', async () => {
  const controller = new AbortController();
  const result = runProcess({ file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, [], { signal: controller.signal });
  setTimeout(() => controller.abort(), 40); await assert.rejects(result, /cancelled/);
});
test('real subprocess deadline terminates running work', async () => {
  await assert.rejects(runProcess({ file: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, [], { timeoutMs: 50 }), /timed out/);
});
test('PowerShell command generation uses encoded UTF-16 instead of shell interpolation', t => {
  if (process.platform !== 'win32') { t.skip('Windows-only command-generation assertion'); return; }
  const source = 'Write-Output "héllo & $env:TEMP"';
  const command = shellCommand('powershell', source);
  assert.ok(Buffer.from(command.args.at(-1), 'base64').toString('utf16le').endsWith(source));
  assert.match(Buffer.from(command.args.at(-1), 'base64').toString('utf16le'), /UTF8Encoding/);
});

test('subprocess output overflow fails even if the final chunk crosses the limit', async () => {
  await assert.rejects(runProcess({ file: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(100000))"] }, [], { maxOutput: 1000 }), /output limit/);
});
