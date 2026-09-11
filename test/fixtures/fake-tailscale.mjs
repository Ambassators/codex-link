// Deterministic CLI fixture; it does NOT open a real tunnel or authenticate.
import { readFileSync, writeFileSync } from 'node:fs';
const filename = process.argv[2], args = process.argv.slice(3), state = JSON.parse(readFileSync(filename, 'utf8'));
(state.calls ||= []).push(args);
const save = () => writeFileSync(filename, JSON.stringify(state));
if (state.requireCli && process.env.TAILSCALE_BE_CLI !== '1') { save(); console.log('The Tailscale GUI failed to start'); }
else if (args[0] === 'status' && state.statusError) { save(); console.error(state.statusError); process.exitCode = 1; }
else if (args[0] === 'status' && state.invalidStatus) { save(); console.log('The Tailscale GUI failed to start'); }
else if (args[0] === 'status') { save(); console.log(JSON.stringify({ BackendState: state.connected ? 'Running' : 'NeedsLogin', Self: { DNSName: 'fixture.tail-test.ts.net.' } })); }
else if (args[0] === 'up') { state.connected = true; save(); console.log('fixture connected'); }
else if (args[0] === 'funnel' && args[1] === 'status') { save(); console.log(JSON.stringify(state.serve || {})); }
else if (args.includes('off')) { state.serve = {}; save(); console.log('fixture disabled'); }
else if (args[0] === 'funnel') { save(); if (state.fail) { console.error('fixture policy denied'); process.exitCode = 1; } else console.log('fixture funnel configured'); }
else { save(); console.error('unexpected fixture command'); process.exitCode = 1; }
