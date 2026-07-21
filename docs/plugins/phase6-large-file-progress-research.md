# Phase 6: Large-file handoff and long-running Action progress

> Research date: 2026-07-16
> Scope: local file inputs, large binary Artifacts, Managed Worker progress, cancellation, event identity, and backpressure
> Decision status: implementation recommendation; no Runtime code is changed by this document

## 1. Decision in one page

SheJane should not copy the attachment transports of Codex or Pi. Both products can accept a local image or an attached image, but their current implementations still read the whole image/file and eventually use base64. They therefore do not solve the plugin case: a 500 MB workbook, video, archive, or generated document must not pass through JSON, LangGraph state, SSE, or SQLite as bytes.

The reusable parts are narrower:

- Codex gives each running command/process a stable handle, emits bounded output deltas, exposes explicit terminate/kill, and makes the terminal event authoritative.
- Pi gives each tool call one `toolCallId`, an `AbortSignal`, and an `onUpdate` callback; its built-in Bash tool additionally throttles updates and spills complete output to a temporary file.
- LangChain/LangGraph provide an in-process `StreamWriter`/`get_stream_writer()` bridge, but do not add application identity, durability, cancellation, or producer backpressure.
- Deep Agents use paths plus paginated reads to keep large text out of model context. The version pinned by SheJane still materializes a generic large tool result before offloading it; newer capture-at-source support is opt-in and limited to sandbox shell output.

The minimum SheJane design is therefore:

1. Import each user input once into a Runtime-owned immutable file store while hashing it incrementally. Keep the existing public `/input/...` reference; never put file bytes in the invocation JSON.
2. Let Managed Workers open authorized `/input` files directly. Keep the current WASI byte ABI small-file-only until it has a real streaming resource/handle ABI.
3. Keep every Action output on `/output`, then stream-validate and promote it into a Runtime-owned Artifact body store. SQLite stores identity and metadata, not base64 bodies.
4. Extend the existing Managed Worker JSONL loop with typed progress notifications and a cancel request carrying both stable `operation_id` and attempt-specific `invocation_id`.
5. Coalesce progress before calling the captured LangGraph stream writer. Translate the namespaced custom payload into transient `tool.progress` SSE. Persist only the latest snapshot on the existing tool receipt; the durable terminal receipt remains authoritative.
6. Use the existing `ActionExecutor` and receipt path for both adapters. This is a storage and transport improvement, not a second plugin execution path.

## 2. Runtime stage mapping

This work primarily belongs to **P10: execute a tool or wait for the user**.

| Contract | Phase 6 responsibility |
| --- | --- |
| Immediate upstream: P9 | Supplies a complete, ordered tool call with a stable tool-call identity. |
| Primary: P10 | Resolves `operation_id`, prepares the receipt, materializes authorized inputs, invokes the Action, emits live progress, handles cancellation, and promotes Artifact candidates. |
| Immediate downstream: P11 | Stops the Worker/process tree, closes pipes and staging leases, and proves that no producer can still modify `/output`. |
| Settlement: P12 | Atomically binds the terminal tool receipt and Artifact metadata to the Run. Immutable bodies may be promoted before the transaction; unreferenced bodies are garbage-collected if settlement loses its lease. |
| Client projection | LangGraph custom stream and SSE are a lossy projection of P10 activity, not a new canonical Runtime stage. |

Canonical state owners:

- `local_tool_receipts`: operation status and the latest coalesced progress snapshot;
- Runtime input store: immutable admitted input bodies;
- Runtime Artifact store plus `local_artifacts`: immutable output body plus authoritative metadata;
- `local_events`: durable lifecycle/terminal events only, not every progress tick.

Old paths being replaced:

- per-invocation source-file copy as the only input lifetime guarantee;
- WASI `read_bytes()` for arbitrarily sized input;
- plugin output `read_bytes()` → base64 → `local_artifacts.content`;
- Managed Worker `exchange()` assuming that the next stdout frame is always its response;
- untyped `agent.custom` persistence for any future progress payload.

