const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profilePath = () => path.join(os.homedir(), 'Library', 'Application Support', 'CodexLink', 'signing.json');

function selectIdentity(options, env = process.env, profile = {}) {
  const identity = env.CODEX_LINK_SIGN_IDENTITY || profile.identity || options.identity;
  if (typeof identity !== 'string' || !identity.trim() || identity.trim() === '-') {
    throw new Error('Codex Link needs a persistent macOS signing certificate. Ad-hoc signatures invalidate privacy permissions after rebuilds. Set CODEX_LINK_SIGN_IDENTITY or save {"identity":"certificate SHA-1"} in ' + profilePath());
  }
  return identity.trim();
}

exports.default = async options => {
  // Builder's '-' placeholder ensures this hook runs without a Developer ID
  // certificate. It is never passed through: selectIdentity requires a real key.
  const { signAsync } = require('@electron/osx-sign');
  let profile = {};
  if (fs.existsSync(profilePath())) profile = JSON.parse(fs.readFileSync(profilePath(), 'utf8'));
  const identity = selectIdentity(options, process.env, profile);
  await signAsync({ ...options, identity });
};
exports.selectIdentity = selectIdentity;
