# Phase 2.3a-2.16 Progress - Local Agent Harness Foundation, Loop, Context, Web, MCP, Tool Batching, Error Handling, UI, Workspace Governance, Recovery, Session Bridge, Universal Tool Primitives, and Browser Observation

Updated: 2026-05-11

## Goal

Establish the daemon foundation and first usable Harness loop for the Local Agent Harness without opening broad local automation.

This phase proves:

- A Node/TypeScript local host module can run on loopback.
- Electron can discover the host.
- Protected local APIs require a pairing token.
- Runs have ordered durable events.
- The UI can distinguish local-harness mode from cloud-limited mode.
- Long tool outputs can be stored as artifacts instead of flooding model context.
- Running runs can resume from local checkpoints.
- Local memory can be loaded as hints without treating it as verified truth.
- Tool observations can emit rule-based verification events.
- The local harness can fetch public web pages with SSRF protection and optionally search through Tavily.
- MCP calls are gated by an explicit allowlist and can execute through a configured local stdio MCP runtime adapter after user permission approval.
- Consecutive concurrency-safe read tools can execute in parallel while preserving model observation order.
- Model gateway failures become durable `run.failed` events instead of escaping the runner and leaving runs stuck.
- The user client can create local runs from the unified composer, approve or deny permission requests, preview artifacts, and show verification events.
- Workspace roots are explicitly authorized through the paired Local Host before a run can use local file or shell tools.
- Workspace authorization can be diagnosed and revoked from the client, and the composer shows the active local project reference.
- Recent local runs can be listed, resumed through the existing stream endpoint, and exported as redacted diagnostic bundles.
- Electron login can attach a short-lived cloud session to the paired Local Host without copying access tokens by hand.
- Universal tool primitives provide general work-agent verbs for listing, reading, searching, writing, opening, clipboard access, and verification.
- Controlled browser and environment observation let the Harness inspect a managed page and local environment metadata without broad computer control.

## Completed

- [x] Added [`local-host/package.json`](../../local-host/package.json) with TypeScript, Vitest, and a daemon entrypoint.
- [x] Added [`local-host/src/server.ts`](../../local-host/src/server.ts) with:
  - `GET /local/v1/health`
  - `GET /local/v1/tools`
  - `GET /local/v1/session`
  - `POST /local/v1/session`
  - `DELETE /local/v1/session`
  - `POST /local/v1/runs`
  - `GET /local/v1/runs/{id}`
  - `GET /local/v1/runs`
  - `GET /local/v1/runs/{id}/stream`
  - `GET /local/v1/runs/{id}/diagnostics`
  - `POST /local/v1/runs/{id}/cancel`
  - `POST /local/v1/permissions/{request_id}`
  - `GET /local/v1/artifacts/{id}`
  - `GET /local/v1/workspaces`
  - `POST /local/v1/workspaces`
  - `POST /local/v1/workspaces/diagnose`
  - `DELETE /local/v1/workspaces/{id}`
- [x] Added pairing token protection for every Local API except health.
- [x] Added typed tool registry for first-class harness metadata:
  - `time.now`
  - `workspace.open`
  - `file.read`
  - `file.search`
  - `shell.run`
- [x] Added local state stores:
  - in-memory store for tests
  - SQLite store for daemon runtime
- [x] Added daemon entrypoint using `JIANDANLY_LOCAL_HOST_TOKEN`, `JIANDANLY_LOCAL_HOST_PORT`, and optional `JIANDANLY_LOCAL_HOST_DB`.
- [x] Added Electron preload metadata: `window.jiandanDesktop.localHost.baseURL` and optional pairing token.
- [x] Added React local-host probe and status chip:
  - `本地 Harness`
  - `云端受限`
- [x] Updated `README.md`, `project-plan.md`, `backend-spec.md`, `frontend-spec.md`, `docs/operations.md`, `.env.example`, and root `spec.md`.
- [x] Phase 2.4 Harness Loop MVP:
  - Local runner executes TAO loop with tool observations.
  - Tool layer supports `time.now`, `file.read`, `file.search`, and `shell.run`.
  - File and shell paths are constrained to the authorized workspace.
  - `shell.run` creates a persisted permission request and does not execute before approval.
  - Approval path executes the stored shell call and appends permission/tool/run events.
  - Cloud LLM gateway is available at `/api/v1/agent/llm` and settles wallet usage.
  - Cloud tool event summary intake is available at `/api/v1/agent/tool-events`.
