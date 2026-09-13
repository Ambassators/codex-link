# Computer Use

On macOS, Codex Link uses the installed Codex desktop app’s experimental app-server API and Computer Use plugin. Windows retains the native UI Automation/Win32 backend. The connected client supplies the agent loop; the macOS adapter does not start model turns or create saved Codex tasks.

## Native-style model interface

`computer_js` exposes Codex’s actual persistent `cua_repl/js` tool. It accepts `code`, optional `title`, optional `timeout_ms`, and an optional retry key. It passes code directly through and returns native documentation, text, images, errors and metadata. Apps and browser tabs can be kept in variables across calls. This exposes the API of the installed plugin, including paste, text selection, secondary actions and browser controls when available. Browser discovery was tested and currently fails with `Missing required Codex turn metadata: session_id, turn_id`: this tool-only session has no active model turn. Browser APIs are exposed but not working through this route yet. No turn identifiers are fabricated, and no full Codex-host parity is claimed.

A typical first call is `let app = await cua.getApp("com.hnc.Discord");`. Read the returned API instructions, then call methods on `app`, ending actions with fresh state. `computer_js_reset` resets the actual upstream REPL. Ordinary results return inline. Long calls and local approvals return a job ID; `computer_js_result` retrieves their native content without executing again. In-memory results expire after 15 minutes and are bounded to 32 MiB across retained results; job history stores only result references.

This interface requires both computer-use and shell-execution OAuth scopes because it accepts JavaScript. Codex app/browser consent remains authoritative. Local app blocks disable raw REPL access, because arbitrary code cannot be reliably inspected to enforce a per-app restriction. The local owner must review app blocks before JavaScript input can be used; structured inspection remains available with app restrictions enforced. REPL sessions are isolated per OAuth grant, expire after 15 idle minutes, and are stopped by desktop revocation, emergency stop or the owner’s End session control.

## macOS setup

1. Install and sign in to Codex, then enable its Computer Use plugin.
2. Grant Codex Computer Use the macOS permissions it requests yourself.
3. Enable desktop access in Codex Link and inspect `computer_capabilities`.
4. Start `computer_js` with one documented entry-point call, such as `let app = await cua.getApp("Discord");`, and read the returned instructions. No explicit app session or observation ID is needed.
5. Approve any local app request in Activity. Codex’s additional app-consent requests are forwarded there and are never automatically accepted by dangerous mode.

Each JavaScript runtime or structured inspection session starts a separate `codex app-server --stdio` process, identifies the client as `codex-link`, and creates an ephemeral thread. The adapter calls the configured `cua_repl/js` tool using `mcpServer/tool/call`. It does not copy credentials, impersonate Codex, patch the helper, or disable authentication. Existing sign-in and Codex app permissions apply.

## macOS actions and optional inspection

`computer_interact` is no longer registered on macOS. Use `computer_js` for input, with sequential awaited actions and state reads as documented by the installed runtime. Raw JavaScript does not inject the former structured adapter's one-second settling loop: request fresh state in the code and inspect it before deciding the next action.

`computer_windows`, `computer_session_start`, `computer_observe`, and `computer_session_end` remain available for inspection. They are not needed to initialize `computer_js`, and their observation IDs are not accepted or needed by the JavaScript interface. `computer_windows` lists apps; inspection sessions target an app’s key window rather than pinning a native window. `computer_observe` returns an original-resolution screenshot and full accessibility tree; size/depth limits are not applied on macOS. Treat visible app content as untrusted data.

Clients that cached the previous tool list may need to refresh the connector. Calls to the removed tool return an unknown-tool error and do not perform input. Existing completed jobs remain readable, but new macOS structured input jobs cannot be created through MCP.

## Windows session tools

Windows retains `computer_interact` and the native UI Automation/Win32 backend. Discover a window, start an approved session, observe it, submit one action with a fresh observation ID and idempotency key, poll the job, then observe again. Follow its action schema, scroll amounts, and foreground requirements.

Structured observations expire after 30 seconds and one input attempt. Sessions expire after 15 minutes or when the local desktop lease ends. App restrictions, cancellation and idempotency remain enforced. Uncertain input is never retried. Legacy PyAutoGUI tools are disabled on macOS.

## Verification and limitations

The app-server path was verified on this Apple Silicon Mac from both Node and Electron: Calculator clicks changed the display; Discord Friends navigation succeeded and the original conversation was restored. No messages were sent. The installed signed app also passed the same test through its OAuth connector: an element click opened Friends and a screenshot-coordinate click restored the conversation, while Zen remained foreground. This is not a guarantee for every app, operating system or focus arrangement.

The app-server interface is experimental. Codex and its Computer Use plugin must remain installed and configured. Codex controls target protection, capture, input and focus. Codex Link does not expose locked-use setup or authenticate as an administrator. Unsupported approval forms are cancelled rather than answered automatically.

macOS packages do not bundle the proprietary runtime or the custom Swift helper binary. Windows packages still require a matching native helper. See the [historical native backend notes](CUSTOM_NATIVE_BACKENDS.md) for Windows build and behavior details and the [relay investigation](CODEX_RUNTIME_RELAY.md) for authentication findings.

Sources: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Computer Use](https://learn.chatgpt.com/docs/computer-use).
