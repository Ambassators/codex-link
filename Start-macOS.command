#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -x /opt/homebrew/opt/node@22/bin/node ]]; then export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH"; fi
if [[ -x /usr/local/opt/node@22/bin/node ]]; then export PATH="/usr/local/opt/node@22/bin:/usr/local/bin:$PATH"; fi
export CODEX_LINK_OPEN_BROWSER=1
exec node src/main.mjs
