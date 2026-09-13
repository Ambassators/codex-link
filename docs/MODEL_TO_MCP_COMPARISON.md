# Model-to-MCP implementation breakdown

Prepared September 12, 2026, America/Chicago. Covers the macOS implementation inspected in this workspace and the supplied MEE6 trace.

> Subsequent change: `computer_interact` has now been removed from the macOS MCP tool list. macOS actions use `computer_js`; Windows retains structured input. This report preserves the earlier old/new comparison and timing evidence as a historical snapshot. See [the current guide](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/docs/COMPUTER_USE.md>) for the active interface.

## 1. What changed, in plain terms

Your old and new structured implementations both use the installed **Codex Computer Use runtime** to operate apps. The latest change did not replace the input engine. It changed how Codex Link waits for an action, captures the resulting interface, and returns that information to the model.

Previously, a normal step looked like:

```text
Model requests action → receives queued job
Model requests job result → receives completion and some interface text
Model requests observation → receives a fresh observation ID
Model decides next action
```

Now, a short semantic action can look like:

```text
Model requests action
  → bridge performs action
  → bridge checks fresh interface state
  → same response contains completion, interface text, and next observation ID
Model decides next action
```

There is also an existing `computer_js` route. It lets the model submit JavaScript directly to the same Codex CUA REPL, including several known, sequential operations in one call. **That route existed before the latest inline-state change.** It is the closest of your interfaces to the native Codex tool contract.

The main optimization is fewer model/tool exchanges. It does not make Discord process input instantly, remove the remote connection, or guarantee a particular end-to-end response time.

## 2. Scope and evidence

This report uses these definitions:

| Name | Meaning in this report |
|---|---|
| **Native Codex** | The Computer Use tool available to the model inside Codex, exposed here as `mcp__cua_repl.js`, using the persistent `cua` API. |
| **Old structured relay** | Your macOS `computer_windows` / `computer_session_start` / `computer_observe` / `computer_interact` implementation immediately before the inline-state update. This is the path used in the supplied MEE6 run. |
| **New structured relay** | That same adapter with inline job completion and automatic post-action text observations. |
| **Existing raw JS relay** | Your `computer_js`, `computer_js_result`, and `computer_js_reset` interface to Codex's REPL. Covered separately to explain batching. |

“Old” does **not** mean the much earlier custom Swift/Python implementation or the unsuccessful direct-helper experiment. Those are described in the history section below.

Evidence comes from current source, the pre-update installed-source backup, the exported tool calls, local audit timestamps, and job events. The native Codex description is limited to the exposed tool contract and documented capabilities. The proprietary model-service transport, scheduling, and exact internal routing inside Codex are not established by these sources.

The old adapter snapshot is preserved in [the pre-update backup](</Users/jambe/Library/Application Support/CodexLink/backups/inline-state-20260912-201233/Contents/Resources/bridge/src/codex-computer.mjs>). The measured run is [tool-call-data(3).json](</Users/jambe/Downloads/tool-call-data(3).json>), correlated with [audit.jsonl](</Users/jambe/Library/Application Support/CodexLink/audit.jsonl>). Source references later in this document identify the current implementation. Those local logs can contain private data; this report includes only the relevant timing and behavior.

## 3. Comparison at a glance

| Property | Native Codex | Old structured relay | New structured relay | Existing raw JS relay |
|---|---|---|---|---|
| Model-facing tool | `cua_repl.js` | `computer_interact` and related tools | Same structured tools | `computer_js` |
| Input language | JavaScript with documented `cua` API | One structured action | One structured action | JavaScript with documented `cua` API |
| Your public HTTPS/OAuth hop | None in this direct tool path | Yes | Yes | Yes |
| Your argument-to-JS translation | None | Yes | Yes | No; forwards code |
| Underlying app control | Codex Computer Use | Codex Computer Use via app-server | Same | Same |
| Explicit bridge app session | No | Required | Required | No; runtime managed per OAuth grant |
| Bridge observation ID | No | Required before each action | Initial ID required; completed action can supply next ID | No |
| Typical short-action result | Native tool content | Queued job, then separate poll | Completed job with fresh state in the original response | Native content in original response |
| Automatic post-action state | Depends on API/code used | Adapter already appended an AX read, but returned no fresh observation ID | Additional settling captures plus usable text observation | No injected capture; code requests the state |
| Several actions in one JS call | Yes, after required initialization and when actions are known | Not exposed as a batch | Not exposed as a batch | Yes, with the same qualification |
| Inline waiting in your wrapper | Not applicable | None for interaction completion | Up to 3 seconds | Up to 15 seconds |
| Slow-call retrieval | Native host behavior | `job_get` | `job_get` | `computer_js_result` |
| Automatic result image | Depends on requested API | Separate observation can return one | Auto state is text only; explicit observation can return an image | Whatever the code/upstream tool emits |
| Proven post-update speed | No comparable benchmark here | About 105 seconds for the measured run | Not yet measured with a fresh ChatGPT DM run | Not benchmarked against this DM trace |

AX means accessibility: the structured text representation of windows, controls, labels, and their state.

## 4. Native Codex: model to Computer Use MCP

