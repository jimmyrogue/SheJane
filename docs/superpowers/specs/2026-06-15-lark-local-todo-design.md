# Lark Local Todo Design

> Status: design review draft
> Date: 2026-06-15
> Scope: desktop-only Lark/Feishu message digest into SheJane Today todo items

## Goal

Build a desktop-only Lark/Feishu connector that syncs selected user chats on the user's machine, extracts actionable todo items, and renders them in the existing `TodayView`. Raw Lark message content stays local by default. The Go API is used only for model inference on a small, redacted candidate payload when the user enables cloud extraction.

## Non-Goals

- No web-only Lark sync in the first version.
- No server-side storage of raw Lark messages.
- No server-side Lark OAuth or Lark refresh token storage in the first version.
- No local small-model runtime in the first version.
- No automatic write-back to Lark, such as sending replies, creating Lark tasks, or modifying messages.
- No admin browsing of user Lark content.
- No broad "sync every chat automatically" behavior. Users must choose which chats are indexed.

## Recommended Approach

Use a local-first connector owned by `local-host/python`, backed by local SQLite and optionally powered by the official `lark-cli` for authentication, chat listing, history pull, and event consumption. The desktop client calls local-host APIs for connection status, sync, and todos. The Go API remains the cloud model gateway and billing plane, but it only receives a deliberately minimized extraction request:

- redacted candidate messages,
- stable local source references,
- no Lark access tokens,
- no full chat history,
- no unsampled surrounding conversation,
- no sender display names unless locally redacted or pseudonymized.

This matches SheJane's existing local harness boundary: local data and tool results stay on the machine; platform-paid LLM calls go through the Go API.

## Bundled Desktop Connector

The production desktop app must include a Lark connector executable for every shipped desktop target. Users should not need to install Node.js, npm, Go, Python, or a separate terminal tool before connecting Lark.

### Supported Desktop Target

- Windows support follows the existing desktop distribution baseline: Windows 10 or newer, x64 only.
- macOS support follows the existing desktop distribution baseline: separate arm64 and x64 packages.
- Future Linux packages, if shipped, must follow the same rule: include the matching connector binary instead of asking the user to install it manually.
- The connector is bundled with the Electron desktop app and the PyInstaller local-host daemon flow. It is not available in the web build.
- Packaging must treat the connector as a native subprocess resource, like the frozen local-host daemon.

### Lark CLI Packaging

Development can use a system-installed `lark-cli`, but production desktop packages must ship a pinned connector binary:

The implementation should support this order:

1. Use a bundled connector from Electron `extraResources` when present.
2. Fall back to a system `lark-cli` on `PATH` for development and power users.
3. If neither exists, show a platform-friendly setup error in `ConnectionsView`.

Bundled executable names:

- Windows x64: `lark-cli.exe`
- macOS arm64/x64: `lark-cli`
- Future Linux x64/arm64: `lark-cli`

The bundled executable must be built or fetched per OS/architecture in the desktop release workflow and included outside asar so local-host can spawn it. The release workflow should pin the connector version, record its checksum in a manifest, and fail the build if the expected binary is missing.

The app version owns the connector version. Upgrading SheJane upgrades the connector atomically with the rest of the desktop package, which avoids support cases where the app and a user-installed CLI drift apart.

### Process Execution Rules

Local-host must call the connector with argv lists and `shell=False`. It must not rely on POSIX shell syntax, `which`, `bash`, `tail -f`, slash-only paths, executable bits, or environment expansion that behaves differently on Windows.

Windows-specific requirements:

- Resolve `lark-cli.exe` explicitly.
- Quote nothing manually; pass args as a list.
- Assume install/resource paths may contain spaces and non-ASCII characters.
- Capture stdout/stderr as UTF-8.
- Enforce timeouts for history sync commands.
- Stop long-running event consumers through a managed process handle; desktop shutdown already uses `taskkill /T /F` for the daemon, but connector subprocesses should exit cleanly where possible.

