# Lark Local Todo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a desktop-only Lark/Feishu connector that keeps raw chat data and credentials on the user's machine, extracts actionable items into SheJane's local todo surface, and uses the Go API only for explicit, redacted cloud extraction.

**Architecture:** Electron packages a platform-specific Lark connector executable beside the frozen local-host daemon. The renderer talks to local-host over the existing paired loopback API. Local-host owns connector subprocess execution, local SQLite persistence, message normalization, candidate filtering, redaction, extraction provider dispatch, todo merge/rank, and local feedback. The Go API exposes a narrow authenticated extraction endpoint that rejects unsafe payloads and records usage metadata without storing raw snippets.

**Tech Stack:** Electron, React, TypeScript, FastAPI, Python, SQLite, Go API, PostgreSQL migrations, existing model registry and wallet billing path, electron-builder `extraResources`, PyInstaller daemon packaging, platform-native credential stores through the Lark connector.

---

## Phase 1: Local-Host Data Contract

- [x] Add focused local-host tests in `local-host/python/tests/test_lark_local_todo.py` for default Lark status, paired-auth enforcement, and connection persistence.
- [x] Add focused local-host tests for source listing, todo listing, and todo status updates.
- [x] Extend `local-host/python/local_host/store/sqlite.py` with additive tables for `local_lark_connections`, `local_lark_sources`, `local_lark_messages`, and `local_todo_items`; do not add token or secret columns.
- [x] Add a store method for ensuring the single Lark connection row.
- [x] Add store methods for listing/upserting sources, creating/listing todo items, and updating todo status fields.
- [x] Add pydantic response models in `local-host/python/local_host/api_schemas.py` for Lark status.
- [x] Add pydantic response/request models for source list/update and todo list/update.
- [x] Add pydantic response/request models for sync request/response.
- [x] Add pydantic response/request models for quote response.
- [x] Add authenticated local-host route for `GET /local/v1/lark/status`.
- [x] Add authenticated local-host routes for `GET /local/v1/lark/sources`, `PATCH /local/v1/lark/sources/{id}`, `GET /local/v1/todos`, and `PATCH /local/v1/todos/{id}`.
- [x] Run `cd local-host/python && uv run python -m pytest tests/test_lark_local_todo.py -q`.

## Phase 2: Connector Resolution And Process Boundary

- [x] Add a `local_host/lark/connector.py` adapter with a command runner interface, argv-list subprocess calls, UTF-8 stdout/stderr handling, timeouts, and no shell execution.
- [x] Add connector path resolution that checks Electron-provided resource paths first, then development `PATH`; unit-test `win32` resolution for `lark-cli.exe`.
- [x] Add macOS/Linux resolution tests for `lark-cli`.
- [x] Pass Electron `process.resourcesPath` to local-host as `SHEJANE_LOCAL_DESKTOP_RESOURCES_PATH` in packaged desktop builds.
- [x] Add `GET /local/v1/lark/status` connector metadata fields so the UI can distinguish bundled, system, missing, needs-auth, connected, and error states.
- [x] Add `POST /local/v1/lark/connect` and `POST /local/v1/lark/disconnect` with managed process cleanup and local connection state updates.
- [x] Add fake-runner tests for login/status/logout command parsing without requiring a real Lark account.

## Phase 3: Sync, Normalize, Filter, Redact

- [x] Add `local_host/lark/normalize.py` for text, post, interactive card text, and media markers; cover each message type with tests.
- [x] Add `local_host/lark/candidates.py` for direct assignment, mention, deadline, request/question, and high-priority source filtering; cover obvious-action and FYI cases.
- [x] Add `local_host/lark/redact.py` for email, phone, URL, IP, token-like string, API-key-like string, long numeric ID, and Lark ID patterns; cover both English and Chinese samples.
- [x] Add read-only CLI-backed source/message import using `im +chat-list` and `im +chat-messages-list`; hash raw Lark IDs before persistence.
- [x] Keep newly discovered CLI sources disabled until the user explicitly selects them; preserve existing user source selections on later imports.
- [x] Add `POST /local/v1/lark/sync` to run a bounded rules-only manual sync over already-local messages, generate candidates, merge/rank todos, and return sync counters.
- [x] Merge similar same-source candidates into one local todo, preserving all source message IDs and avoiding duplicate creation on later syncs.
- [x] Ensure info logs never include raw message text, raw Lark IDs, access tokens, or unredacted candidate snippets.

## Phase 4: Extraction Providers

- [x] Add an extraction provider interface with `rules`, `cloud_redacted`, and reserved `local_model` provider names.
- [x] Implement the rules provider for conservative local-only extraction.
- [x] Add Go API `POST /api/v1/agent/extract-todos` request/response types, validation, authentication, model routing, reservation/settlement/release, and logging controls.
- [x] Add local-host cloud-redacted provider that uses the paired cloud session, sends only redacted candidates, handles failures without deleting existing todos, and leaves cloud extraction disabled by default.
- [x] Pseudonymize local source labels before sending cloud-redacted extraction payloads.
- [x] Include schema version, locale, timezone, and minute-rounded candidate timestamps in cloud-redacted extraction payloads.
- [x] Add Go tests for unauthenticated rejection, unsafe payload rejection, successful billing metadata, and reservation release on model failure.