### 4.1 The visible request/response path

```text
User request
  ↓
Model reads task, tool contract, and observed state
  ↓ emits a tool call containing JavaScript
Codex host dispatches the Computer Use tool
  ↓
cua_repl / js
  ↓ executes documented cua APIs in a persistent runtime
Codex Computer Use accesses the selected app or browser
  ↓
Native text / documentation / images / errors
  ↓ through the host's tool-result handling
Model reads the result and chooses its next step
```

This diagram shows logical responsibilities, not a packet-level map of OpenAI's infrastructure. The model produces a tool request; the host executes it. The model itself is not opening a local socket or directly clicking an app.

Codex's official Computer Use documentation describes the desktop capability and setup. The detailed `cua_repl` contract used here is supplied by the installed tool in this session. [Official Computer Use documentation](https://learn.chatgpt.com/docs/computer-use).

### 4.2 Initialization and persistent bindings

The current tool contract requires the first invocation, and the first invocation after reset, to contain exactly one appropriate entry-point API call. For an app, an example is:

```javascript
let app = await cua.getApp("Discord");
```

That invocation returns documentation and initial app state. The model reads those instructions before continuing. A later invocation can use the retained `app` variable.

This saves the need to rediscover and rebind the app for every action. It also means code must manage persistent names and stale references correctly. Resetting the REPL discards bindings; it does not undo app actions.

### 4.3 What batching means here

After initialization, code can run a known sequence using sequential `await` expressions and return state at the end. For example, **once the intended conversation and focused composer have already been verified**, a later call can contain:

```javascript
await app.typeText("test");
await app.pressKey("Return");
await app.getAXState();
```

This is one model-visible tool invocation containing three API operations. It is not three parallel inputs and it is not a JSON-RPC batch array. If opening a conversation reveals information needed to choose the next target, the model must inspect that intermediate state first.

The final AX result still needs to show a new message in the intended conversation. Successful typing and pressing Return are only evidence of input delivery.

### 4.4 What cannot be concluded about native Codex

We cannot assign native model reasoning time, count its internal network hops, promise its cold-start duration, or establish that the direct desktop host uses precisely the same invocation sequence as your external app-server client. The confirmed common point is the exposed Codex CUA tool/runtime; your adapter's own app-server sequence is visible in source.

## 5. Shared Codex Link infrastructure

Both structured versions, and the raw JS relay, use this outer path:

```text
ChatGPT model
  ↓ tool selection and arguments
ChatGPT connector/tool host
  ↓ HTTPS MCP request with OAuth bearer token
Public Tailscale Funnel origin
  ↓ forwards to the local bridge listener
Codex Link HTTP server → MCP router → tool registry
  ↓ authorization, validation, dispatch
Structured adapter OR raw JS adapter
  ↓ newline-delimited local app-server requests over stdin/stdout
codex app-server --stdio
  ↓ mcpServer/tool/call targeting cua_repl/js
Installed Codex Computer Use runtime
  ↓
Target application
```

Results return along the reverse path. Codex Link adds a job wrapper for structured operations; the raw JS route preserves native content and adds small job metadata.

### 5.1 HTTPS and MCP handling

The default local public listener is port `43121`; the owner/admin listener is `43120`. Tailscale Funnel supplies public reachability to the bridge. It is not the OAuth authority: Codex Link issues and verifies its own connector tokens.

The public server checks Host/Origin policy and rate limits requests. The `/mcp` router verifies the bearer token, checks whether remote execution is paused, validates MCP negotiation and JSON, then dispatches methods such as `initialize`, `tools/list`, and `tools/call`.

The implemented protocol-version list is `2025-11-25`, `2025-06-18`, and `2025-03-26`. The endpoint accepts POST requests with a single JSON object, requires an Accept header listing both JSON and event-stream media types, and returns ordinary JSON responses. It does not implement a continuously pushed observation stream. A JSON-RPC array is rejected by the body parser.

The MCP request body limit is 4 MiB. HTTP request/header timeout settings are 30/15 seconds; these are transport settings, **not** a universal 30-second execution deadline for a background job. [HTTP server](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/server.mjs:203>), [MCP router](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/mcp.mjs:8>), [body parser](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/util.mjs:47>).

### 5.2 Tool discovery and validation

`initialize` supplies operating instructions. `tools/list` supplies names, descriptions, argument schemas, OAuth scopes, and annotations. These influence the model's choice of tool and the host's handling of it; they do not execute the action themselves.

For `tools/call`, the registry checks scopes and the public schema, records `tool.called`, and invokes the handler. The handler may apply stricter action-specific validation. Consequently, an audit record proves the call reached handler dispatch, not that input was delivered.

Ordinary returned objects are serialized into both MCP text content and `structuredContent`. Handlers already returning native `content` pass through. Tool exceptions are converted into `isError: true` text results. A missing `toolOutput` in a ChatGPT export is not sufficient to identify which layer failed. [Tool registry](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/tools.mjs:23>), [MCP error handling](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/mcp.mjs:35>).

### 5.3 App-server startup: no second model

