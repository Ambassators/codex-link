import { Computer } from '../src/computer.mjs';

// Do not instantiate Config here: a diagnostics command must not reset or enable
// the running app's lease, touch private credentials, or prompt for OS permission.
const computer = new Computer({ value: { computerAlwaysEnabled: false, computerEnabledUntil: 0, computerLegacyEnabled: false, computerAppRules: [], remotePaused: false }, save() {} });
try {
  const capabilities = await computer.native.capabilities();
  console.log(JSON.stringify({ ...capabilities, note: 'Standalone diagnostics do not read or change the running bridge permission state. No screenshot, input, or permission request was performed.' }, null, 2));
  if (!capabilities.installed || capabilities.diagnosticError) process.exitCode = 1;
} finally { computer.stop(); }
