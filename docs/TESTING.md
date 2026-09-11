# Test coverage — 0.2.0

Validated locally on macOS Apple Silicon:

- JavaScript syntax checks: 28 files passed.
- Node suite: 39 tests, 38 passed, one Windows-only test skipped, zero failures. Output: `docs/test-results.txt`.
- Chromium browser integration: folder creation and automatic naming, progressive setup, owner cookie/consent/redirect/PKCE/bearer exchange, a real incoming MCP file write gated by UI approval, activity rendering, pause/resume, and bootstrap-token removal from the address bar.
- Packaged Apple Silicon app: launched with isolated temporary state, rendered the folder-picker action and new setup, and removed the bootstrap token from the URL. Native dialog selection was not automated.
- Both Mac DMGs passed hdiutil integrity verification; the combined Windows x64/ARM64 EXE was built successfully.
- Layout checks across Connection, Activity and Settings at 375, 430, 768 and 1100 pixels, with screenshots in `docs/screenshots/`.

The suite asserts that all five former engine tools, both local engine routes and the local tool runner are unavailable. OAuth metadata advertises only the five remaining scopes. The desktop folder callback is protected by owner authentication. Existing tests cover file CAS/path checks, job isolation, cancellation, direct shell execution, images and OAuth refresh/revocation.

Tailscale unit tests use an explicit process fixture for login, forwarding, existing-listener protection and failure rollback. Browser tests run a real temporary local server and Chromium, intercepting only the final ChatGPT callback. They do not access a real ChatGPT account or publish a live tunnel.

Run:

```sh
npm run check
npm test
# Optional browser integration dependencies:
python -m pip install playwright
python -m playwright install chromium
python test/ui_browser.py
```

The Windows installer must still be tested on Windows. Production ChatGPT connection setup, a live Tailscale Funnel and OS desktop capture/input permissions require testing on the intended machine. Packaging success is separate from signing/notarization and installation testing. CI definitions are provided; this local run does not claim CI completion.

## Native computer backends

`npm run computer:test` tests client/grant isolation, app approvals, observation freshness, coordinate transforms, cancellation, idempotency and typed-text redaction with an injected native transport. The HTTP suite also checks owner-only policy/permission routes and the computer-use skill resource. These tests do not capture or control the host desktop.

`npm run computer:build` compiles the current native target and runs its pure `--self-test` when host architecture matches. Cross-builds do not execute the target binary. The native CI workflow builds macOS/Windows arm64/x64, while the desktop workflow includes a matching helper before packaging. Native packaging hooks check the source hash and exclude unrelated binaries.

A real-platform app acceptance pass remains required for capture, UI Automation/Accessibility, background delivery, DPI, OS permissions, focus races and protected/locked interfaces. See `docs/COMPUTER_USE.md`. Never equate a successful input return, build or mock test with observed GUI task completion.