Your adapter chooses a Codex executable using `CODEX_CLI_PATH`, then the supported local app locations, and launches:

```text
codex app-server --stdio
```

It then sends `initialize`, the `initialized` notification, and:

```json
{
  "id": 2,
  "method": "thread/start",
  "params": {
    "ephemeral": true,
    "cwd": "<bridge-working-directory>",
    "serviceName": "codex-link-computer"
  }
}
```

This creates context for tool use. **The bridge does not call `turn/start`, submit a task to a second model, or ask a local Codex agent to interpret the remote model's instructions.** It invokes an MCP tool directly in the ephemeral thread.

The documented app-server API includes `mcpServer/tool/call` for calling a thread's configured MCP server and `mcpServer/elicitation/request` for server-initiated consent/input. Your code uses those facilities. [Official app-server API](https://learn.chatgpt.com/docs/app-server), [actual initialization and dispatch](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/codex-app-server-client.mjs:27>).

The subprocess transport matches request IDs with pending promises, reads newline-delimited JSON, drains stderr without persisting it, and closes the connection on timeout, cancellation, malformed output, or process failure. Its buffered-output limit is 24 MiB. Closing rejects pending requests instead of replaying uncertain input. The subclass uses app-server framing; the base class's direct-helper MCP initialization is not the active initialization path. [Transport implementation](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/codex-computer-client.mjs:11>).

## 6. Old structured relay: complete lifecycle

### 6.1 Discover and open the session

The model commonly called `workspace_list` and `bridge_status` because the server instructions requested them. These are bridge discovery steps, not inherently required to type into Discord.

`computer_windows` created a temporary app-server connection, initialized an ephemeral thread, called `cua.getState()`, then made another internal JS call to serialize the app inventory. It closed that connection afterward. Despite the tool name, the macOS relay returned app identities and targeted each app's key window, not a pinned operating-system window.

`computer_session_start` performed another inventory lookup during preparation. It checked the target and local app policy, created a job, and started a separate persistent app-server connection for the approved session. That connection bound `target` using `cua.getApp(appId)` and captured app state to establish access. This initial capture was not returned as the model's usable observation; session completion reported `observationRequired: true`.

Thus an explicit inventory call followed by session start could involve **three app-server instances**: the initial inventory instance, the preparation inventory instance, and the retained session instance. That structure remains in the new structured adapter. [Discovery and session code](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/codex-computer.mjs:49>).

### 6.2 Observe

`computer_observe` used the retained app connection to execute:

```javascript
await target.getAXStateAndScreenshot({disableDiffing:true});
```

It generated a bridge observation ID valid for 30 seconds, capped by session expiry. The observation was usable for one action. The bridge tracked whether that observation included an image, which was required for coordinate-based input.

In the old response, the AX tree was in MCP `content`, while `structuredContent` contained metadata without the tree. In the supplied export, all five text-only observations appeared as metadata only; five image-plus-tree observations included the actual tree and image. This is evidence of an output-shape/host-export mismatch, not proof that the backend never produced the text.

`maxNodes`, `maxDepth`, and `maxImageSide` were accepted fields but were not applied by this Codex relay. A request for 250 nodes still yielded a full tree. The new relay retains that limitation.

### 6.3 Interact

The model submitted one action with its session ID, fresh observation ID, and idempotency key. For example:

```json
{
  "jsonrpc": "2.0",
  "id": 101,
  "method": "tools/call",
  "params": {
    "name": "computer_interact",
    "arguments": {
      "sessionId": "<session>",
      "observationId": "<unused-observation>",
      "action": "invoke",
      "elementId": "<observed-numeric-index>",
      "idempotencyKey": "<unique-operation-key>"
    }
  }
}
```

The handler validated the action, checked session ownership, created a job, and immediately returned its queued status. The job runner serialized work for that app, checked observation freshness, consumed observations for the same app, and translated the action into JavaScript.

| Structured action | Internal translation |
|---|---|
| `invoke` + `elementId` | `target.click(numericIndex)` |
| `click` / `double_click` | `target.click([x, y], options)` |
| `type` + `text` | `target.typeText(text)` in the focused control |
| `set_value` + `elementId` + `text` | `target.setValue(numericIndex, text)` |
| `key` + `keys` | `target.pressKey(chord)`; `enter` maps to `Return` |
| `scroll` | `target.scroll(index, direction, pages)` |
| `drag` | `target.drag([x, y], [toX, toY])` |

Strings are encoded as JavaScript string literals; element indexes are validated as numeric. The connection cannot switch to another app.

For input, the adapter **already appended** an AX read:

```javascript
await target.typeText("test"); await target.getAXState();
```

That code was sent as an app-server request of this shape:

```json
{
  "id": 7,
  "method": "mcpServer/tool/call",
  "params": {
    "threadId": "<ephemeral-thread>",
    "server": "cua_repl",
    "tool": "js",
    "arguments": {
      "code": "await target.typeText(\"test\"); await target.getAXState();",
      "title": "Codex Link Computer Use",
      "timeout_ms": 25000
    }
  }
}
```

The timeout shown is illustrative; the code varies it with context and remaining session time. [Translation implementation](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/codex-app-server-client.mjs:69>).

