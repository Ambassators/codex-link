import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { selectIdentity } = require('../desktop/sign-mac.cjs');

test('packaging rejects missing and ad-hoc signing identities', () => {
  for (const identity of [undefined, '', ' ', '-', ' - ']) {
    assert.throws(() => selectIdentity({ identity }, {}, {}), /persistent macOS signing certificate/);
  }
});

test('explicit build identity overrides local profile and automatic identity', () => {
  assert.equal(selectIdentity({ identity: 'auto' }, { CODEX_LINK_SIGN_IDENTITY: 'release' }, { identity: 'local' }), 'release');
  assert.equal(selectIdentity({ identity: 'auto' }, {}, { identity: 'local' }), 'local');
  assert.equal(selectIdentity({ identity: 'auto' }, {}, {}), 'auto');
});
