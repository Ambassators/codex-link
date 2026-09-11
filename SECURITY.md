# Security model and deployment limits

Codex Link intentionally grants an AI client the ability to read files, change code, execute commands and optionally control a desktop. Those are powerful capabilities. This is a **single-owner, trusted-personal-machine integration**, not a hardened multi-tenant remote-execution platform. The custom OAuth/MCP implementation has tests but has not received an independent security audit or standards certification.

## Trust boundaries

The public OAuth/MCP listener binds to `127.0.0.1:43121`. Tailscale Funnel publishes that listener through public HTTPS. The administrative listener binds separately to `127.0.0.1:43120`, validates Host and Origin, and requires a random per-run credential for its API. It must never be forwarded publicly. A public URL identifies a server; it does not authenticate the local owner.

A private local UI action creates a one-use, 90-second pairing ticket. Opening it in the intended browser establishes a Secure, HttpOnly, SameSite=Lax owner cookie. Only that browser can consent to an OAuth request. The owner must initiate the ChatGPT connection, inspect the requested permissions and redirect, and click Authorize. Merely registering a public OAuth client does not grant any machine access. DCR client names are untrusted display text, not a verified identity.

Authorization uses S256 PKCE, single-use authorization codes, exact allowlisted HTTPS redirect URIs, CSRF-bound consent, issuer identification, resource binding and bounded scopes. Access/refresh secrets are opaque random values; hashes and grant metadata are stored instead of plaintext bearer tokens. The server checks expiration, issuer, resource and scope on each request. Refresh rotation detects reuse and revokes the affected grant family. The scheme is a server-side opaque-token design, not JWT signing.

DCR remains public so ChatGPT can discover/register before the owner authorizes. Endpoints and registry sizes have limits, but an internet attacker can still cause registration pressure or denial of service. Rate limits are not a substitute for a hardened edge. Funnel TLS terminates outside this Node process; this project does not validate OpenAI client mTLS certificates or trust forwarded headers as user identity.

## Execution and approvals

Direct file writes, image writes, shell commands require local approval by default. The model cannot approve its own jobs. Review the **complete request**, not just the abbreviated job title.

Automatic-approval settings are explicit trust escalations. Granting `shell:execute` plus automatic shell approval gives a connector OS-user-level command execution.

A shell working directory does **not** restrict paths, networking, credential access, package installation or process creation. Shell commands retain your ordinary process environment intentionally; only bridge-owned secret environment names are filtered. Use a dedicated low-privilege OS account, separate machine or VM for strong isolation. Do not run the bridge as administrator/root. Individual installers may need a separate privilege prompt.

## Filesystem guarantees and limits

Direct filesystem tools resolve approved real directories, reject traversal and problematic Windows paths, reject symlink escapes and non-regular write targets, and use hash-checked atomic replacement. Existing files require their current SHA-256. Create-only writes must not replace an existing path. Literal editing requires a single exact match. In-process writes are serialized per workspace.

These checks reduce accidental/confused-deputy access. They are **not an OS sandbox** against hostile concurrent local programs. Platform-independent JavaScript path validation cannot eliminate every filesystem race between inspection and open/rename. Hard-linked reads can reveal content already linked into an approved root, although hard-linked write targets are rejected. Do not expose a workspace that an adversarial local user can mutate concurrently. File deletion, arbitrary patching and other powerful operations can still be requested through approved shell execution.

Approved workspace roots cannot contain bridge credentials. Keep state outside all project roots, avoid home-directory or drive-wide access, and keep secrets out of model-visible projects where possible. Repository instructions, code comments, screenshots, tool results and website content can contain prompt injection. They do not authorize new permissions, data exfiltration or unrelated actions.

## Desktop access

The native desktop path requires OAuth `computer:use`, a locally enabled desktop lease, and app/input-mode approval. Temporary leases expire after 15 minutes and reset on restart; explicitly persistent leases survive restart. Native window sessions are always memory-only, bound to the OAuth client and grant plus application/window/process identity, and last at most 15 minutes. Block rules override allows. Foreground and background are separate approvals. The private owner panel alone can change app rules, end any session, or request ordinary macOS permission prompts. The helper cannot approve an OS prompt for itself.

macOS uses ScreenCaptureKit, Accessibility and Quartz. Background event delivery is app-dependent, not a private system cursor or guaranteed focus isolation. Windows uses Windows Graphics Capture, UI Automation and foreground SendInput. Windows background mode permits semantic UI Automation only. Neither backend implements locked use, elevation, secure-desktop input or a privileged authorization plugin. The Windows helper is asInvoker/uiAccess=false and refuses elevated applications. macOS permission requests are explicit owner UI operations, not remotely exposed MCP tools.