### 6.4 Return and poll

The old completed job contained a result shaped like:

```json
{
  "sessionId": "<session>",
  "needsObservation": true,
  "backend": "Codex Computer Use",
  "message": "<post-action text, truncated to at most 12,000 characters>"
}
```

It lacked a new observation ID. Even if the text was enough to understand what happened, the next structured action required a separate `computer_observe` call to obtain a valid ID. The model also generally needed `job_get` to retrieve this result because the action call had already returned queued status.

`job_get(waitSeconds: 5)` was a conditional wait, not an unconditional five-second delay. The implementation waits only while a job is active and no new events are available. Supplying no `after` cursor defaults to zero, often making existing events immediately available. In the measured run, every poll arrived after its job had already completed. [Polling logic](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/tools.mjs:93>).

## 7. New structured relay: exactly what the update does

### 7.1 The action still runs as a job

The new implementation retains the existing action validation, job creation, input translation, app queue, ownership checks, observation consumption, and idempotency behavior. It has not added an `actions[]` parameter.

The handler now waits for that job's status to change for up to **3,000 ms**. If the job completes within that window, its final result is returned in the original MCP response. If it remains queued/running, or requires approval, the response tells the model to retrieve the existing job. Approval does not become automatic. [Inline result handling](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/native-computer-tools.mjs:22>).

### 7.2 Automatic fresh state after input

After the existing input-plus-AX operation completes, `stateAfterAction()`:

1. Starts a nominal 1,000 ms settling budget.
2. Captures fresh app state through `get_app_state`.
3. Compares the returned text with the previous capture.
4. Stops early if two consecutive nonempty text results match.
5. Otherwise waits up to 100 ms before another capture, while budget remains.
6. Records the latest result as a new, single-use observation and returns its text and ID.

This is **not a fixed sleep of one second after the click**. The budget begins after the underlying input call returns, which already includes an AX read. A capture started before the budget expires may finish afterward; individual captures can have substantially longer timeouts. Conversely, matching state can return before the full second is used.

The backend currently captures AX plus screenshot during these checks, then omits images from the automatic result. Therefore, text-only output reduces the returned payload but does not yet eliminate internal screenshot acquisition. [Settling loop](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/codex-computer.mjs:127>).

### 7.3 New result shape

The completed job's `result` now includes fields like these; the example omits other metadata:

```json
{
  "sessionId": "<session>",
  "actionCompleted": true,
  "needsObservation": false,
  "observationId": "<new-unused-observation>",
  "expiresAt": 1790000000000,
  "tree": "<fresh interface text>",
  "hasImage": false,
  "stateStable": true,
  "contentIsUntrusted": true
}
```

The model can inspect `tree`, then use this ID for the next semantic action. `expiresAt` is an absolute timestamp in milliseconds; the example value is a placeholder, not a real valid observation.

Explicit `computer_observe` also now includes `tree` in `structuredContent`. Its text content keeps metadata separate from the original AX text instead of adding another tree copy inside the metadata block. This addresses the old export's metadata-only structured shape. It does not prove how every host will render or tokenize the fields. [Observation construction](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/codex-computer.mjs:100>).

### 7.4 Meanings and failure cases

| Returned state | What the model should do |
|---|---|
| Completed, `needsObservation: false` | Inspect returned text; use the fresh ID for the next semantic action before expiry. |
| `stateStable: true` | Treat it as matching sampled text, not proof of network completion or successful sending. |
| `stateStable: false` | Read the latest sample; observe again if the task requires later state. The ID can still be usable. |
| `actionCompleted: true`, `needsObservation: true` | Input returned successfully but a usable fresh observation is unavailable. Observe; do not repeat the input. |
| Queued/running | Poll the returned job ID; do not create a duplicate action. |
| Awaiting approval | The local owner must resolve the actual approval request. |
| Input/transport error | Input may be uncertain. Inspect current state before deciding whether anything needs repeating. |
| Coordinate action after automatic text result | Request an image observation first. `hasImage: false` cannot authorize pixel input. |

The inline response path rechecks whether a returned observation is still current, including when retrieving an existing operation through the same idempotency key. That prevents treating an old completed response as a permanently reusable observation. Generic `job_get` returns the stored job result; its old `needsObservation` value is not a fresh validity check, and the next action still enforces expiry/currentness.

### 7.5 Tradeoff

The new structured path does more local state-capture work per action. It aims to save more time by removing separate remote polls and observations. On a fast local loop, the extra captures may be a noticeable cost; on the measured remote workflow, unnecessary model/tool exchanges were much larger than individual action durations.

The old `message` field is still retained alongside the new full `tree`. Some text is therefore redundant. The generic MCP wrapper can also serialize result data into both content and structured content. Actual host/model duplication and token costs have not been measured.

## 8. Existing `computer_js` route and batch calls

### 8.1 Path

```text
Model writes code
  → ChatGPT connector
  → HTTPS/OAuth → Codex Link tools/call: computer_js
  → scoped, idempotent job
  → persistent REPL for this OAuth client + grant
  → app-server mcpServer/tool/call: cua_repl / js
  → native content returned through the bridge
  → model
```