- [x] Phase 2.5 Memory / Context / Checkpoint MVP:
  - Large tool observations become local artifacts and model context receives only an artifact reference plus short preview.
  - `/local/v1/artifacts/{id}` returns the local artifact through the pairing-token protected API.
  - Oversized message context is compacted before the next LLM call and emits `context.compacted`.
  - Checkpoints persist compacted or waiting-permission state and emit `checkpoint.created`.
  - `running` runs can resume through `/local/v1/runs/{id}/stream` using the latest checkpoint.
  - Permission approval now executes the stored tool call and continues back to the model with the tool observation.
  - Local memory MVP supports always-loaded index entries, matching topic notes, and raw run/event search through the event log.
  - SQLite persistence now covers artifacts, checkpoints, and local memory.
- [x] Phase 2.6 Verification / MCP / Web MVP:
  - Added `verification.started` and `verification.completed` events for shell exit codes, file tools, web fetch/search, and MCP calls.
  - Added `web.fetch` with URL validation, DNS resolution, SSRF blocking, timeout, response size limit, text-only enforcement, HTML text extraction, and source metadata.
  - Added optional Tavily-backed `web.search` using `TAVILY_API_KEY`; missing config returns a recoverable disabled-tool observation.
  - Added `mcp.call` guardrail with `JIANDANLY_MCP_ALLOWLIST`; allowlisted tools are recognized but not executed until a real local MCP runtime adapter is added.
- [x] Phase 2.7 Local Harness UI Bridge MVP:
  - Added pairing-token aware client helpers for local run creation, event streaming, permission resolution, and artifact retrieval.
  - Added a persistent local workspace path field in the ordinary client sidebar.
  - When Electron is paired with Local Host and no cloud document is attached, messages create local harness runs instead of cloud fallback runs.
  - The timeline now renders `permission.required`, `permission.resolved`, `artifact.created`, and `verification.completed` as actionable UI.
  - Users can approve or deny local permission requests from the message timeline.
  - Users can open local artifacts through the protected artifact API without putting full artifact content into the message body.
- [x] Phase 2.8 Workspace Authorization MVP:
  - Electron exposes a safe native directory picker through preload, not direct renderer filesystem access.
  - Local Host persists authorized workspace roots in both memory and SQLite stores.
  - `POST /local/v1/workspaces` validates that the path exists and is a directory before authorization.
  - `POST /local/v1/runs` rejects unapproved `workspace_path` values with `workspace_not_authorized`.
  - The client can list authorized workspaces, authorize a picked or manually entered path, and reuse recent authorized roots.
- [x] Phase 2.9 Workspace Governance MVP:
  - Local Host supports `POST /local/v1/workspaces/diagnose` for path existence, directory, and root-authorization checks.
  - Local Host supports `DELETE /local/v1/workspaces/{id}` to revoke an authorized root.
  - In-memory and SQLite stores remove revoked workspace authorizations consistently.
  - The client can diagnose the current path or an authorized workspace from the sidebar.
  - The client can revoke an authorized workspace and clears the active local project reference when the active root is revoked.
  - The composer shows a local project chip when a workspace path is attached to the next Local Harness run.
- [x] Phase 2.10 Run Recovery / Diagnostics MVP:
  - Local Host supports `GET /local/v1/runs?limit=` for recent run listing.
  - Local Host supports `GET /local/v1/runs/{id}/diagnostics` for redacted run diagnostic export.
  - Diagnostic export includes run metadata, event log, permission records, artifact metadata, and latest checkpoint summary.
  - Diagnostic export does not include artifact content or full checkpoint messages.
  - The client sidebar shows recent local runs from the paired Local Host.
  - The client can recover a recent run by streaming `/local/v1/runs/{id}/stream` into a new local conversation.
  - The client can download a diagnostics JSON bundle for a recent run.
- [x] Phase 2.11 MCP Runtime Adapter MVP:
  - `mcp.call` now executes allowlisted local MCP tools through a configured stdio JSON-RPC server.
  - MCP calls still require both `JIANDANLY_MCP_ALLOWLIST` and explicit user permission approval.
  - MCP server config is supplied through `JIANDANLY_MCP_SERVERS_JSON`; command, args, env and secrets are not returned in tool metadata.
  - MCP startup failure, timeout, JSON-RPC error and tool error become recoverable observations instead of daemon crashes.
  - Harness runner tests cover the permission -> MCP execution -> observation -> verification flow.
- [x] Phase 2.12 Tool Batching MVP:
  - Consecutive `permissionPolicy=allow` + `isConcurrencySafe=true` tool calls run in parallel.
  - Tool observations are still pushed back to the model in the original tool call order.
  - Permission-gated and destructive tools remain serial and pause the run for user approval.