## Phase 5: Desktop Packaging

- [x] Add connector resource layout under Electron resources, such as `connectors/lark/<platform>-<arch>/lark-cli[.exe]`, outside asar.
- [x] Update `client/electron-builder.yml` to include the connector resource directory in `extraResources` for packaged desktop builds.
- [x] Add a release manifest with connector version, target OS/architecture, executable name, and checksum; make packaging fail when a target binary is missing.
- [x] Update `docs/desktop-distribution.md` with the Lark connector packaging rule, Windows x64 baseline, macOS arm64/x64 behavior, and development fallback to system `lark-cli`.
- [x] Add Windows smoke instructions: launch packaged app, confirm local-host starts, confirm connector discovery returns a controlled unauthenticated or auth-needed status, and confirm disconnect stops subprocesses.

## Phase 6: Client Experience

- [x] Add a desktop-only Connections surface for Lark status, connect/disconnect, source selection, manual sync, cloud extraction toggle, redacted-payload preview, and local cache deletion.
  - [x] Add Lark status, connect/disconnect, manual sync, and cloud extraction toggle.
  - [x] Add source selection, redacted-payload preview, and local cache deletion.
- [x] Persist the cloud extraction toggle in the local Lark connection state and initialize the UI from that local preference.
- [x] Require a redacted preview before the first cloud-enhanced Lark sync; the first sync click in cloud mode generates the preview, and a later sync click sends the redacted payload.
- [x] Refresh source selection after manual sync discovers new local Lark sources.
- [x] Add local-host client methods and generated schema updates through `make schemas`.
- [x] Replace Today mock todo data with local-host todo data where available, preserving local-first empty/loading/error states.
- [x] Wire complete, dismiss, snooze, priority override, and quote-to-chat actions to local-host APIs.
  - [x] Wire complete and quote-to-chat for local-host todos.
  - [x] Wire dismiss, snooze, and priority override for local-host todos.
  - [x] Suppress similar same-source candidates for the day after a local todo is dismissed.
- [x] Add renderer tests for connection states, cloud extraction consent, todo actions, and Windows-sized viewports.
  - [x] Add renderer tests for Lark bundled-CLI status, manual sync, cloud extraction consent, and local todo completion.
  - [x] Add renderer tests for source selection, redacted preview, local cache deletion, todo dismiss/snooze/priority/quote, and a Windows-sized desktop viewport.
- [x] Clear local Lark sources, messages, todos, and raw JSON artifacts on cache deletion and disconnect.

## Phase 6.5: Privacy Retention And Polling

- [x] Add local Lark connection preferences for `data_retention_days`, `auto_sync_enabled`, `auto_sync_interval_minutes`, and `last_auto_synced_at`.
- [x] Default local message retention to 7 days and clamp user-selectable retention to a bounded local range.
- [x] Split CLI sync into source discovery first, then message fetch only for sources the user has explicitly enabled.
- [x] Prune expired local messages and raw JSON artifacts after Lark sync while keeping todo evidence previews.
- [x] Add local daemon auto polling for selected sources while the desktop app is running; keep cloud-redacted extraction manual-only behind preview consent.
- [x] Add Connections UI controls for retention days, auto polling, and polling interval.

## Phase 7: Verification Gate

- [x] Run focused local-host, Go, and renderer tests for the touched areas.
- [x] Run `make schemas` if local-host or Go OpenAPI contracts changed.
- [x] Run `make test`, `make build`, and `git diff --check`.
- [ ] Perform packaged desktop smoke checks on Windows x64 and macOS for connector discovery before enabling the feature row by default.
  - [x] Run `cd client && npm run prepare:connectors && npm run verify:connectors`; verify required `darwin-arm64`, `darwin-x64`, and `win32-x64` connector binaries are present and checksum-valid.
  - [x] Perform unsigned macOS `dist:dir` resource smoke and verify packaged connector checksums.
  - [x] Verify local-host connector discovery resolves bundled `darwin-arm64` and simulated bundled `win32-x64` paths from the packaged `Contents/Resources` directory.
  - [x] Add `npm run smoke:packaged-lark` and pass macOS packaged smoke against the freshly frozen daemon: health, bundled Lark CLI status, controlled needs-auth state, disconnect, and no packaged `lark-cli` leftovers.
  - [ ] Perform native Windows x64 packaged launch smoke: local-host health, Lark row shows bundled CLI, unauthenticated/auth-needed state is controlled, and disconnect leaves no `lark-cli` subprocesses.
- [ ] Stage or commit only when the user explicitly asks.