This route forwards code, title, and execution timeout. It does not translate `invoke` into `click`, insert observation snippets, mint observation IDs, or require `computer_session_start`. Native documentation, text, images, JavaScript errors, and metadata pass through; the wrapper adds `_meta.codexLink` job information. [REPL tools](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/computer-repl-tools.mjs:7>), [runtime lifecycle](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/computer-repl.mjs:9>).

### 8.2 Persistence, waiting, and limits

| Setting | Current raw JS behavior |
|---|---|
| Required scopes | `computer:use` and `shell:execute` |
| Persistence boundary | One runtime per OAuth client + grant, not automatically per ChatGPT conversation |
| App bindings | Multiple variables/app bindings can persist in that runtime |
| Concurrency | Serialized within a grant; no concurrent calls on one app-server client |
| Idle expiry | 15 minutes, bounded by the desktop permission deadline |
| Runtime capacity | Up to eight runtime sessions |
| Default code timeout | 30 seconds; exposed maximum 600,000 ms |
| Wrapper transport allowance | Requested/default code timeout plus 5 seconds, capped by remaining desktop lease |
| Inline wait | Up to 15 seconds |
| Pending result retrieval | `computer_js_result`, default 15-second wait, maximum 20 seconds |
| Result retention | Temporary memory, 15-minute TTL and 32 MiB total cache bound; eviction/restart can remove results earlier |
| Reset | Calls upstream `js_reset`; discards variables without closing apps/tabs or undoing actions |

The local first-use execution approval depends on owner settings. Codex runtime consent remains independent. Explicit local app blocks disable arbitrary raw JS because the bridge cannot reliably enforce those app restrictions on arbitrary code.

Native result content is not persisted as the job result; the job stores a retrieval marker. However, the job request includes the raw JavaScript, and code can contain typed strings. “Results are held in memory” must not be confused with “nothing from the request is persisted.”

### 8.3 Three different meanings of batch

| Meaning | Supported here? | Consequence |
|---|---|---|
| Several awaited API operations inside one JS invocation | Yes, native CUA and `computer_js`, after initialization and with sufficient observed context | Saves model/tool exchanges while preserving local operation order. |
| JSON-RPC array containing several requests to `/mcp` | No in this bridge | The JSON parser requires one object. |
| Multiple tool calls issued concurrently by a host | Host-dependent; not evidence of UI batching | Same-runtime/app operations may queue, and dependent input must retain order. |

Therefore the answer to “doesn't the Codex MCP support batch calls?” is: **the exposed JavaScript tool supports composing multiple sequential operations in a single tool call. Your raw JS relay already exposes that. Your structured relay does not expose an action batch, and your public endpoint does not accept JSON-RPC batch arrays.**

### 8.4 Remaining raw-route limitations

A previous real probe recorded browser APIs failing with `Missing required Codex turn metadata: session_id, turn_id` in the tool-only ephemeral app-server path. The current tool description still advertises this limitation. The inline-state change did not resolve or freshly retest it. Native desktop Codex and this external tool-only context should not be assumed to have identical browser support.

Two ChatGPT conversations using the same OAuth grant can share the raw runtime's variables. That is a real difference from an automatically separate per-conversation runtime. The current bridge has no dedicated conversation key for this route. Historical raw-route acceptance tests and limitations are recorded in [the relay implementation notes](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/docs/CODEX_RUNTIME_RELAY.md>).

## 9. Why the MEE6 run took so long

### 9.1 Measurement boundaries

The export contains **32 calls**. The locally timed interval begins at the first recorded `workspace_list`, **September 12 at 7:54:28.899 PM CDT** (`2026-09-13T00:54:28.899Z`). It ends at `computer_session_end`, **104.827 seconds later**.

The new message is visible in the final successful Enter operation's returned state, whose job finished at **t = 100.620 seconds**. That timestamp is a job-result boundary, not the exact Discord server acceptance time. The export does not establish time spent before the first local request or generating the final model answer.

### 9.2 All exported calls

Times below are seconds since the first local request. A dash means the exported call had no matching local tool-dispatch timestamp. Observation and action times are request arrivals, not completion times.