- [x] Phase 2.13 Error Handling Hardening:
  - Model gateway exceptions are converted to `run.failed` with `error_code=llm_failed`.
  - The run status is durably updated to `failed`; the error no longer escapes the runner as an unhandled server failure.
- [x] Phase 2.14 Local Session Bridge:
  - Local Host supports paired `GET /local/v1/session`, `POST /local/v1/session`, and `DELETE /local/v1/session`.
  - The session stores cloud base URL and bearer access token in memory only.
  - Session API responses never return the access token.
  - Harness runs use the current in-memory cloud session for `/api/v1/agent/llm` when no test-injected gateway is supplied.
  - Electron client syncs the cloud access token into Local Host after register/login/refresh.
  - Electron logout clears the Local Host cloud session.
  - Manual testing no longer requires copying `JIANDANLY_CLOUD_ACCESS_TOKEN`; that env remains available for smoke or headless debugging.
- [x] Phase 2.14a Electron Dev Startup:
  - Added `make dev-electron` as the recommended one-command local Electron entrypoint.
  - The dev helper starts Docker Compose in detached mode, starts Local Host, starts an isolated client dev server on `55173`, then launches Electron in dev mode.
  - The helper avoids the old footgun where `docker compose up --build` and `npm run dev` block the terminal before Electron can run.
  - README and operations docs now point manual testers to `make dev-electron`.
- [x] Phase 2.14b DeepSeek Tool Loop Compatibility:
  - OpenAI-compatible provider requests now map internal dotted tool names such as `time.now` and `file.read` to provider-safe function names, then map returned tool calls back to internal names.
  - DeepSeek thinking-mode `reasoning_content` is captured from tool-call responses and replayed on subsequent assistant messages.
  - Local Host stores and forwards `reasoningContent` inside run/checkpoint messages but does not expose it as visible UI reasoning.
  - Verified a real two-step Local Harness run against DeepSeek: model requested `time.now`, Local Host executed it, the follow-up model call completed, and the run reached `run.completed`.
- [x] Phase 2.14c Debuggability / Error Surfacing:
  - `POST /api/v1/agent/llm` now returns 402 for quota exhaustion during final settlement instead of generic 500.
  - Local Host cloud gateway errors now include cloud API `code` and `message`, so UI run failures can show actionable reasons such as quota exhaustion.
  - Added `make logs-api`, `make logs-local-host`, `make logs-client`, `make logs-llm-errors`, and `make logs-dev` for local debugging.
- [x] Phase 2.14d Tool Guardrail / Write Path Fix:
  - Implemented `workspace.open` so approved workspace changes persist on the run and can be used by later file/search/shell tools.
  - Added permission-gated `file.write` for UTF-8 text files inside the authorized workspace.
  - Added `workspace_open_ok` and `file_write_ok` verification events.
  - Unsupported tool calls now fail fast with `unsupported_tool` instead of looping until `max_steps_exceeded`.
  - Max-step failures now include the last requested tool for faster diagnosis.
- [x] Phase 2.15 Universal Tool Primitives:
  - Added [`docs/specs/universal-tool-primitives.md`](../specs/universal-tool-primitives.md) as the tool primitive contract.
  - Added `fs.list`, `fs.read`, `fs.search`, and permission-gated `fs.write` as the preferred workspace file primitives.
  - Kept `file.read`, `file.search`, and `file.write` as compatibility aliases.
  - Added permission-gated `open.url`, `open.file`, `clipboard.read`, and `clipboard.write`.
  - Added `task.verify` for file existence, file content, URL shape, and boolean checks.
  - Updated the Local Harness prompt to prefer `fs.*` over legacy `file.*`.
  - Updated client timeline and permission buttons to show user-facing action names such as `打开网页`, `写入文件`, and `运行命令`.
- [x] Phase 2.16 Browser / Environment Observation:
  - Added permission-gated `browser.open` for Local Host managed page contexts with public URL validation and private-network blocking.
  - Added `browser.snapshot` for managed page title, URL, visible text, links, forms, and buttons.
  - Added `browser.close` for clearing the managed page context.
  - Added permission-gated `environment.observe` for platform, foreground app, window title, and screen-permission metadata.
  - Added `browser.observed`, `environment.observed`, `ui.action.requested`, and `ui.action.completed` semantic events.
  - Updated client timeline labels to show user-facing actions such as `打开受控网页`, `观察网页`, and `观察环境`.

## Current Boundaries

