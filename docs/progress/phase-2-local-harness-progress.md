# Phase 2.3a-2.9 Progress - Local Agent Harness Foundation, Loop, Context, Web, UI, and Workspace Governance

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
- MCP calls are gated by an explicit allowlist before any runtime adapter is introduced.
- The user client can create local runs from the unified composer, approve or deny permission requests, preview artifacts, and show verification events.
- Workspace roots are explicitly authorized through the paired Local Host before a run can use local file or shell tools.
- Workspace authorization can be diagnosed and revoked from the client, and the composer shows the active local project reference.

## Completed

- [x] Added [`local-host/package.json`](../../local-host/package.json) with TypeScript, Vitest, and a daemon entrypoint.
- [x] Added [`local-host/src/server.ts`](../../local-host/src/server.ts) with:
  - `GET /local/v1/health`
  - `GET /local/v1/tools`
  - `POST /local/v1/runs`
  - `GET /local/v1/runs/{id}`
  - `GET /local/v1/runs/{id}/stream`
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

## Current Boundaries

- Real local file read/search is available only when the run has an authorized workspace path.
- Shell commands are permission-gated and execute only after explicit approval through the local permission API.
- Real MCP runtime execution and browser control are not enabled yet.
- `/local/v1/runs/{id}/stream` now runs the MVP Harness loop. Without cloud LLM configuration it uses a static fallback response.
- The SQLite runtime store uses Node's built-in `node:sqlite`, which is currently experimental in Node 22. This is acceptable for Phase 2.3a foundation but should be revisited before production packaging if Electron's bundled Node runtime differs.
- Phase 2.6 adds rule verification events, SSRF-protected `web.fetch`, optional Tavily `web.search`, and MCP allowlist guardrails.
- Phase 2.7 adds a manual workspace path field, permission approve/deny controls, artifact preview, and verification timeline rendering.
- Phase 2.8 adds native Electron directory selection and persistent Local Host workspace authorization rules.
- Phase 2.9 adds workspace revocation, path-level authorization diagnostics, and visible local project references in the composer.
- Workspace authorization is root-based; a run may use the authorized root or a child path, but not arbitrary unapproved paths.
- Real MCP runtime adapter, browser/IDE control, richer run recovery UI, diagnostics export, and Playwright/visual verification loops are still pending.

## Verification

- `cd local-host && npm test -- --run`
- `cd api && go test ./internal/httpapi ./internal/llm`
- `cd client && npm test -- --run src/shared/local-host/client.test.ts`
- `cd client && npm test -- --run src/shared/local-host/client.test.ts src/App.test.tsx`
- `cd local-host && npm test -- --run src/localHostServer.test.ts src/state/sqliteStore.test.ts`
- `cd client && npm test -- --run src/shared/local-host/client.test.ts src/App.test.tsx`

Full workspace verification is tracked in the implementation closeout.

## Next

- Phase 2.10 candidate: local run recovery controls and diagnostics export.
- Add a real MCP runtime adapter behind the existing `mcp.call` allowlist.
- Add browser/IDE tools and visual verification after permission UX is stable.