macOS-specific requirements:

- Resolve the connector under `process.resourcesPath`.
- Ensure the connector binary is signed with the rest of the app bundle.
- Do not assume a Homebrew-installed `lark-cli`.

### Credentials On Windows

Lark credentials must remain in the user's OS credential store. For Windows, that means the connector relies on Windows Credential Manager or an equivalent OS-native secret store. On macOS, it should use Keychain. SheJane local SQLite must not gain token columns as a fallback.

Disconnect behavior on Windows:

- Stop active event consumers.
- Clear local SheJane cache for the connection.
- If SheJane created the Lark login context, call the connector logout command.
- If credentials pre-existed outside SheJane, ask before removing them.

### File And Cache Paths

Use `Path.home()` / platform APIs for local data. Do not embed `/Users/...`, `/tmp`, `~` string expansion assumptions, or Unix-only hidden-file behavior into connector code. The current local-host default `Path.home() / ".shejane" / "local-host"` is acceptable on Windows, but UI copy should describe it as "local app data" rather than a Unix path.

### Windows Release Checks

The implementation plan must include Windows-specific validation:

- unit tests for connector path resolution on `win32`,
- fake command-runner tests using `lark-cli.exe`,
- local-host HTTP tests that do not depend on POSIX shell behavior,
- Electron harness check for Connections and Today on Windows-sized viewports,
- packaged Windows smoke: launch app, local-host starts, connector binary is discoverable, Lark status returns a controlled unauth/auth-needed state,
- signed installer check once Windows signing is enabled.

## Architecture

```text
Electron renderer
  |  local pairing token
  v
local-host/python
  |-- Lark connector adapter
  |-- local SQLite: sources, messages, candidates, todos, sync cursors
  |-- local redaction + candidate filtering
  |-- extraction provider interface
        |-- rules-only provider
        |-- cloud-redacted provider through Go API
        |-- reserved local-model provider slot
  |
  | redacted candidate payload only
  v
Go API model gateway
  |-- Reserve / Settle credits
  |-- model catalog routing
  |-- structured extraction response
```

## Privacy Boundary

### Always Local

- Lark app credentials, user access tokens, refresh tokens, and `lark-cli` keychain state.
- Raw Lark message content.
- Full chat names, sender names, and member lists.
- User-selected source list and sync cursors.
- Raw event payloads from Lark.
- Message-to-todo source mapping.
- User feedback such as complete, dismiss, snooze, and priority override.

### Allowed To Cloud Only With Explicit Setting

The cloud extraction payload may contain:

- short candidate snippets after local redaction,
- pseudonymous source labels such as `chat_7` and `sender_3`,
- timestamps rounded to minute precision,
- message IDs replaced by local opaque source refs,
- a task extraction schema,
- the user's language preference and timezone.

The cloud extraction payload must not contain:

- Lark access tokens or app secrets,
- raw chat IDs,
- raw user IDs, open IDs, union IDs, or emails,
- unredacted phone numbers, addresses, payment data, secrets, or API keys,
- full conversations that were not selected as candidates,
- attachments or file content.

### Cloud Persistence

The Go API records normal LLM metadata and billing records, as it does for other model calls. It must not persist prompt text or extracted Lark snippets in admin-visible tables. If request/response logging exists in a deployment, this endpoint must opt out or log only redaction-safe counters.

## User Controls

The desktop connection flow must show these controls:

- Connect Lark locally.
- Select chats to sync.
- Run manual sync.
- Enable or disable cloud extraction.
- Show a preview of what leaves the machine before the first cloud extraction.
- Disconnect Lark and delete local Lark cache.

Default settings:

- Lark sync: off until connected.
- Source selection: empty.
- Cloud extraction: off until user enables it.
- Local model extraction: unavailable, shown only as a future-compatible capability if surfaced at all.
- Rules-only extraction: available by default.

## Data Model

All connector-specific content lives in local-host SQLite first.

### `local_lark_connections`