Observations expire after 30 seconds and are consumed by an input attempt. Process/window changes, stale element fingerprints, out-of-window coordinates, invalid action arguments and protected fields fail closed. Existing input may already have taken effect on an error; the client must observe again instead of blindly replaying. Foreground operations serialize globally; background operations serialize per app process. Provider calls can block, so bounded subprocess execution and cancellation are outer safeguards rather than transactional guarantees.

Screenshots may contain passwords, messages, health/financial data or unrelated third-party information. Protected accessibility values are redacted, but screenshots are not a general sensitive-pixel redaction system. Native typed payloads are redacted before job persistence. Application content and tool outputs remain untrusted and may contain prompt injection. App permission is not blanket consent to send messages, submit forms, buy, publish or destroy files. Review consequential actions separately.

App rules and known-terminal/security-app exclusions are not an OS sandbox, publisher-signature attestation or protection against a compromised owner account. An allowed application can expose embedded command surfaces, invoke another app, move focus or race human input. The code cannot guarantee isolation from all such behavior. Use a separate OS account/machine/VM for strong isolation. Secure/elevated login and OS security settings must be handled locally.

Both native backends preserve the clipboard by not using it for text input. Pointer-corner fail-safes and held-input checks reduce accidental interference; Windows also checks Escape. Cancellation cannot undo a click, sent keystroke or completed side effect, and forceful process termination may prevent final cleanup. Inspect app state after interruptions.

Legacy `computer_screenshot`/`computer_action` require an additional owner-controlled opt-in that is off by default. They use unscoped PyAutoGUI and bypass native app/window rules; do not use them as a fallback around native denials. The legacy Unicode path restores text clipboard only, not arbitrary clipboard formats. Shell permissions remain independent and are not constrained by native app policy.

See [the native implementation and acceptance checklist](docs/COMPUTER_USE.md). Native code and unit tests have not established 1:1 behavior, security or task-success parity with OpenAI Codex.

## Stops, cancellation and persistence

The red stop control pauses remote MCP, cancels tracked jobs and aborts tracked desktop helpers. Revocation also invalidates grants and browser pairing. Process cancellation uses Unix process groups or Windows `taskkill /t`; commands that deliberately daemonize or escape tracking may survive. This is not a kernel job-object/container confinement system. Inspect and terminate residual processes through normal OS tools when necessary.

Shutdown attempts to drain cancellation before flushing job state. On restart, unfinished jobs are marked interrupted, never automatically replayed. Idempotency keys prevent repeated execution only while the corresponding job remains retained. There is no general rollback or transactional shell. Always review partial results after interruption.

The local state directory contains sensitive project logs, requests, results and grant metadata. POSIX files are created with restrictive modes; the Windows bootstrap protects a fresh directory with user/SYSTEM ACLs. Those protections are not encryption at rest, and reused/preexisting directories may retain explicit ACLs that require inspection. Device encryption and account security remain your responsibility. Processes already running as your account can generally access your files; this design does not defend against a compromised local owner.

Activity redaction hides common token-key names and image-upload payloads in stored requests, but it is not a general secret detector. Prompts, command output, job events and final results can contain secrets or source code. Do not share raw state or logs. The tool audit logs selected metadata and rotates around 5 MiB; it is not tamper-evident or a complete forensic record. Job event buffers are bounded and can evict older entries.

## Before production or sharing

Run the native platform acceptance checklist, live OAuth flow on the intended host. Audit dependencies and commit the optional desktop lockfile. Configure code signing/notarization and a secure update pipeline before distributing binaries. Arrange an independent review of OAuth, browser consent, filesystem races, process boundaries and the Tailscale exposure. Add enterprise identity, tenant isolation, tamper-evident logging and OS-enforced execution isolation before expanding beyond one trusted owner.

Do not publish credentials or enable a live Funnel in CI. The shipped test fixtures are deliberately identified as fixtures and never used as a production runtime fallback. No repository secret or hard-coded working bearer token is supplied.

## Reporting a security issue

No external security-contact address is configured for this generated project. A maintainer should add a verified private reporting channel before public release. Until then, disable the Funnel and revoke grants before investigating a suspected exposure; do not post tokens, pairing URLs, local paths or private logs in a public issue. Keep incident backups private and distinguish bridge revocation from signing out of Tailscale.