| # | t (s) | Call | Relevant result or purpose |
|---|---:|---|---|
| 1 | — | `list_resources` | Null exported result; no matching local dispatch. |
| 2 | 0.000 | `workspace_list` | Bridge discovery. |
| 3 | 1.757 | `bridge_status` | Bridge/capability discovery. |
| 4 | — | `list_resources` | Null exported result. |
| 5 | — | `list_resources` | Null exported result. |
| 6 | 6.471 | `computer_windows` | App inventory. |
| 7 | 10.883 | `computer_session_start` | Session job; completed at 12.895. |
| 8 | 13.154 | `job_get` | Retrieved completed session. |
| 9 | 15.079 | `computer_observe` | Text-only request; export shows metadata. |
| 10 | 18.051 | `computer_observe` | Image and full AX tree. |
| 11 | 22.147 | `computer_interact`: `invoke` | Opened intended DM; job completed at 23.255. |
| 12 | 25.417 | `job_get` | Retrieved completed action. |
| 13 | 27.522 | `computer_observe` | Text-only request; metadata in export. |
| 14 | 32.232 | `computer_observe` | Image and full AX tree. |
| 15 | 37.427 | `computer_interact`: `type` | Included invalid `elementId`; null exported result. |
| 16 | 41.294 | `computer_observe` | Another image and full tree. |
| 17 | 47.273 | `computer_interact`: `set_value` | Composer displayed `test`; completed at 48.096. |
| 18 | 48.987 | `job_get` | Retrieved completed action. |
| 19 | 51.366 | `computer_observe` | Text-only request; metadata in export. |
| 20 | 55.240 | `computer_interact`: `key` | First Enter; completed at 56.309. |
| 21 | 60.329 | `job_get` | Composer empty; input completed, but new message not established. |
| 22 | 65.935 | `computer_observe` | Full state did not show the new message. |
| 23 | 72.597 | `computer_observe` | Another full state; still no new message. |
| 24 | 82.356 | `computer_interact`: `invoke` | Focused composer; completed at 83.195. |
| 25 | 86.508 | `job_get` | Retrieved completed focus action. |
| 26 | 88.389 | `computer_observe` | Text-only request; metadata in export. |
| 27 | 92.148 | `computer_interact`: `type` | Typed `test` normally; completed at 93.209. |
| 28 | 94.078 | `job_get` | Retrieved completed typing action. |
| 29 | 96.140 | `computer_observe` | Text-only request; metadata in export. |
| 30 | 99.827 | `computer_interact`: `key` | Second Enter; completed at 100.620 with new message visible. |
| 31 | 101.584 | `job_get` | Retrieved successful result. |
| 32 | 104.827 | `computer_session_end` | Closed the bridge app session. |

The counts are three resource-list attempts, three discovery calls, session start/end, ten observations, seven interaction attempts, and seven job polls. Six interaction attempts created completed jobs; the invalid type attempt failed before job creation.

### 9.3 How much time was measured inside the bridge?

| Measurement | Time |
|---|---:|
| Seven completed jobs, creation to finish | 7.215 s |
| Those same jobs, runner start to finish | 7.046 s |
| Ten observations, arrival to observation creation | 4.506 s |
| Combined creation-to-finish jobs plus observation intervals | 11.721 s |
| Rest of the 104.827-second timed interval | 93.106 s |

The observation durations were inferred from `expiresAt − 30,000 ms`, consistent with the old adapter's creation logic and this session's remaining lifetime. Individual observation intervals were 0.425–0.481 seconds.

The 93.106-second remainder is **not a measurement of model reasoning alone**. It includes uninstrumented discovery/preparation work, response serialization and transfer, host processing, scheduling, model work, and other gaps outside the selected intervals. These logs cannot divide that remainder accurately among those causes.

The median interval between locally recorded tool requests was 3.723 seconds; the longest was 9.759 seconds. These arrival-to-arrival intervals include preceding tool work as well as the gap before the next call, so they are not independent measurements of network latency.

### 9.4 Polling cost

Every `job_get` arrived after its job finished. Completion-to-poll delays were:

```text
0.259, 2.162, 0.891, 4.020, 3.313, 0.869, 0.964 seconds
```

The bridge was not sitting in seven forced five-second sleeps. The avoidable cost was requiring the host/model to make a separate retrieval call after a short operation had already finished. Inline completion directly addresses that pattern.

### 9.5 The invalid type call

The failing call included `action: "type"`, `text: "test"`, and `elementId`. The public schema lists all those properties, but the action-specific validator permits only `text` for the `type` variant. The reproducible local error is:

```text
Unexpected elementId for type
```

The audit confirms the request reached the bridge. There is no action job for it. This supports an argument-validation explanation for this trace; the null exported result does not prove a platform safety rejection. The earlier screenshot's wording alone cannot establish the cause of a different failed attempt.

The new tool description clarifies the distinction, but its schema remains flat. It has not been redesigned into action-specific schema alternatives. The same invalid combination will still be rejected. [Validator](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/native-computer.mjs:26>).

### 9.6 The first send did not establish success

`set_value` made the composer display `test`. The first Enter completed and the composer became empty, but subsequent full observations still showed the earlier message rather than a newly sent one. The model then focused the composer, used normal typing, and pressed Enter again. The final state showed the new `test` at the current time.

There were **44.311 seconds between the first Enter job finishing and the successful second Enter job finishing**. That recovery occupied a large part of the run.

One plausible explanation is that setting the accessibility value did not update Discord's editor state in the same way as ordinary typing. This remains a hypothesis: the trace does not inspect Discord's internal input events or state. Inline observations can expose the result sooner, but they do not change how `setValue` works.

### 9.7 Output volume and repeated observations

The five exported full AX trees contained 938–1,024 lines and 37,405–42,995 characters each, despite `maxNodes: 250`. The entire export was 1,551,696 bytes, including image representation and wrapper data. That file size is not a measurement of model tokens or bytes transferred over the live connection.

Repeated large snapshots increase the amount of information returned and processed. The new text result avoids automatically returning screenshots to the model, but the AX trees are still unbounded by the exposed size/depth arguments.

