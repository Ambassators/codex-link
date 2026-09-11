#!/bin/bash
# Review this file before running. Installs from the official Homebrew package catalog.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then echo "This bootstrap is for macOS. See README for manual setup." >&2; exit 1; fi
if [[ "$EUID" -eq 0 ]]; then echo "Run as your normal desktop user, not with sudo." >&2; exit 1; fi
if [[ -x /opt/homebrew/bin/brew ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
if [[ -x /usr/local/bin/brew ]]; then eval "$(/usr/local/bin/brew shellenv)"; fi
if ! command -v brew >/dev/null 2>&1; then
  echo 'Homebrew is required. This runs its official interactive installer (https://brew.sh).'
  installer="$(mktemp -t codex-link-homebrew)"
  trap 'rm -f "$installer"' EXIT
  curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$installer"
  /bin/bash "$installer"
  rm -f "$installer"; trap - EXIT
  if [[ -x /opt/homebrew/bin/brew ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"; else eval "$(/usr/local/bin/brew shellenv)"; fi
fi
# Explicit LTS major, including an explicit PATH for Homebrew's keg-only node@22.
brew list --versions node@22 >/dev/null 2>&1 || brew install node@22
brew list --versions ripgrep >/dev/null 2>&1 || brew install ripgrep
export PATH="$(brew --prefix node@22)/bin:$(brew --prefix)/bin:$PATH"
if [[ ! -d /Applications/Tailscale.app ]]; then brew install --cask tailscale-app; fi
open -a Tailscale
node scripts/setup.mjs --skip-funnel "$@"
echo 'Opening the local control panel. Keep this Terminal window open while using the bridge.'
export CODEX_LINK_OPEN_BROWSER=1
exec node src/main.mjs
