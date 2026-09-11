# Capabilities

Codex Link is an MCP server for one computer owner. It accepts incoming authenticated clients and exposes 16 tools:

| Area | Tools |
|---|---|
| Status and folders | `bridge_status`, `workspace_list`, `file_list` |
| Files and search | `file_read`, `file_write`, `file_edit`, `rg_search` |
| Images | `image_read`, `image_write` |
| Shell | `shell_start`, `shell_input` |
| Optional desktop | `computer_screenshot`, `computer_action` |
| Jobs | `job_list`, `job_get`, `job_cancel` |

File/image writes and shell execution require local approval by default. Desktop control requires a locally enabled 15-minute session and the separate Python helper. File tools enforce approved roots; shell commands run with OS-user privileges. Shell input/output uses pipes, not a terminal emulator.

Images are actual MCP image content or supplied image bytes. A chat attachment name does not automatically identify a local file. Long operations return jobs; clients must poll until terminal status. Cancellation does not undo side effects.

The app does not run an AI model, launch a local coding agent, connect to downstream MCP servers, or manage model accounts/plugins. Those belong to the connected MCP client. No local task composer or tool execution endpoint is exposed by the owner UI.

See [testing](TESTING.md) for verification limits and [security](../SECURITY.md) for boundaries.
