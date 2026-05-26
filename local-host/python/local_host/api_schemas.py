"""Single source of truth for the HTTP API's request/response shapes.

Why this module exists:

  Before this file, every handler returned `dict[str, Any]`. That made
  `app.openapi()` output useless (just `additionalProperties: True`
  with no field names), so the client couldn't generate types from it
  and had to hand-maintain interfaces in `client/src/shared/local-host/
  client.ts`. The 2026-05-22 contract repair session was the result —
  9+ silent shape drifts between hand-written TS interfaces and
  daemon dict returns.

  Now: every response gets a pydantic model declared here, handlers
  use `response_model=ModelName`, and FastAPI emits a real
  `components.schemas` section in openapi.json that `openapi-typescript`
  consumes. `make schemas` regenerates the TS .d.ts; CI rejects PRs
  where they drift.

Conventions:

  • Field names use snake_case (matches the wire + the original TS
    interfaces). Don't rename to camelCase — that's a breaking
    change for every renderer that reads these.
  • `Literal[...]` types over plain `str` whenever the value set is
    finite (e.g. `reason: Literal["authorized", ...]`) — they
    generate as TS string-literal unions, much better than bare
    `string`.
  • Optional fields use `| None = None` (NOT `Optional[T]`) for
    consistency with PEP 604 + the rest of the codebase.
  • SSE event payloads are NOT in here — discriminated unions over
    `event_type` don't roundtrip cleanly through openapi. The wire
    format is documented in `docs/client-sse-protocol.md` and the
    TS `AgentRunEvent` interface stays hand-written in
    `client/src/shared/api/sse.ts`.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


class HealthResponse(BaseModel):
    """GET /local/v1/health — no auth required.

    Both `ok` (legacy smoke contract) and `status` (current TS client
    probe) are returned. Drop `ok` once smoke scripts are updated.
    """

    ok: bool = True
    status: Literal["ok"] = "ok"
    mode: str = "ready"
    worker: str = "python-langgraph"
    version: str
    pairing_configured: bool


# ---------------------------------------------------------------------------
# Cloud session (LocalCloudSession in TS)
# ---------------------------------------------------------------------------


class LocalCloudSession(BaseModel):
    """Pairing state between the daemon and the cloud API.

    `connected: false` is the only field on an unpaired response; the
    rest become present once the user logs in via the Electron app
    and the renderer POSTs the JWT to /local/v1/session.
    """

    connected: bool
    cloud_base_url: str | None = None
    auth: Literal["bearer"] | None = None
    updated_at: str | None = None


class SetCloudSessionRequest(BaseModel):
    cloud_base_url: str
    access_token: str


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------


RunStatus = Literal[
    "queued",
    "running",
    "waiting_permission",
    "waiting_input",
    "completed",
    "canceled",
    "failed",
]


class LocalRun(BaseModel):
    """One row of the `local_runs` table, surfaced over HTTP.

    `history_json` / `settings_json` are stringified JSON because
    SQLite stores them that way — the client parses on demand. Kept
    as strings here (not dict) to keep the wire format honest.
    """

    id: str
    goal: str
    status: RunStatus
    workspace_path: str | None = None
    created_at: str
    updated_at: str
    completed_at: str | None = None
    canceled_at: str | None = None
    history_json: str = "[]"
    parent_run_id: str | None = None
    settings_json: str = "{}"
    events_count: int | None = None


class ListRunsResponse(BaseModel):
    runs: list[LocalRun]


class CreateRunRequest(BaseModel):
    goal: str
    workspace_path: str | None = None
    # Mode the user picked in the UI:
    #   "auto" — daemon runs an LLM classifier first to pick fast/deep
    #   "fast" — cheaper / lower-latency tier
    #   "pro"  — higher-quality tier (better at multi-step reasoning).
    #            Wire alias for the legacy "deep" name used internally by
    #            the Go LLM router; the daemon maps pro→deep before
    #            calling the cloud LLM gateway. The concrete model each
    #            tier resolves to is owned by the Go model registry, not
    #            this schema — don't hardcode provider/model names here.
    # Default is "fast" (not "auto") so legacy callers — tests, manual
    # curl, anything from before the auto-router shipped — get the cheap
    # path without paying for an unexpected classifier call. The desktop
    # UI always sends an explicit mode, so this default only ever fires
    # for direct API consumers.
    mode: Literal["auto", "fast", "pro", "deep"] = "fast"
    history: list[dict[str, str]] | None = None
    parent_run_id: str | None = None
    settings: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Workspaces
# ---------------------------------------------------------------------------


class LocalWorkspaceAuthorization(BaseModel):
    id: str
    path: str
    label: str
    created_at: str
    last_used_at: str


class ListWorkspacesResponse(BaseModel):
    workspaces: list[LocalWorkspaceAuthorization]


class CreateWorkspaceRequest(BaseModel):
    path: str
    label: str = ""


class DiagnoseWorkspaceRequest(BaseModel):
    path: str


class LocalWorkspaceDiagnosis(BaseModel):
    """Result of POST /local/v1/workspaces/diagnose. The `reason` field
    drives the workspace-picker UI's "why is this disabled?" copy —
    keep the enum stable."""

    path: str
    exists: bool
    is_directory: bool
    authorized: bool
    reason: Literal["authorized", "not_authorized", "not_found", "not_directory"]
    workspace: LocalWorkspaceAuthorization | None = None


# ---------------------------------------------------------------------------
# Permissions (HITL)
# ---------------------------------------------------------------------------


PermissionDecision = Literal["approve", "deny"]
PermissionScope = Literal["once", "run"]


class ResolvePermissionRequest(BaseModel):
    decision: PermissionDecision
    scope: PermissionScope = "once"


class PermissionResolution(BaseModel):
    permission_id: str
    resolved: Literal[True] = True
    decision: PermissionDecision
    scope: PermissionScope
    resumed: bool


# ---------------------------------------------------------------------------
# Questions (user.ask)
# ---------------------------------------------------------------------------


class AnswerQuestionRequest(BaseModel):
    # answers: { <question_id>: [text, ...] }
    answers: dict[str, list[str]]


class QuestionAnswer(BaseModel):
    question_id: str
    answered: Literal[True] = True
    resumed: bool


# ---------------------------------------------------------------------------
# Artifacts
# ---------------------------------------------------------------------------


class LocalArtifact(BaseModel):
    """Slim representation for `GET /artifacts/:id` (UI quoting).

    The full row in `local_artifacts` (run_id, kind, content_type,
    bytes, metadata_json) is intentionally NOT returned here — that
    payload is for the diagnostics panel, not the chat surface.
    """

    id: str
    title: str
    content: str
    tool_name: str | None = None
    created_at: str


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------


class DiagnosticsPermission(BaseModel):
    id: str
    run_id: str
    tool_call_id: str | None = None
    tool_name: str
    arguments: dict[str, Any]
    status: str
    scope: PermissionScope = "once"
    created_at: str
    resolved_at: str | None = None


class DiagnosticsArtifact(BaseModel):
    id: str
    run_id: str
    kind: str
    title: str
    content_type: str
    bytes: int
    tool_call_id: str | None = None
    tool_name: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str


class DiagnosticsEvent(BaseModel):
    """One row from the `local_events` table after payload parsing.

    Matches the AgentRunEvent envelope the client's
    `parseAgentSSEChunk` produces (intentional, so the diagnostics
    panel can reuse the live-stream renderer).
    """

    id: str
    run_id: str
    seq: int
    event_type: str
    payload: dict[str, Any]
    created_at: str


class LatestCheckpoint(BaseModel):
    """Slim summary of the agent run's last persisted superstep — used
    by the diagnostics panel to render the "where the run is paused"
    headline. The full LangGraph checkpoint is much larger; we just
    expose the fields the UI reads (`id`, `reason`, `messages_count`)."""

    id: str
    run_id: str | None = None
    step: int
    reason: str
    messages_count: int
    created_at: str | None = None


class LocalRunDiagnostics(BaseModel):
    schema_version: Literal[1] = 1
    exported_at: str
    local_host_version: str | None = None
    run: LocalRun
    events: list[DiagnosticsEvent]
    permissions: list[DiagnosticsPermission]
    artifacts: list[DiagnosticsArtifact]
    latest_checkpoint: LatestCheckpoint | None = None


# ---------------------------------------------------------------------------
# Simple ack envelopes — used by handlers that don't have a richer return.
# ---------------------------------------------------------------------------


class CancelRunResponse(BaseModel):
    canceled: bool


class ResumeRunResponse(BaseModel):
    resumed: Literal[True] = True


# ---------------------------------------------------------------------------
# Memory
# ---------------------------------------------------------------------------


class ClearMemoryResponse(BaseModel):
    """DELETE /local/v1/memory — wipes the agent's long-term notes.

    Reported back so the renderer can show "cleared N memories" toast
    instead of a generic "done" message.
    """

    cleared: Literal[True] = True
    deleted_count: int


# ---------------------------------------------------------------------------
# MCP servers (discovery only — we never install / manage these)
# ---------------------------------------------------------------------------


class McpServerInfo(BaseModel):
    """One MCP server we discovered on the user's machine.

    `name` is the unique key the user (or installer tool) gave it.
    `transport` is the normalized transport — `stdio` / `streamable_http`
    / `sse` / `websocket`. `command` / `args` / `url` / `env_keys` are
    descriptive only — we never echo env *values* (could be secrets).
    `source` is one of `shejane` / `claude-desktop` / `cursor` / `codex`
    / `env` — used by the UI to group servers by provenance.
    `source_path` is the absolute path of the config file the entry was
    read from, displayed in the settings panel so the user knows where
    to go edit it.
    """

    name: str
    transport: str
    source: str
    source_path: str
    command: str | None = None
    args: list[str] = []
    url: str | None = None
    env_keys: list[str] = []
    cwd: str | None = None


class McpServerCatalog(BaseModel):
    """GET /local/v1/mcp-servers — the full list of discovered servers
    plus the set of sources we scanned. `sources` lets the UI render
    empty-state hints like "no Claude Desktop config found" even when
    no server came from there.
    """

    servers: list[McpServerInfo]
    sources_scanned: list[str]


# ---------------------------------------------------------------------------
# Code execution (E2B microVM sandbox)
# ---------------------------------------------------------------------------


class CodeExecuteResultModel(BaseModel):
    """Wire shape for the `code.execute` tool's structured result.

    The Python @tool returns this nested under the tool message's
    `data` field so the client renderer (CodeExecutionPreview) can
    render rich output (matplotlib figures as base64 PNGs, pandas
    DataFrames as HTML, etc.) without re-parsing free text.

    Field naming mirrors what the Go API gateway returns
    (api/internal/httpapi/code_gateway.go:codeExecData) so the daemon
    can pass-through the gateway envelope's `data` dict unchanged.
    Keep them in sync — drift here means the client renders nothing.
    """

    source: Literal["code.execute"] = "code.execute"
    sandbox_id: str = ""
    session_id: str = ""
    stdout: str = ""
    stderr: str = ""
    error_name: str = ""
    error_value: str = ""
    traceback: list[str] = []
    results: list[dict[str, Any]] = []
    # Each entry: {path: "/output/foo.png", content_b64: "...", size: 1234}
    # Set by the Go gateway after listing /output/ in the sandbox; the
    # daemon decodes + writes them to workspace/.code-output/<conv_id>/
    # before returning to the agent.
    files_out: list[dict[str, Any]] = []
    # Workspace-relative paths the daemon actually wrote files_out to.
    # Only present when at least one file was synced successfully —
    # the client renders these as "open this file" chips. Populated
    # by tools/code.py:_write_files_out, not by the Go gateway.
    files_out_local: list[str] = []
    execution_ms: int = 0