## 10. Authentication, permissions, and expiry are separate layers

The earlier OAuth changes and the latest performance changes solve different problems.

| Layer | Current behavior | Changed by inline-state update? |
|---|---|---|
| Connector access token | No scheduled expiry in your current OAuth store; can still become invalid through revocation or changed issuer/resource/state | No |
| Refresh token / grant | No scheduled expiry; refresh tokens still rotate, and reuse of a consumed refresh token revokes the grant | No |
| OAuth authorization code / browser pairing | Temporary setup mechanisms; their expiry remains | No |
| Local desktop permission | Owner-controlled enablement/lease or persistent setting | No |
| Structured app session | Up to 15 minutes, capped by desktop permission deadline | No |
| Structured observation | 30 seconds and one action, capped by session expiry | New actions issue another fresh one; lifetime rule unchanged |
| Raw JS runtime | 15 minutes idle, capped by desktop permission deadline | No |
| Codex account/app consent | Managed upstream by Codex; distinct from your connector OAuth | No |
| Host tool review | Host-managed, influenced by tool metadata and policies | No |

Before the earlier OAuth fix, the project used expiring access/refresh authorization. That fix preceded the MEE6 trace and the inline-state update. Therefore, the old and new **structured baselines compared here already share the non-expiring connector-token behavior**. It would be misleading to attribute the timing improvement to making OAuth tokens permanent. [OAuth issuance and validation](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/oauth.mjs:141>).

Tool annotations remain generated as `readOnlyHint: readOnly`, `destructiveHint: !readOnly`, and `idempotentHint: readOnly`. The blanket destructive-flag removal discussed earlier was not implemented. The existence of an explicit idempotency key in a handler is separate from the descriptor's broad idempotence hint.

The bridge forwards supported upstream empty-form app consent into a local approval request. Unsupported forms are cancelled, and declined consent remains declined. Local dangerous mode does not manufacture Codex app consent. [Consent forwarding](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/codex-app-server-client.mjs:35>).

Structured sessions bind to both client and grant. Generic job access checks client/scopes and checks grant only when a job carries `grantId`; raw JS jobs explicitly set it. The structured job-creation wrapper does not currently populate that field. Session isolation and historical job-result isolation should therefore not be described as identical. [Job access checks](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/jobs.mjs:19>).

## 11. Older implementations, for historical context

| Stage | Path and status |
|---|---|
| Legacy desktop helper | Bridge jobs invoked the project's Python desktop helper. Current macOS relay selection disables this path. |
| Custom native backend | Project-owned native app/window accessibility and input code, including Swift on macOS and a separate Windows implementation. Windows still uses its native backend. |
| Direct Codex helper experiment | Attempted to launch `SkyComputerUseClient mcp` directly. Some probes listed apps, but an Electron-hosted probe received sender-authentication error `-10000`. It was not a working drop-in production route. |
| App-server structured relay | Uses `codex app-server --stdio`, an ephemeral thread, and `cua_repl/js`. This is the “old structured” baseline measured above. |
| Raw JS relay addition | Exposed the persistent native-style REPL through `computer_js`; existed before the current inline update. |
| Inline-state structured update | Preserves app-server/input engine, adds completed results and fresh text observations to short structured action responses. |

The transport base class still contains the direct-helper code. Its presence does not mean current macOS actions bypass app-server. `Computer` selects `CodexComputer` on macOS, which creates `CodexAppServerClient`. [Backend selection](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/computer.mjs:8>), [historical acceptance notes](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/docs/CODEX_RUNTIME_RELAY.md>).

## 12. Expected performance and remaining work

### 12.1 What the new implementation can save

For a short semantic action in an established session:

```text
Old common cycle: interact → job_get → observe → next decision
New common cycle: interact (includes completion + fresh state) → next decision
```

That changes a common three-call cycle into one. It does not imply the complete MEE6 run shrinks by exactly two thirds: discovery, errors, recovery, task verification, image requirements, model choices, and variable response times remain.

Raw JS can reduce exchanges further by grouping known sequential inputs and returning one final state. Its benefit depends on sufficient observed context and correct use of the API. A batch that chooses a target before inspecting a newly opened screen can be faster at doing the wrong thing.

### 12.2 Specific remaining inefficiencies

| Issue | Current status / possible next improvement |
|---|---|
| Duplicate inventory at session start | Still present; consider reusing sufficiently fresh discovery without dropping target validation. |
| Session startup capture discarded | Still present; potentially return the initial observation with session completion. |
| Existing AX read plus settling captures | Still present; consider reusing the first valid state sample. |
| Screenshots captured internally for text results | Still present; investigate a true AX-only capture path with equivalent state guarantees. |
| Full AX trees despite size arguments | Still present; either implement honest bounding or remove misleading controls from the relay-specific schema. |
| Flat action schema | Description improved; schema can still invite invalid property combinations. |
| Structured job state can age while waiting | Input checks reject stale IDs; generic `job_get` does not refresh the state itself. |
| Both old message and new tree returned | Potential redundant payload; measure host rendering before changing response compatibility. |
| Browser metadata in raw relay | Known limitation remains; requires a supported upstream context solution. |
| End-to-end tracing | No request correlation across model dispatch, host transport, bridge execution, and response consumption. |

