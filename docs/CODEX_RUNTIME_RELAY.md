# Codex Computer Use relay experiment — September 12, 2026

Status: the direct-helper prototype below has been replaced by the app-server integration in `src/codex-app-server-client.mjs`. `Computer` now selects it on macOS. The original prototype build remains in `release/codex-runtime/mac-arm64/` for historical inspection.

`src/codex-computer-client.mjs` implements stdio MCP transport to the installed Codex Computer Use client. `src/codex-computer.mjs` adapts app sessions and original screenshot coordinates. New Jobs support forwards empty-form MCP consent to local owner approval without dangerous-mode acceptance. Automated tests cover transport, consent, cancellation, OAuth grant isolation, observation expiry and duplicate-input prevention.

Read-only acceptance observations:

- A Node process launched from this Codex task repeatedly initialized the installed runtime and listed apps successfully.
- Codex Link and a minimal Electron process initialized the MCP server but timed out on app listing.
- A separate Node child under Electron listed apps successfully. This alone does not prove app access or click compatibility.
- An Electron run-as-Node probe received `Computer Use server error -10000: Sender process is not authenticated`. No attempt was made to impersonate an authenticated sender or bypass this rejection.
- No app consent was automatically accepted and no Discord input was sent through the prototype.
- Using the actual built-in `cua_repl` tool, Codex clicked Discord Friends, observed `Friends - Discord` and the friends list, then restored the original `Glub glub - Discord` conversation. No message was sent. This verifies direct Codex use only.

The installed plugin launcher exposes its client executable, but the official Computer Use documentation does not establish support for this standalone Electron relay or describe how to authenticate it. Do not describe the prototype as a working drop-in backend. Further integration needs a supported authentication/hosting path and actual app-consent and input acceptance tests.

Official documentation: https://learn.chatgpt.com/docs/computer-use


## Resolved route: app-server

The installed Codex 0.154.0-alpha.6.2 exposes the documented `mcpServer/tool/call` API. A client identified as `codex-link` can initialize `codex app-server --stdio`, create an ephemeral thread, and call its configured `cua_repl/js` tool. No model turn or saved task is created. `account/read` confirmed the existing ChatGPT sign-in without exposing or copying tokens.

Both a Node client and an Electron main process successfully used this route. Node clicked Calculator’s Change Sign button, observed the display change, then restored the numeric value. Electron opened Discord Friends, observed the actual Friends HTML page and selected Online tab, and restored the original conversation. The integrated adapter also returned the Discord accessibility tree and a PNG screenshot through Electron. No message was sent and no authentication check was modified. These tests do not establish the root cause or exact mechanism of the direct-helper rejection.

The new adapter forwards empty-form app consent to the local owner, cancels unsupported approval types, quotes untrusted strings as JavaScript data, binds a connection to one app, and closes timed-out/cancelled sessions without replaying input. It never supplies an OpenAI client identity, private attestation, or synthesized credential.

Official API: https://learn.chatgpt.com/docs/app-server


## Installed-app acceptance

Installed the signed app-server build at `/Applications/Codex Link.app` and verified its deep/strict code signature. The prior app is preserved at `/var/folders/81/1hg3nzjn4274kwf603vyp9j80000gn/T/codex-link-before-appserver-1tdg44ym/Codex Link.app`.

Through the actual Codex Link OAuth connector:

- `computer_capabilities` reported `Codex Computer Use via app-server`, installed and enabled, with legacy access disabled.
- `computer_windows` returned app IDs; session start completed for Discord.
- Observation returned a real PNG and full accessibility tree.
- An `invoke` on the observed Friends element opened `Friends - Discord` with the Friends HTML page.
- A screenshot-coordinate `click` on the original conversation restored its HTML page.
- Independent `NSWorkspace.frontmostApplication` reads returned `app.zen-browser.zen` before and after both actions. This verifies background input for this test, not every possible app or gesture.
- The session was ended. No message was sent.

Validation: 97 tests total, 96 passed and one Windows-only skip; JavaScript syntax 52/52. Tests cover actual stdio transport with a mock app-server, consent forwarding/rejection/cancellation, app binding, text escaping, HTTP MCP image delivery, idempotent input and rejection of pixel input without a screenshot.


## Native-style REPL interface

Added `computer_js`, `computer_js_reset`, and `computer_js_result`. The first two forward directly to the installed `cua_repl` tools. Ordinary results return inline with native text, images, documentation, JavaScript errors and metadata; calls that are slow or awaiting approval return a job ID. Fetching their result never executes the code again. The model can keep variables and several app bindings across calls without explicit application sessions or observation tokens. No extra UI actions or observations are injected into raw code.

The runtime is isolated per OAuth grant (not automatically per conversation using that same grant). It requires `computer:use` and `shell:execute`, retains normal Codex app consent, and refuses raw access when local app blocks exist. The structured adapter remains available. Sessions expire after 15 minutes idle and appear in the local session list. Result content is held in bounded temporary memory rather than persisted in job history. Optional retry keys prevent duplicate execution.

A real Electron-hosted bridge test verified first-use native documentation, persistent Discord binding across calls, Friends navigation and restoration, PNG output, the actual upstream `js_reset`, and absence of the old Discord binding after reset. No messages were sent. The browser API was also probed without opening tabs: `cua.listBrowsers()` returned `Missing required Codex turn metadata: session_id, turn_id`. Browser control remains unavailable in this tool-only path; no turn metadata was fabricated.

Validation after this addition: 103 tests total, 102 passed, one Windows-only skip. Tests include HTTP scope enforcement and image passthrough, grant isolation, consent forwarding, reset routing, inline/pending results, idempotency, app blocks, session expiry and preservation of native JavaScript errors.

The REPL build was packaged under `release/cua-repl/mac-arm64/`, signed with the configured certificate, and installed at `/Applications/Codex Link.app`. Deep/strict verification passed, and installed runtime resources matched the current source. The running connector advertises the three JavaScript tools in capabilities. An Electron harness loading the installed resources verified persistent Calculator binding, native first-use documentation and PNG output. The prior app was retained at `/var/folders/81/1hg3nzjn4274kwf603vyp9j80000gn/T/codex-link-before-repl-d4h9rh_i/Codex Link.app`. No fresh DMG or notarization was produced. Existing clients may need to refresh their cached MCP tool list.