- Real local file read/search is available only when the run has an authorized workspace path.
- Shell commands are permission-gated and execute only after explicit approval through the local permission API.
- Browser observation is limited to Local Host managed page contexts; it does not read or control existing Chrome/Safari tabs.
- `/local/v1/runs/{id}/stream` now runs the MVP Harness loop. Without a cloud session or headless cloud LLM env configuration it uses a static fallback response.
- The SQLite runtime store uses Node's built-in `node:sqlite`, which is currently experimental in Node 22. This is acceptable for Phase 2.3a foundation but should be revisited before production packaging if Electron's bundled Node runtime differs.
- Phase 2.6 adds rule verification events, SSRF-protected `web.fetch`, optional Tavily `web.search`, and MCP allowlist guardrails.
- Phase 2.7 adds a manual workspace path field, permission approve/deny controls, artifact preview, and verification timeline rendering.
- Phase 2.8 adds native Electron directory selection and persistent Local Host workspace authorization rules.
- Phase 2.9 adds workspace revocation, path-level authorization diagnostics, and visible local project references in the composer.
- Phase 2.10 adds recent local run listing, manual recovery, and redacted diagnostics export.
- Phase 2.11 adds a real local stdio MCP runtime adapter behind the existing allowlist and permission flow.
- Phase 2.12 adds concurrency-safe read-tool batching with deterministic observation order.
- Phase 2.13 hardens LLM gateway failure handling so runs do not remain stuck in `running`.
- Phase 2.14 makes Electron the primary Local Harness testing surface by syncing login state into Local Host through paired loopback session APIs.
- Phase 2.14a makes the local Electron dev path one-command via `make dev-electron`; Docker still stays running after the app exits and can be stopped with `make docker-down`.
- Phase 2.14b handles DeepSeek V4 thinking-mode tool calls; other OpenAI-compatible providers may still need provider-specific quirks as we broaden model support.
- Phase 2.14c adds CLI-level observability, but in-app log inspection and one-click current-run diagnostic export are still future work.
- Phase 2.14d adds a minimal write path, but only for explicit `file.write` approvals inside authorized workspace roots; destructive shell commands still require separate approval.
- Phase 2.15 adds general work-agent primitives; clipboard operations are text-only, `open.url` supports only `http`/`https`, and `open.file` is limited to authorized workspace files.
- Phase 2.16 adds controlled page snapshotting and environment metadata, but not clicking, typing, form submission, screen OCR, or app-window control.
- Workspace authorization is root-based; a run may use the authorized root or a child path, but not arbitrary unapproved paths.
- Browser action control, screen/app control, richer run recovery UI, diagnostics import/replay, and Playwright/visual verification loops are still pending.

## Verification

- `cd local-host && npm test -- --run`
- `cd api && go test ./internal/httpapi ./internal/llm`
- `cd client && npm test -- --run src/shared/local-host/client.test.ts`
- `cd client && npm test -- --run src/shared/local-host/client.test.ts src/App.test.tsx`
- `cd local-host && npm test -- --run src/localHostServer.test.ts src/state/sqliteStore.test.ts`
- `cd client && npm test -- --run src/shared/local-host/client.test.ts src/App.test.tsx`
- `cd local-host && npm test -- --run src/tools/mcpTools.test.ts src/harness/runner.test.ts`
- `cd local-host && npm test -- --run src/localHostServer.test.ts`
- `cd client && npm test -- --run src/shared/local-host/client.test.ts src/App.test.tsx`
- `cd api && go test ./internal/llm ./internal/httpapi`
- `cd local-host && npm test -- --run src/harness/runner.test.ts`
- `cd local-host && npm test -- --run src/tools/browserEnvironment.test.ts`
- `cd local-host && npm test -- --run src/harness/runner.test.ts -t "browser and environment"`
- `cd client && npm test -- --run src/features/chat/chatStore.test.ts -t "browser and environment"`
- `cd local-host && npm test -- --run`
- `cd local-host && npm run build`
- `cd client && npm test -- --run src/App.test.tsx src/features/chat/chatStore.test.ts`
- `make test`
- `make build`
- Real API smoke: `POST /api/v1/agent/llm` with `time.now` tools succeeds across first tool-call turn and second observation turn.
- Real Local Host smoke: temporary Local Host run for `what time is it` reached `run.completed` after `time.now`.

Full workspace verification is tracked in the implementation closeout.

## Next

- Phase 2.17 candidate: controlled browser actions for click/type/navigation with explicit permission and deterministic adapter tests.
- Add diagnostics import/replay before broadening long-running local automation.
- Add screen/app control only after browser observation and action primitives are stable.