These are identified follow-ups, not changes made by writing this report.

### 12.3 Validation already performed

The inline-state implementation was previously checked with **56 targeted tests** across the Codex adapter, HTTP integration, and native interaction tests. Coverage included next-action observation chaining, image requirements, stale/reused observations, capture failure after completed input, changing-state settling, inline completion, slow-job fallback without replay, and upstream consent behavior. The reported syntax check passed 55/55 files.

The changed runtime resources were installed into the signed app, which was restarted and checked for public health. Those checks establish deployment and the tested behavior; they are not a new timed ChatGPT-to-Discord benchmark.

No new DM was sent to prepare this document. A fair performance comparison still needs a fresh, explicitly authorized run with the same app starting state and timing boundaries, distinguishing cold setup from a warm action loop. Record model-visible call count, request/response times, backend durations, payload sizes, and whether the new message is actually visible. Until then, “fewer required exchanges” is supported; a specific number of seconds saved is not.

## 13. Source map and reproducibility

The comparison is a working-tree/source-backup snapshot, not a claim that these changes correspond to one committed revision. Several implementation files are currently untracked or modified in the repository.

| Source | Responsibility |
|---|---|
| [src/server.mjs](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/server.mjs>) | HTTP listeners, public/admin separation, routing, audit logging |
| [src/mcp.mjs](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/mcp.mjs>) | MCP negotiation, instructions, discovery, call/error envelopes |
| [src/tools.mjs](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/tools.mjs>) | Schemas, scopes, annotations, dispatch, job wrappers and polling |
| [src/jobs.mjs](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/jobs.mjs>) | Persistent jobs, events, cancellation, local approvals |
| [src/computer.mjs](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/computer.mjs>) | Platform backend selection |
| [src/codex-app-server-client.mjs](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/codex-app-server-client.mjs>) | App-server startup, CUA calls, consent and structured-to-JS translation |
| [src/codex-computer-client.mjs](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/codex-computer-client.mjs>) | Shared subprocess transport and older direct-helper implementation |
| [src/codex-computer.mjs](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/codex-computer.mjs>) | macOS sessions, app queues, observations, actions and new settling loop |
| [src/native-computer-tools.mjs](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/native-computer-tools.mjs>) | Structured public tools and inline-result wait |
| [src/native-computer.mjs](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/native-computer.mjs>) | Shared/native interaction validation and session foundations |
| [src/computer-repl.mjs](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/computer-repl.mjs>) | Persistent per-grant raw REPL lifecycle |
| [src/computer-repl-tools.mjs](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/computer-repl-tools.mjs>) | Raw JS tools, inline wait, result cache and retry handling |
| [src/oauth.mjs](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/src/oauth.mjs>) | Connector authentication and non-expiring-token changes |
| [computer/SKILL.md](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/computer/SKILL.md>) | Guide served to connector clients |
| [docs/COMPUTER_USE.md](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/docs/COMPUTER_USE.md>) | User/developer computer-use workflow |
| [docs/CODEX_RUNTIME_RELAY.md](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/docs/CODEX_RUNTIME_RELAY.md>) | Integration history and prior live acceptance results |
| [test/codex-computer.test.mjs](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/test/codex-computer.test.mjs>) | Adapter/settling/consent tests |
| [test/http.test.mjs](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/test/http.test.mjs>) | HTTP MCP behavior, inline/fallback and result tests |
| [test/native-computer.test.mjs](</Users/jambe/Documents/Foreground/CodexMCP/codex-link/test/native-computer.test.mjs>) | Native/shared action and session invariants |

SHA-256 fingerprints of selected current files at report creation:

```text
cbbf2c487517c8cc82fd475d40d4678cc4b13f51f071607295d5bd25c5b60ec7  src/codex-computer.mjs
e58f494dc7d961360031fef50613692c6901d81fcb74a93d72206061ef09633a  src/native-computer-tools.mjs
bc6b03e629541a3212425ce803d6ae8d63ce566dc482ac49dcd7fb2703f042b0  src/mcp.mjs
ca82658a4c53ef3da85593771da16d78237518a90b410f6f4b8232354d62eba8  src/codex-app-server-client.mjs
d255c66fb31bdac4ef476b98ff24574de49d605a2b5793bc9296ba283600db63  src/computer-repl-tools.mjs
```

Old comparison files are in the [pre-inline adapter backup](</Users/jambe/Library/Application Support/CodexLink/backups/inline-state-20260912-201233/Contents/Resources/bridge/src/codex-computer.mjs>), [pre-inline tool-wrapper backup](</Users/jambe/Library/Application Support/CodexLink/backups/inline-state-20260912-201233/Contents/Resources/bridge/src/native-computer-tools.mjs>), and [pre-inline MCP-instructions backup](</Users/jambe/Library/Application Support/CodexLink/backups/inline-state-20260912-201233/Contents/Resources/bridge/src/mcp.mjs>). The raw tool export and audit data establish the old run; they do not establish new-run speed.
