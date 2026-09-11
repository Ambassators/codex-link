# Codex Link

Connect ChatGPT or another MCP client to files, shell commands and optional desktop control on your computer. The app accepts OAuth-protected MCP requests; you approve and monitor them locally.

## Install and connect

Install the DMG or Windows EXE from `release/`, then open Codex Link. The desktop app includes its JavaScript runtime.

1. **Enable the connection.** Install [Tailscale](https://tailscale.com/download) if needed, then click Enable connection. Complete its sign-in or Funnel policy prompts.
2. **Connect ChatGPT.** Add the MCP URL in ChatGPT with OAuth and **Dynamic Client Registration (DCR)**. Follow the app’s instructions for scopes, saving ChatGPT’s callback URL, and verifying your browser before authorization.
3. **Bring in your projects.** Import local Codex projects and conversation history, add project folders manually, or skip for now. Imported conversations remain in Codex's original files and are exposed read-only. The [step-by-step setup guide](docs/SETUP.md#connect-chatgpt) lists every connection field value.

Send work from ChatGPT or your MCP client. File changes and shell commands appear in **Activity** for approval. **Pause access** stops active requests and blocks new ones. Keep the app open and the computer awake.

Other MCP clients use the same HTTPS URL and OAuth. Add the client's exact HTTPS callback under **Settings → Advanced** if it differs from the default ChatGPT callback.

## What it provides

- 24 MCP tools for status, shared folders, read-only imported Codex conversations, file reading/writing/editing, ripgrep search, images, shell commands/input, optional desktop screenshots/actions, and job polling/cancellation.
- Separate native macOS (ScreenCaptureKit/Accessibility/Quartz) and Windows (Windows Graphics Capture/UI Automation/SendInput) backends, window-scoped sessions, app/mode approvals and accessibility context.
- A private local control panel with connection setup, incoming activity, app rules, active desktop sessions and permission settings.
- OAuth with browser owner verification, PKCE, dynamic registration and rotating refresh tokens.
- An optional Electron window and macOS/Windows packaging.

Version 0.2 removes the local Codex engine, its sign-in, task runner, catalogs and native RPC integration. No Codex installation or account is needed. AI work happens in the connected client. Existing external Codex installations and credentials are left untouched.

## Run from source

Node.js 22 or newer is required. There is no frontend compilation step.

```sh
npm ci
npm run check
npm test
npm start
```

Open the private localhost URL printed in the terminal. The URL contains a per-run credential; do not share it.

To install system dependencies and launch from source:

```sh
# macOS
bash scripts/setup-macos.sh
```

```powershell
# Windows, in a normal unelevated PowerShell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
```

Ripgrep must be installed to use `rg_search`. Tailscale is needed for automatic public URL setup; an existing HTTPS reverse proxy can also be configured. Build the optional native helper on macOS 14+ with Xcode Command Line Tools, or on Windows with the .NET 10 SDK:

```sh
npm run computer:build
npm run computer:doctor
```

The native backends do not require Python. See [native computer use](docs/COMPUTER_USE.md) for permissions, platform behavior, packaging and limitations. Python is needed only for explicitly opted-in, unscoped legacy compatibility:

```sh
node scripts/setup.mjs --computer --skip-funnel --python /absolute/path/to/python3
```

## Desktop development and packaging

Stop any browser-launched instance first.

```sh
npm ci --prefix desktop
npm run desktop
# Build a matching native helper before packaging:
npm run computer:build
npm --prefix desktop run dist
# Multi-target packages require a native helper built for EACH requested platform/architecture.
# See docs/COMPUTER_USE.md, then package from macOS:
CSC_IDENTITY_AUTO_DISCOVERY=false npm --prefix desktop run dist -- --mac dmg --arm64 --x64 --win nsis
```

Artifacts are written to `release/`. Current development packages are unsigned. Tailscale and ripgrep remain separate dependencies. Packaged native Windows helpers are self-contained. Python is a separate legacy-only dependency. Source edits do not update an already installed DMG/EXE; launch from source or rebuild the package.

See [setup and recovery](docs/SETUP.md), [tools](docs/mcp-tools.json), [test coverage](docs/TESTING.md), and [security](SECURITY.md). Shell commands run with your OS user's privileges; a working directory is not a sandbox. This is an independent, single-owner integration.
