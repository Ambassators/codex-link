# Extending the MCP server

The 16 tool descriptors are in [mcp-tools.json](../docs/mcp-tools.json); handlers live in `src/tools.mjs`.

For a specialized operation, use `Workspaces` to resolve approved paths, declare a bounded input schema and register it through `Tools.add`. Side effects should use `Tools.job` with a client idempotency key, required scopes, a clear title and local approval. Emit progress, honor cancellation and return success only after completion.

Test malformed inputs, denied approval, stale hashes, retry behavior, cancellation and client isolation. Refresh the generated descriptors and the connected client's tool list.

The UI uses textContent for untrusted text. Preserve its credential removal, CSP, origin/host validation and separate listeners. Electron reuses the server/UI with a native folder callback. Keep the renderer isolated and external navigation HTTPS-only.

This app accepts MCP connections; model execution and orchestration belong to the client. Do not add local model logins or outgoing engine sessions to the connection setup.