- `id`
- `provider` fixed to `lark`
- `status`: `disconnected | needs_auth | connected | error`
- `tenant_label`
- `account_label`
- `auth_mode`: `lark_cli`
- `cloud_extraction_enabled`
- `last_checked_at`
- `last_error_code`
- `created_at`
- `updated_at`

No access token columns are added.

### `local_lark_sources`

- `id`
- `connection_id`
- `provider_source_id_hash`
- `source_type`: `p2p | group | thread`
- `display_label`
- `sync_enabled`
- `last_synced_at`
- `last_message_time`
- `created_at`
- `updated_at`

`provider_source_id_hash` is deterministic locally for de-duplication but never sent to cloud.

### `local_lark_messages`

- `id`
- `connection_id`
- `source_id`
- `provider_message_id_hash`
- `sender_hash`
- `message_type`
- `text`
- `redacted_text`
- `created_at_lark`
- `received_at`
- `raw_json_path`

`text` is local only. `raw_json_path` points to a local artifact file only when needed for debugging; normal sync can leave it empty.

### `local_todo_items`

- `id`
- `provider`: `lark`
- `source_id`
- `source_message_ids`
- `priority`: `now | today | later | fyi`
- `status`: `open | completed | dismissed | snoozed`
- `title`
- `summary`
- `suggested_action`: `reply | schedule | create_task | review | none`
- `due_at`
- `confidence`
- `extraction_provider`: `rules | cloud_redacted | local_model`
- `evidence_preview`
- `created_at`
- `updated_at`

`local_model` is reserved in the enum now so future local extraction does not require a schema rewrite.

## Extraction Pipeline

### Step 1: Sync

The connector pulls messages only from selected sources. Initial sync defaults to a bounded window such as the current day plus a small lookback, controlled by local settings. Incremental sync uses `last_message_time` and source cursor state.

### Step 2: Local Normalize

The connector normalizes text from Lark message types:

- `text`: parse text body.
- `post`: flatten rich text to readable text.
- `interactive`: extract visible card title and text fields when available.
- media/file/sticker: keep a type marker such as `[file]` without downloading content.

### Step 3: Local Candidate Filter

Rules produce candidates before any LLM call:

- direct message to the user,
- `@` mention of the user,
- contains action verbs such as confirm, send, review, decide, reply, update,
- contains deadline terms such as today, tomorrow, before noon, EOD, this week,
- contains question or request phrasing,
- message is from a selected high-priority source.

Messages that do not pass the filter stay local and never go to the cloud extractor.

### Step 4: Redaction

Redaction happens before cloud extraction. It must cover at least:

- email,
- phone,
- URL,
- IP address,
- access-token-like strings,
- API-key-like strings,
- long numeric IDs,
- Lark IDs with `ou_`, `oc_`, `om_`, `on_`, `cli_` prefixes,
- explicit secrets containing keywords such as token, secret, password, key.

The redactor also pseudonymizes sender and chat labels in a stable local map for the extraction batch.

### Step 5: Extract

The extraction provider returns a strict JSON shape:

```json
{
  "items": [
    {
      "source_ref": "local-msg-opaque-ref",
      "is_actionable": true,
      "priority": "today",
      "title": "确认 Q3 预算初版",
      "summary": "对方需要今天上午拿到初版预算数字。",
      "suggested_action": "reply",
      "due_at": "2026-06-15T12:00:00+08:00",
      "confidence": 0.86,
      "reason": "direct request with same-day deadline"
    }
  ]
}
```

If cloud extraction is disabled, the rules provider creates conservative items only for obvious direct requests and mentions.

### Step 6: Merge And Rank

Local-host merges items that share a source thread or reference the same deadline/action. Priority order is:

1. explicit deadline and direct assignment,
2. private chat or direct mention,
3. high-priority selected source,
4. question/request wording,
5. model confidence,
6. recency.

### Step 7: Feedback

User actions feed only local state:

- completing an item marks it done locally,
- dismissing an item suppresses similar candidates from the same source for the day,
- priority changes become local ranking hints,
- quote-to-chat sends the todo summary into SheJane chat, not the raw Lark message unless the user explicitly includes it.

## API Surfaces

### Local Host APIs

- `GET /local/v1/lark/status`
- `POST /local/v1/lark/connect`
- `POST /local/v1/lark/disconnect`
- `GET /local/v1/lark/sources`
- `PATCH /local/v1/lark/sources/{id}`
- `POST /local/v1/lark/sync`
- `GET /local/v1/todos?provider=lark`
- `PATCH /local/v1/todos/{id}`
- `POST /local/v1/todos/{id}/quote`

These endpoints require the existing local pairing token.

### Go API Endpoint

- `POST /api/v1/agent/extract-todos`

Request:

- `provider`: `lark`
- `timezone`
- `locale`
- `schema_version`
- `candidates[]`

Each candidate includes only redacted text, local opaque source ref, message type, and coarse timestamp.

Response:

- strict JSON item list matching the extraction schema,
- usage metadata,
- no raw prompt echo.

The endpoint uses the existing authenticated cloud session injected into local-host and the same model catalog / billing path as agent-local model calls.

## Error Handling

- Lark CLI missing: show local setup guidance in Connections, no cloud fallback.
- Lark auth expired: mark connection `needs_auth`, preserve local todo state.
- Permission missing: show the missing permission names and keep rules-only local todos available.
- Cloud extraction disabled: run rules-only extraction.
- Cloud extraction fails: keep local candidates, show extraction error, do not delete existing todos.
- Redaction rejects payload: block cloud extraction for that batch and show a privacy-safe local error.
- Sync rate limited: back off locally and surface next retry time.

## Security Requirements

- Never log raw Lark message text at info level.
- Debug logs must redact message content by default.
- Do not include raw Lark IDs in cloud payloads.
- Do not write Lark tokens to `.env`, local-host SQLite, Go API, or admin tables.
- Disconnection must stop event consumers and remove local connection credentials created by SheJane, while respecting credentials owned by `lark-cli`.
- Local cache deletion must remove messages, candidates, todos, cursors, and raw artifact files for the connection.

## Testing Strategy

### Local Host

- Unit-test Lark message normalization for text, post, interactive, and media markers.
- Unit-test redaction for emails, phones, URLs, Lark IDs, and token-like strings.
- Unit-test candidate filtering with direct mention, private chat, deadline, and non-action FYI cases.
- Unit-test merge/rank with duplicate messages and priority overrides.
- HTTP-test local APIs with pairing required.
- CLI adapter tests use a fake command runner returning fixture JSON and NDJSON events.

### Go API

- Test `POST /api/v1/agent/extract-todos` rejects unauthenticated requests.
- Test request validation rejects raw Lark ID patterns and token-like content.
- Test successful extraction records billing metadata but does not expose prompt text in admin payloads.
- Test model failure releases reservations.

### Client

- `ConnectionsView` renders local Lark connection states and cloud extraction toggle.
- `TodayView` renders local-host todos instead of mock data.
- Complete, dismiss, snooze, and quote actions call local-host APIs.
- Empty, loading, auth-needed, permission-needed, and sync-error states are covered.

## Rollback

The feature can be disabled by hiding the Lark connection row in desktop builds and leaving local-host endpoints unused. Local database migrations are additive. Existing chat, billing, model catalog, MCP, and skills flows are unaffected.

## MVP Decisions

1. `lark-cli` packaging: prototype with an external `lark-cli`, but production desktop packages must bundle the matching connector executable in `extraResources` for every shipped OS/architecture. The app may still fall back to system `lark-cli` for development.
2. Cloud extraction default: available but gated. The first cloud extraction requires a preview of the redacted payload and explicit user consent.
3. Local cache retention: default 7 days for synced raw messages, with a manual "delete local Lark cache" action.

These defaults keep the implementation path unblocked while preserving the privacy boundary.
