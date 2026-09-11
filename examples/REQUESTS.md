# MCP examples

Start with `workspace_list` to find the shared folder name.

Read a file with `file_read`:

```json
{"workspace":"my-project","path":"README.md"}
```

Use the returned SHA-256 when calling `file_edit`:

```json
{"workspace":"my-project","path":"README.md","oldText":"Old heading","newText":"New heading","expectedHash":"<sha256 from file_read>","idempotencyKey":"edit-readme-001"}
```

This returns a job. Ask the owner to approve it in Activity, then poll `job_get` with `{"jobId":"<returned id>"}` until completed. Reuse an idempotency key only for retries of the exact same operation.

Run a command with `shell_start`:

```json
{"workspace":"my-project","command":"npm test","idempotencyKey":"test-001"}
```

It also waits for local approval by default. Poll its job to read stdout/stderr and final status. Commands run as the OS user; cwd is not a sandbox.

`image_read` accepts a workspace and path and returns actual image content. `image_write` accepts image bytes, expectedHash and an idempotency key. `computer_screenshot` and `computer_action` require the owner to enable the optional desktop session in Settings.
