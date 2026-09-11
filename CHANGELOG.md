# Changelog

## Unreleased

Added independent native computer-use implementations: Swift/ScreenCaptureKit/Accessibility/Quartz on macOS and C#/Windows Graphics Capture/UI Automation/SendInput on Windows. Added six native MCP tools, client-bound window sessions, app/mode local approvals, fresh observation tokens, semantic actions, DPI-aware coordinates, typed-text redaction, cancellation and owner app-policy controls. Added an original computer-use skill and MCP resource, platform build scripts, native packaging checks and tests. Legacy unscoped PyAutoGUI now requires a separate explicit local opt-in. This is not a claim of 1:1 Codex parity; private cursors, privileged locked use and real-app compatibility across both platforms are not established by the build/unit tests.

Connection setup no longer requires choosing a folder first. After ChatGPT authorizes, the app offers to import local Codex projects and index their conversations read-only, add projects manually, or skip project setup. Added `conversation_list` and `conversation_read` MCP tools for imported history tied to currently shared projects.

## 0.2.0 — MCP-only connection app

Removed local Codex engine installation, login, tasks, catalogs, native sessions and scopes. Removed the local tool runner. Added a three-step connection flow, native desktop folder picker, automatic folder naming, inline connection progress, connected-client status and pause/resume. Advanced diagnostics and callbacks now live in Settings.

Existing external software and credentials are left untouched. New packages are unsigned.