The target stage numbering comes only from [`harness-runtime-stages.md`](../harness-runtime-stages.md); the current implementation flow remains documented in [`run-loop.md`](../run-loop.md).

## 3. Current SheJane facts

### 3.1 Inputs are already references, but admission is still small-file oriented

[`runs.py`](../../runtime/src/shejane_runtime/runs.py) creates plugin input descriptors with:

```text
id, /input/<id>/<name>, media_type, size_bytes, sha256
```

Hashing is incremental, which is correct. However:

- attachment admission is streamed into Runtime-owned storage with a 200 MiB
  per-file/per-Run ceiling, while direct model reads are capped at 200 MiB for
  task attachments and PDF files and 20 MiB for other files;
- the descriptor retains the original host `source_path` until Action execution;
- [`plugins/tools.py`](../../runtime/src/shejane_runtime/plugins/tools.py) copies every selected input into a new execution directory;
- [`plugins/executor.py`](../../runtime/src/shejane_runtime/plugins/executor.py) reads every authorized WASI input with `read_bytes()`.

Managed Worker already has the right external shape: it receives reference metadata and an authorized input root rather than file bytes in JSON. The missing part is a Runtime-owned immutable lifetime and a no-whole-file-buffer guarantee.

### 3.2 Artifact staging is sound, but persistence is not suitable for binary files

Both adapters produce candidates under `/output`, and Runtime rechecks path confinement and limits. The final promotion in [`plugins/tools.py`](../../runtime/src/shejane_runtime/plugins/tools.py), however, currently:

1. calls `read_bytes()`;
2. base64-encodes the whole body;
3. writes that text to `local_artifacts.content` in SQLite.

The `bytes` quota in [`store/sqlite.py`](../../runtime/src/shejane_runtime/store/sqlite.py) consequently measures the encoded UTF-8 string, so a binary payload also pays base64 expansion. `GET /v1/artifacts/{id}` returns the body inside JSON.

The Runtime already has a better local delivery primitive: [`server.py`](../../runtime/src/shejane_runtime/server.py) uses `FileResponse` for authorized workspace documents. Artifact delivery can reuse that streaming HTTP shape while retaining Artifact-owned authorization.

### 3.3 The live stream is bounded at the SSE edge, but not at the LangGraph producer

[`runs.py`](../../runtime/src/shejane_runtime/runs.py) invokes LangGraph with `stream_mode=["updates", "messages", "custom", "checkpoints"]`. Each SSE subscriber has a queue of 256 entries; a full queue drops notifications, while durable events are recovered by polling SQLite.

There are two important details:

- [`event_translator.py`](../../runtime/src/shejane_runtime/event_translator.py) maps every custom part to the generic `agent.custom` event.
- `agent.custom` is not in `TRANSIENT_RUN_EVENT_TYPES`, so using it directly for high-frequency progress would append every tick to `local_events`.

The Managed Worker reader is bounded by line size and stderr size, but `exchange()` accepts only a direct response. It cannot currently consume interleaved `notifications/progress` frames or send a cancel request with an acknowledgement.

## 4. Primary-source comparison

### 4.1 Codex

What is built in:

- The TypeScript SDK accepts `local_image.path`, so the request can carry a path instead of caller-provided base64. Codex then reads the whole image and converts it for model input; this is not a general or zero-copy file reference. The App Server's `turn/start` input union has no arbitrary-file handle or stream. See the [SDK input example](https://github.com/openai/codex/blob/main/sdk/typescript/README.md#attaching-images), [user input types](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L288-L337), and [local-image implementation](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs#L1602-L1655).
- `fs/readFile` returns the whole file as base64. It is a filesystem utility, not a large-file transport. See the [filesystem methods](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#example-filesystem-utilities).
- `command/exec` has a client-supplied `processId`, ordered output notifications, stdin/PTY control, terminate, timeout, and independent stdout/stderr byte caps. The response is sent only after all output notifications, and connection loss terminates the process. See the [command execution contract](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#command-execution).
- The agent event lifecycle is `item/started` → zero or more deltas → `item/completed`; `item.id`/`itemId` correlates the stream and the completed item is authoritative. See the [item lifecycle](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#items).
- App Server transport queues are bounded; saturated ingress returns `-32001` and slow WebSocket clients are disconnected rather than allowed to grow an unbounded queue. See the [documented backpressure behavior](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#backpressure-behavior) and [transport source](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/transport.rs#L136-L173).

What is not a reusable built-in plugin solution:

- The experimental `process/spawn` API has handle/output/kill lifecycle, but is explicitly an unsandboxed host process. See the [experimental process API](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#experimental-process-apis).
- Dynamic tools have call identity and terminal lifecycle, but no tool-specific progress channel and no call-specific cancel; `turn/interrupt` cancels the turn. See [dynamic tool calls](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#dynamic-tool-calls-experimental) and [turn interruption](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#interrupt-a-turn).
- The reviewed protocol has no general Artifact body store or arbitrary large-file input reference. Workspace files remain path-owned resources; binary filesystem utilities use base64.

Applicable lesson: copy the identity, terminal barrier, explicit cancel, byte caps, and bounded-queue behavior—not its image/base64 file transport.

### 4.2 Current Pi

What is built in:

- A custom tool executes as `execute(toolCallId, params, signal, onUpdate, ctx)`. Start/update/end events share `toolCallId`, and the `AbortSignal` is available to nested work. See [extension tool definitions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) and the [RPC event contract](https://pi.dev/docs/latest/rpc#events).
- RPC is JSONL. Tool updates are correlated by `toolCallId`; the command request's optional `id` applies to the command response, not all later agent events.
- The built-in Bash tool throttles live updates, retains a bounded display tail, spills complete truncated output to a temporary file, and terminates the process tree. See [`bash.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/bash.ts) and [`output-accumulator.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/output-accumulator.ts).
- RPC stdout writes are serialized and retried on temporary buffer exhaustion. See [`output-guard.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/output-guard.ts).

Important limits:

- RPC images are base64 and there is no general file reference.
- CLI `@file` reads the whole file. The built-in `read` tool accepts `offset`/`limit`, but currently calls `readFile()` and splits the complete text before slicing; it limits model-visible output, not process memory. See [`file-processor.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/cli/file-processor.ts) and [`read.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/read.ts).
- `onUpdate` returns `void`; the agent loop can accumulate update promises until the tool finishes. A fast producer therefore has no built-in backpressure. See the [agent loop update path](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts#L668-L708).
- The extension must propagate/observe `AbortSignal`; Pi cannot stop a Worker that ignores it.
- The official subagent extension demonstrates subprocess JSONL and signal forwarding, but it is an example rather than a managed-worker or sandbox guarantee. See the [subagent example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts).

Applicable lesson: use one call identity, attempt cancellation, and publish replaceable progress snapshots. Do not expose an unconstrained `void onUpdate` directly to plugin code.

### 4.3 LangChain and LangGraph

What is built in:

- LangChain tools can emit arbitrary custom updates through `ToolRuntime.stream_writer`; LangGraph exposes the same facility as `get_stream_writer()` and yields it under `stream_mode="custom"`. See the [LangChain tools guide](https://docs.langchain.com/oss/python/langchain/tools#stream-writer) and [LangGraph streaming guide](https://docs.langchain.com/oss/python/langgraph/streaming#custom-data).
- A stream payload has no required domain schema. Identity, progress ordering, terminal semantics, and UI replacement rules belong to the application.

What the installed path does not provide:

- `StreamWriter` is a synchronous `Callable[[Any], None]`, not an awaitable producer contract.
- LangGraph 1.2.9's `astream()` path uses an unbounded internal `AsyncQueue` and schedules `put_nowait`; a fast custom writer therefore receives no flow-control signal. See [`_queue.py` at 1.2.9](https://github.com/langchain-ai/langgraph/blob/1.2.9/libs/langgraph/langgraph/_internal/_queue.py) and [`pregel/main.py` at 1.2.9](https://github.com/langchain-ai/langgraph/blob/1.2.9/libs/langgraph/langgraph/pregel/main.py).
- Custom stream chunks are observations, not checkpoints or durable receipts. Cancellation of the graph coroutine is cooperative; a child process still needs an explicit cancel/kill path.

Applicable lesson: capture the writer at the P10 tool boundary and use it only after host-side validation, throttling, and coalescing. LangGraph is the last in-process hop, not the Worker protocol or durable progress store.

### 4.4 Deep Agents

What is built in:

- Backend text reads support server-side `offset`/`limit`; `BaseSandbox.read()` returns only the requested window and caps transport output. Binary preview is base64 and capped. See the [backend protocol](https://docs.langchain.com/oss/python/deepagents/backends#protocol-reference) and [`BaseSandbox`](https://github.com/langchain-ai/deepagents/blob/7e70065200007896336f38fe905803e6763e8f85/libs/deepagents/deepagents/backends/sandbox.py).
- Filesystem middleware replaces an oversized tool message with a preview and a file path so the model can call `read_file` incrementally. See [`_message_eviction.py` in the pinned 0.6.12 source](https://github.com/langchain-ai/deepagents/blob/7e70065200007896336f38fe905803e6763e8f85/libs/deepagents/deepagents/middleware/_message_eviction.py).
- Sandbox backends separate model-facing filesystem tools from application-facing `upload_files()`/`download_files()` APIs. See the [sandbox file planes](https://docs.langchain.com/oss/python/deepagents/sandboxes#two-planes-of-file-access).

Important limits and version distinction:

- SheJane pins `deepagents==0.6.12`. In that version, generic tool-message eviction receives the complete text string before writing it to the backend. It protects model context, not peak producer memory.
- Current upstream main adds opt-in capture-at-source for compatible shell sandboxes: large `execute` output stays in a sandbox file and only a preview returns. This is a useful source-level pattern, but is not in the pinned version and is not a generic binary Artifact store. See the [current `BaseSandbox.execute_with_offload`](https://github.com/langchain-ai/deepagents/blob/main/libs/deepagents/deepagents/backends/sandbox.py).
- `upload_files()`/`download_files()` use byte payloads in their common protocol. They define a separate transfer plane, not necessarily streaming or zero-copy behavior for every provider.
- Deep Agents' progress UI builds on LangGraph streams and subgraph events; it does not define a managed subprocess progress/cancel protocol. See [Deep Agents streaming](https://docs.langchain.com/oss/python/deepagents/streaming).

Applicable lesson: give the model references and small previews. Prevent large bytes from entering the model/event path in the first place rather than relying on post-hoc eviction.

## 5. Recommended large-input contract

### 5.1 Preserve the public `/input` descriptor

The existing invocation fields are sufficient:

```json
{
  "id": "source",
  "path": "/input/source/report.xlsx",
  "media_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "size_bytes": 734003200,
  "sha256": "..."
}
```

Do not add host paths, base64, file descriptors, download URLs, or storage keys to the plugin-facing schema.

### 5.2 Import once, then create least-authority execution views

At Run admission:

1. Stream the selected source into a Runtime-owned temporary file while computing size and SHA-256.
2. Verify quotas and expected metadata.
3. Atomically rename it into immutable input storage keyed by digest.
4. Store only the internal body key in Runtime state; keep `/input/...` as the plugin-visible name.

At Action invocation:

1. Build a private `/input` view containing only the descriptors compatible with that Action.
2. Prefer a clone/reflink or hard link from the immutable Runtime copy; fall back to a buffered file copy. Never hard-link the original user-writable file.
3. Mount/authorize the view read-only and keep `/output` private to the invocation.
4. Never send input content through Worker stdout/stdin JSONL.

This removes the source-file TOCTOU window and avoids repeating a full cross-volume import for each Action. Per-Action views preserve the existing invariant that the listed inputs are the complete readable set.

### 5.3 Keep WASI honest

The current WASI Component ABI passes byte maps and therefore remains a small deterministic Action path. Phase 6 should:

- enforce an explicit small aggregate input/output byte limit before `read_bytes()`;
- reject an oversized WASI invocation as `resource_exhausted` or incompatible with that Action package;
- use Managed Worker for Documents, Spreadsheets, Presentations, archives, and video until a reviewed Component Model resource/stream ABI exists.

Do not silently switch an installed WASI package to a native Worker. Execution kind remains part of the frozen package identity.

## 6. Recommended Artifact body handoff

### 6.1 One promotion seam for both executors

Keep the current result envelope: the plugin returns metadata for candidates under `/output`. After the executor is quiescent, a common `ArtifactStore.promote(...)` path should:

1. open the candidate without following symlinks;
2. reject non-regular files and path replacement;
3. stream size and SHA-256 in bounded chunks while enforcing candidate, Action, Run, principal, and total quotas;
4. atomically move/copy the immutable body into a Runtime-owned content-addressed store;
5. return an `ArtifactRef` containing `artifact_id`, name, media type, logical size, and SHA-256.

A later Action in the same Run may use that `artifact_id` as its conventional `input_id`. Runtime resolves the settled file-backed record, checks exact Run ownership and the consumer's declared MIME, revalidates the content-addressed body, and materializes only that body into the next invocation. This deliberately replaces the shared-workspace pattern used by coding agents: no plugin receives a mutable common directory, and cross-Run Artifact IDs do not grant authority.

The model-visible tool result and SSE carry only `ArtifactRef`. No binary body enters JSON, LangGraph state, a checkpoint, `local_events`, or a tool receipt.

### 6.2 SQLite is the catalog, not the blob store

Evolve `local_artifacts` so a record can point to an internal body key. The body key is never exposed as a host path. Preserve existing inline-text artifacts through a storage discriminator during migration, for example:

```text
storage_kind = inline_text | blob
content      = legacy/small text only
blob_key     = internal immutable key, nullable
sha256       = digest, nullable for migrated legacy rows
size_bytes   = logical body size
```

Plugin binary output must always use `blob` storage. The current `art_<operation>_<index>` identity remains stable on replay; content addressing is an internal storage optimization, not a second Artifact identity.

### 6.3 Stream downloads through the existing Artifact authorization

Add a body route such as:

```text
GET /v1/artifacts/{artifact_id}/content
```

It must:

- authorize through the owning Run/principal, exactly like the existing metadata route;
- use `FileResponse`/streaming I/O and support HTTP Range for large media/archives;
- set the declared content type and safe filename;
- never reveal the internal body path;
- return a stable error if the catalog row exists but the body is missing/corrupt.

The existing metadata endpoint can continue serving legacy inline text while clients migrate. This extends the current Artifact model; it does not create a plugin-specific download system.

### 6.4 Filesystem/SQLite atomicity

A filesystem rename and SQLite commit cannot be one physical transaction. Use a recoverable two-step contract:

1. P10 promotes a validated immutable body after the executor is quiescent; P11 verifies the resulting reference and closed resource set.
2. P12 atomically commits the Artifact catalog row, receipt, and Run settlement.
3. A body without a committed catalog reference is an orphan and is removed by bounded startup/periodic GC after a grace period.
4. A catalog row with a missing body is corruption and must fail closed; it is never replaced by rerunning an effectful Action blindly.

## 7. Recommended Managed Worker progress protocol

### 7.1 Progress is a replaceable snapshot

Use a JSON-RPC notification, not a response body or log line:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/progress",
  "params": {
    "schema_version": 1,
    "operation_id": "toolop_...",
    "invocation_id": "019f...",
    "sequence": 7,
    "phase": "rendering",
    "completed": 23,
    "total": 100,
    "unit": "pages",
    "message": "Rendering pages"
  }
}
```

Rules:

- `operation_id` is the existing stable receipt identity.
- `invocation_id` distinguishes a concrete retry/attempt that shares the operation identity.
- `sequence` starts at 1 and strictly increases within one invocation.
- `phase` is a short stable machine code; `message` is optional bounded display text.
- `completed`/`total` are non-negative counters. Omit `total` when unknown; the Worker does not send a preformatted percentage.
- The notification is a full latest snapshot, so clients replace rather than append.
- No stdout/stderr excerpts, document bytes, stack traces, paths, secrets, or arbitrary nested payloads are allowed.
- A progress notification never extends the Action's hard wall-clock timeout. A separate idle/heartbeat policy may observe progress without overriding the hard limit.

Identity mismatch, progress before `initialize`/`invoke`, or progress after a terminal result is a protocol violation. Duplicate/out-of-order sequence values are ignored and counted; repeated abuse terminates/quarantines the Worker.

### 7.2 Multiplex responses and notifications in one reader

Replace request-local `exchange()` reads with one stdout reader task:

- continuously drain and frame-validate stdout;
- route JSON-RPC responses to bounded waiters keyed by request `id`;
- route `notifications/progress` to a latest-value coalescer;
- reject unknown methods, duplicate terminal results, oversized/deep frames, and stdout contamination;
- keep stderr on its existing independent bounded drain.

The reader must never wait for an SSE subscriber. Otherwise a slow renderer can fill the OS pipe and suspend the Worker before it can return its terminal result.

### 7.3 Cancellation is acknowledged, then enforced

Use a JSON-RPC request so the host can observe acknowledgement:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "cancel",
  "params": {
    "operation_id": "toolop_...",
    "invocation_id": "019f...",
    "reason": "run_cancelled"
  }
}
```

On user cancellation, timeout, Runtime shutdown, or lease loss:

1. close the progress terminal gate;
2. send `cancel` and allow a short policy-controlled grace period;
3. accept an acknowledgement and/or terminal `cancelled` result;
4. terminate the entire process tree when the grace expires;
5. run P11 cleanup before any final settlement.

The Worker signal is cooperative; the Runtime supervisor remains authoritative. A late result from an old invocation or stale lease can never commit.

## 8. LangGraph and SSE bridge

At plugin tool entry, capture the LangGraph writer once and pass a narrow callback through `ActionExecutor` to the Managed Worker adapter. The adapter, not the Worker, creates the stream payload:

```json
{
  "type": "tool.progress",
  "operation_id": "toolop_...",
  "invocation_id": "019f...",
  "tool_call_id": "call_...",
  "tool_name": "plugin__...",
  "sequence": 7,
  "phase": "rendering",
  "completed": 23,
  "total": 100,
  "unit": "pages",
  "message": "Rendering pages"
}
```

Then:

1. `get_stream_writer()`/`ToolRuntime.stream_writer` carries the validated payload through LangGraph custom mode.
2. `event_translator.py` recognizes only the namespaced `type == "tool.progress"` shape and emits the product event `tool.progress`.
3. `tool.progress` is added to `TRANSIENT_RUN_EVENT_TYPES`. It is droppable and is never appended once per tick to `local_events`.
4. The current per-subscriber queue remains bounded; a slow client loses intermediate snapshots.
5. `tool.completed`/`tool.failed` and the terminal receipt remain durable and authoritative.

For reconnect UX, update a latest-progress snapshot on `local_tool_receipts` at phase transitions and a coarse host-controlled interval. A snapshot read gives the current state; SSE resumes live delivery. Do not replay every historical percentage tick.

## 9. Backpressure policy

The path has four independent pressure boundaries:

| Boundary | Required behavior |
| --- | --- |
| Worker → JSONL reader | Hard frame/nesting limits; always drain stdout; smaller cap for progress than result frames; protocol flood budget. |
| Reader → progress coalescer | One latest snapshot per active invocation; intermediate snapshots overwrite; phase changes are preserved. |
| Coalescer → LangGraph | Host rate limit (for example, at most a few updates per second per operation); synchronous writer is never exposed to the Worker. |
| Runtime → SSE client | Existing bounded subscriber queue; drop transient progress when full; durable terminal state is recovered from SQLite. |

Additional rules:

- The final result bypasses the progress coalescer and establishes a terminal barrier.
- A progress flood may degrade to latest-only delivery, but cannot delay reading the final response.
- No progress update is allowed to allocate memory proportional to input/output size.
- Logs remain a separate bounded diagnostic channel; they are not progress.
- UI state is keyed by `operation_id + invocation_id`, ordered by `sequence`, and finalized only by the durable terminal lifecycle.

Codex's bounded transport and terminal item, Pi Bash's throttled replaceable view, and Deep Agents' reference-plus-preview all support this split. None supplies the whole contract automatically.

## 10. Implementation path

### 6A. Freeze contracts and failing conformance cases

- Add progress/cancel JSON schemas and cross-adapter test fixtures.
- Record `tool.progress` as transient in the protocol docs and generated client event union.
- Add a Worker fixture that interleaves progress notifications and responses.
- Add stale invocation, sequence regression, progress-after-terminal, cancellation, and frame-flood cases.

### 6B. Externalize Artifact bodies first

- Introduce the Runtime Artifact body store and metadata migration.
- Replace plugin `read_bytes()`/base64 persistence with streaming promotion.
- Add authenticated streaming/Range download.
- Keep stable Artifact IDs and the existing receipt/settlement path.

This removes the largest current memory/SQLite amplification before increasing plugin file limits.

### 6C. Import Runtime-owned immutable inputs

- Admit/hash/copy once into immutable storage.
- Create per-Action least-authority `/input` views.
- Raise large-input limits only for adapters/actions that do not use whole-file buffers.
- Keep WASI on an explicit small-byte gate.

### 6D. Multiplex Managed Worker progress and cancel

- Replace `exchange()` with one supervised reader and response waiters.
- Add latest-only coalescing, rate limits, terminal gate, cancel acknowledgement, and process-tree escalation.
- Keep current one-Action-per-process v1 lifecycle; pooling remains out of scope.

### 6E. Project progress to receipt, SSE, and Client

- Capture the LangGraph writer at the plugin tool boundary.
- Translate typed custom payloads to transient `tool.progress`.
- Persist only the latest receipt snapshot.
- Render replaceable phase/counter UI and reconcile it with terminal events.

### 6F. Consider WASI streaming only after measurement

Design a Component Model resource interface only if real official plugins need it and the Managed Worker path is insufficient. It requires independent capability, interruption, quota, and conformance review.

## 11. Acceptance gates

### Large inputs and outputs

- A large synthetic workbook/video is admitted and hashed with bounded RSS; Action JSON contains metadata only.
- Repeated Actions over the same Run input do not re-import the original file.
- An oversized WASI input fails before `read_bytes()`.
- A large Worker Artifact is promoted with bounded RSS and no base64 body in SQLite, events, checkpoints, or receipts.
- Streaming and Range download reproduce the exact digest and enforce Run ownership.
- Quota failure leaves no committed Artifact and bounded temporary/orphan cleanup succeeds.

### Progress, cancellation, and replay

- A Worker can emit progress before its result; every event is correlated by operation/invocation and ordered by sequence.
- A Worker emitting 100,000 updates does not grow Runtime memory or SQLite linearly; the UI sees a bounded latest-value stream.
- A slow/disconnected SSE client cannot block Worker stdout or terminal result handling.
- Cancellation reaches a cooperative Worker and forcibly kills an ignoring Worker plus descendants after grace.
- Progress after terminal/cancel and progress from a prior invocation are rejected/ignored.
- Replaying a completed `operation_id` returns the existing receipt and stable Artifact IDs without launching another Worker.
- Lease loss prevents a late result or promoted candidate from changing the Run; orphan cleanup remains deterministic.

### Protocol truthfulness

- Managed Worker process isolation is not presented as a permission sandbox.
- `tool.progress` is documented as transient; terminal receipt/Artifact state is documented as authoritative.
- Deep Agents capture-at-source behavior is not claimed for the pinned 0.6.12 dependency.
- Codex/Pi image or attachment support is not cited as proof of generic large-file streaming.

## 12. Explicit non-goals

- No arbitrary host path in plugin arguments.
- No file bytes in JSONL, SSE, LangGraph state, or SQLite Artifact text.
- No exact-once claim for effectful Actions.
- No durable history of every progress tick.
- No implicit timeout extension from heartbeats/progress.
- No Worker pooling in v1.
- No silent WASI → Managed Worker fallback.
- No replacement of the existing `ActionExecutor`, `operation_id`, receipt, Artifact identity, P11 cleanup, or P12 settlement contracts.
