# Primary references and dependency provenance

Technical interfaces were checked against the following primary sources on **September 10, 2026**. These are design references, not proof of live external-service or native-platform testing. Documentation and installed runtime versions can diverge; verify current client documentation before changing integration behavior.

| Source | Used for |
|---|---|
| [OpenAI authentication guide](https://developers.openai.com/apps-sdk/build/auth/) | OAuth discovery, PKCE S256, DCR support, bearer use, exact issuer/resource checks, issuer response identification and callback selection. Currently redirects into Plugins documentation. |
| [OpenAI connection/testing guide](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt/) | Manual developer-mode connection flow, public HTTPS `/mcp`, metadata refresh and account/workspace policy caveats. |
| [ChatGPT Plugins](https://chatgpt.com/plugins) | Official destination linked from the connection guide. UI labels can change. |
| [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) | POST/JSON transport, accepted media types, notifications, origin validation and localhost binding guidance. |
| [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) | Protected resource discovery and authorization/resource binding model. |
| [Tailscale Funnel CLI](https://tailscale.com/kb/1311/tailscale-funnel) | Actual publication command, ports, background mode, status and port-specific disable behavior. |
| [Tailscale Funnel requirements](https://tailscale.com/kb/1223/funnel) | Public HTTPS, tailnet/identity/policy constraints. |
| [Homebrew](https://brew.sh) and [Tailscale app cask](https://formulae.brew.sh/cask/tailscale-app) | macOS package-manager setup and current `tailscale-app` cask name. |
| [Microsoft winget install documentation](https://learn.microsoft.com/en-us/windows/package-manager/winget/install) | Windows package-manager invocation and installer behavior. |
| [Official winget manifests](https://github.com/microsoft/winget-pkgs) | Node, ripgrep MSVC, Git, Python 3.12 and Tailscale package identifiers. |
| [PyAutoGUI documentation](https://pyautogui.readthedocs.io/en/latest/) | Primary-monitor desktop automation, screenshots, key/mouse APIs and fail-safe constraints. |
| [Electron releases](https://github.com/electron/electron/releases/tag/v44.3.0) | Optional desktop Electron version pin. |
| [electron-builder releases](https://github.com/electron-userland/electron-builder/releases/tag/electron-builder%4026.16.1) | Optional packaging-tool version pin. |

## License and provenance notes

The project source in this archive is MIT-licensed. Tailscale, Electron, Python dependencies, Homebrew and winget packages retain their own licenses and distribution requirements. Release packages include Electron; no model weights or account credentials are bundled.


The core has no external runtime npm dependencies. Desktop dependencies are locked in desktop/package-lock.json. The optional Python dependencies have their own requirements file.
