# Setup and recovery

## Desktop app

Install the DMG or EXE, open Codex Link, and follow Connection:

1. Install Tailscale if needed, then **Enable connection**. Complete the Tailscale login or Funnel permission link shown inline. The app refuses to overwrite a listener it does not own.
2. Follow **Connect ChatGPT** using the field values and callback steps below.
3. After authorization, choose **Import all from Codex** to discover local project folders and index their conversations read-only, or **Add projects manually**. You can also skip project setup and add folders later.

Connection changes to the connected state after authorization. ChatGPT account and workspace policy may affect custom MCP availability; see the linked official guide in the app.

For another MCP client, use the same URL and OAuth flow. Add its exact HTTPS redirect URI in Settings → Advanced → Allowed OAuth callbacks. No wildcard callbacks are accepted.

## Connect ChatGPT

Keep Codex Link and ChatGPT open side by side.

1. In ChatGPT, enable **Developer mode** in Settings, then create a connection from **Plugins**. Name it **Codex Link**, paste the **MCP server URL** from Codex Link, and choose **OAuth**.
2. In ChatGPT’s **Client registration** section, select **Dynamic Client Registration (DCR)**. This lets ChatGPT create its own client credentials. Use the settings below.

| ChatGPT field | Value |
|---|---|
| Registration method | Dynamic Client Registration (DCR) |
| OAuth Client ID / Client Secret | Leave empty if shown |
| Token endpoint auth method | `none` |
| Base scopes | `bridge:read` |

In **Scopes → Default scopes**, paste these four lines:

```text
files:read
files:write
shell:execute
computer:use
```

The `computer:use` permission is for optional desktop control. You still enable desktop control separately in Codex Link Settings.

3. After selecting DCR, copy the full **Callback URL** shown in ChatGPT. In **Codex Link → Settings → Advanced → Allowed OAuth callbacks**, add it on a new line, keep the existing addresses, and click **Save callbacks**.
4. Return to **Codex Link → Connection → Connect ChatGPT**. Click **Verify my browser**, then **Open verification link**. Use the same browser and profile where ChatGPT is signed in. Open the link within 90 seconds; if it expires, click **Verify my browser** again.
5. Return to ChatGPT and save the connection. Follow the authorization prompt, review the permissions, and select **Authorize**. Codex Link shows **Client connected** when authorization succeeds.

See the [official OpenAI OAuth setup guide](https://developers.openai.com/plugins/build/auth#client-registration) for registration and callback details.

## What is installed separately

The desktop app contains Electron and the MCP server/UI. Tailscale supplies the public HTTPS transport. Install ripgrep for search. The platform-native computer helper is optional. Python is only for legacy desktop compatibility. There is no local AI engine to install or sign into.

From source, the platform scripts install Node, ripgrep and Tailscale where missing. macOS uses Homebrew; Windows uses winget. Run as your normal desktop user. Individual installers and OS permissions may prompt. Setup leaves connection configuration to the app.

Optional native desktop helper, from the source directory:

```sh
npm run computer:build
npm run computer:doctor
```

Build on macOS 14+ with Xcode Command Line Tools or on Windows with the .NET 10 SDK. Native Windows packages are self-contained. Enable a temporary or persistent desktop lease locally, then approve each requested application and input mode in Activity. Settings → Native application access manages saved app rules and sessions. On macOS, the diagnostics section offers an owner-only button for the standard Accessibility/Screen Recording permission prompts; you must approve those yourself. Moving the pointer to a display corner triggers the input fail-safe; Windows also checks held Escape.

The separate backends intentionally differ: macOS background delivery is app-dependent, while Windows mouse/keyboard control uses the real foreground desktop. Windows background mode is UI Automation only. Locked use and an independent system cursor are not implemented. See [native computer use](COMPUTER_USE.md) and the [agent skill](../computer/SKILL.md).

The older Python setup command remains available only for explicit legacy compatibility. Legacy full-desktop tools now require the separate local legacy opt-in and are not constrained by native app rules. Keep it off unless that broader access is intentional.

## Source runtime

Use Node 22+. Run `npm ci`, `npm start`, then open the printed private URL. `npm run doctor` checks transport and helper dependencies. `npm run check` and `npm test` validate the source.

The app uses localhost port 43120 for its private control panel and 43121 for OAuth/MCP. Never expose the administrative port. An existing reverse proxy must forward to the MCP listener and provide public HTTPS; enter its bare origin using “I already have an HTTPS address”. The client URL ends with `/mcp`.

## Permissions and recovery

File and shell writes require approval in Activity by default. Read requests run immediately and are recorded in the private audit log. Auto-approval controls are in Settings. Shell commands can access beyond the shared folder as your OS user.

Pause access cancels tracked work and rejects incoming MCP requests. Resume access permits requests again. Disconnect all clients revokes grants and browser verification and stops tracked work. Disable public URL turns off the app-managed Funnel and clears its URL and grants. These operations do not undo completed changes.

Browser verification lasts 12 hours or until restart/revocation. A link expires after 90 seconds; request a new one if needed. Existing valid client grants survive restarts. New authorizations require browser verification again. The local admin credential changes every run.

After a restart, unfinished requests are marked interrupted and never replayed. Review partial changes before retrying. Poll `job_get` until a terminal status before claiming completion.

## Private state

Windows: `%LOCALAPPDATA%\CodexLink`. macOS: `~/Library/Application Support/CodexLink`. Linux: `$XDG_STATE_HOME/codex-link` or `~/.local/state/codex-link`. `CODEX_LINK_HOME` overrides the location.

State contains config, OAuth hashes/grants, recent jobs, audit logs, and lightweight references to imported Codex conversations. Imported transcript contents stay in Codex's original rollout files. Keep it outside shared folders. Version 0.2 discards retired local-engine settings but does not uninstall external software or erase old credentials/history. Historical jobs may still mention the old integration.

## Troubleshooting

| Problem | Action |
|---|---|
| Tailscale missing | Install it through the link in step 2, then retry. |
| Tailscale account or policy approval | Open the inline Tailscale link and complete the request. |
| Port already used | Stop another instance or choose dedicated ports in private config while stopped. |
| Owner verification required | Click Verify my browser, open its link in the authorization browser, and reload the permission page. |
| Callback rejected | Add the exact callback supplied by your MCP client in Advanced settings. |
| Request awaiting approval | Open Activity and inspect/approve it locally. |
| Request paused | Click Resume access. |
| ripgrep missing | Install ripgrep; it is needed only for search. |
| Desktop helper missing | Install the optional helper from source and grant OS permissions. |

For removal, disconnect clients, disable the public URL, quit, then remove the app. Remove private state only if you intend to discard configuration and history. Shared dependencies remain separate.
