"""Single source of truth for the HTTP API's request/response shapes.

Why this module exists:

  Before this file, every handler returned `dict[str, Any]`. That made
  `app.openapi()` output useless (just `additionalProperties: True`
  with no field names), so the client couldn't generate types from it
  and had to hand-maintain interfaces in `apps/desktop/src/shared/local-host/
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
    format is documented in `docs/runtime-protocol.md` and the
    TS `AgentRunEvent` interface stays hand-written in
    `packages/runtime-sdk/src/client.ts`.
"""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_LOCAL_REQUEST_BODY_BYTES = 1_048_576

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


class RuntimeInfo(BaseModel):
    """Authenticated Runtime protocol and capability discovery."""

    protocol_version: int
    runtime_version: str
    capabilities: list[str]
    model_provider_configured: bool


class RuntimeSettingsResponse(BaseModel):
    """Persisted defaults used when accepting future runs."""

    version: int = 0
    max_model_calls: int = Field(default=20, ge=1, le=100)
    max_tool_retries: int = Field(default=2, ge=0, le=5)
    research_search_limit: int = Field(default=3, ge=1, le=20)
    unknown_model_max_input_tokens: int = Field(default=32_768, ge=8_192, le=10_000_000)
    unknown_model_max_output_tokens: int = Field(default=8_192, ge=128, le=1_000_000)
    model_request_timeout_seconds: float = Field(default=120.0, ge=5.0, le=900.0)
    browser_headless: bool = True
    subagents: bool = True
    input_guard: Literal["off", "observe", "block"] = "observe"
    plan_first: Literal["off", "auto", "always"] = "off"
    verification_repair_max: int = Field(default=1, ge=0, le=3)
    repair_workflow_max: int = Field(default=3, ge=0, le=5)
    pii_redact: str = Field(default="", max_length=200)


class UpdateRuntimeSettingsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_model_calls: int | None = Field(default=None, ge=1, le=100)
    max_tool_retries: int | None = Field(default=None, ge=0, le=5)
    research_search_limit: int | None = Field(default=None, ge=1, le=20)
    unknown_model_max_input_tokens: int | None = Field(default=None, ge=8_192, le=10_000_000)
    unknown_model_max_output_tokens: int | None = Field(default=None, ge=128, le=1_000_000)
    model_request_timeout_seconds: float | None = Field(default=None, ge=5.0, le=900.0)
    browser_headless: bool | None = None
    subagents: bool | None = None
    input_guard: Literal["off", "observe", "block"] | None = None
    plan_first: Literal["off", "auto", "always"] | None = None
    verification_repair_max: int | None = Field(default=None, ge=0, le=3)
    repair_workflow_max: int | None = Field(default=None, ge=0, le=5)
    pii_redact: str | None = Field(default=None, max_length=200)


class LocalModelProfile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model_id: str = Field(min_length=1, max_length=200, pattern=r"^\S+$")
    display_name: str = Field(min_length=1, max_length=100)
    tool_calling: bool = True
    streaming: bool = True
    max_input_tokens: int | None = Field(default=None, ge=1, le=10_000_000)
    max_output_tokens: int | None = Field(default=None, ge=128, le=1_000_000)


class LocalModelProvider(BaseModel):
    id: str
    name: str
    kind: Literal["openai_compatible"]
    base_url: str
    requires_api_key: bool
    credential_configured: bool
    models: list[LocalModelProfile]
    enabled: bool
    version: int
    created_at: str
    updated_at: str


class ListLocalModelProvidersResponse(BaseModel):
    providers: list[LocalModelProvider]


class UpsertLocalModelProviderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=100)
    kind: Literal["openai_compatible"] = "openai_compatible"
    base_url: str = Field(min_length=1, max_length=2048)
    requires_api_key: bool = True
    api_key: str | None = Field(default=None, min_length=1, max_length=8192)
    models: list[LocalModelProfile] = Field(min_length=1, max_length=100)
    enabled: bool = True


class LocalRuntimeModel(BaseModel):
    spec: str
    model_id: str
    display_name: str
    provider_id: str
    provider_name: str
    tool_calling: bool
    streaming: bool
    max_input_tokens: int | None = None
    max_output_tokens: int | None = None
    available: bool


class LocalRuntimeModelCatalog(BaseModel):
    models: list[LocalRuntimeModel]


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------


RunStatus = Literal[
    "queued",
    "running",
    "waiting_permission",
    "waiting_input",
    "cleanup_required",
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
    metadata_json: str = "{}"
    events_count: int | None = None
    command_id: str | None = None
    client_message_id: str | None = None
    graph_thread_id: str | None = None
    graph_checkpoint_id: str | None = None
    thread_id: str | None = None
    assistant_item_id: str | None = None
    user_input: str | None = None


class ListRunsResponse(BaseModel):
    runs: list[LocalRun]


class LocalThread(BaseModel):
    id: str
    title: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    version: int
    created_at: str
    updated_at: str
    archived_at: str | None = None
    deleted_at: str | None = None


class UpdateLocalThreadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=512)
    metadata: dict[str, Any] | None = None
    archived: bool | None = None


class DeleteLocalThreadResponse(BaseModel):
    id: str
    deleted: Literal[True] = True
    version: int


class LocalThreadItem(BaseModel):
    id: str
    thread_id: str
    run_id: str | None = None
    client_id: str | None = None
    item_type: str
    status: str
    content: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    position: int
    version: int
    created_at: str
    updated_at: str
    completed_at: str | None = None


class LocalThreadChange(BaseModel):
    cursor: int
    thread_id: str
    thread_version: int
    change_type: str
    run_id: str | None = None
    created_at: str


class LocalThreadEvent(BaseModel):
    id: str
    run_id: str
    seq: int
    event_type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: str


class ListThreadsResponse(BaseModel):
    threads: list[LocalThread]
    cursor: int
    has_more: bool = False
    next_before_created_at: str | None = None
    next_before_id: str | None = None


class LocalThreadSnapshot(BaseModel):
    thread: LocalThread
    items: list[LocalThreadItem]
    runs: list[LocalRun]
    events: list[LocalThreadEvent]
    event_high_watermarks: dict[str, int] = Field(default_factory=dict)
    cursor: int
    has_more_items: bool = False
    next_before_position: int | None = None
    events_truncated: bool = False


class ListThreadChangesResponse(BaseModel):
    changes: list[LocalThreadChange]
    cursor: int


def _has_invalid_capability_name(capabilities: list[str]) -> bool:
    return any(
        not item or len(item) > 64 or not all(char.isalnum() or char in "._-" for char in item)
        for item in capabilities
    )


class CreateRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command_id: str = Field(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    )
    client_message_id: str = Field(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    )
    thread_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    )
    assistant_message_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    )
    protocol_version: int = Field(ge=1, le=65_535)
    required_capabilities: list[str] = Field(max_length=32)
    goal: str = Field(max_length=131_072)
    user_input: str | None = Field(default=None, max_length=131_072)
    thread_title: str | None = Field(default=None, max_length=512)
    thread_metadata: dict[str, Any] | None = None
    user_item_metadata: dict[str, Any] | None = None
    replace_from_client_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    )
    workspace_path: str | None = Field(default=None, max_length=4096)
    # Runtime model selection, normally `local:<provider>:<model>`.
    model: str = Field(min_length=1, max_length=128, pattern=r"^local:[^:]+:.+$")
    history: list[dict[str, str]] | None = Field(default=None, max_length=256)
    parent_run_id: str | None = Field(default=None, max_length=128)
    settings: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None

    @model_validator(mode="after")
    def persistent_payload_fits(self) -> CreateRunRequest:
        if self.assistant_message_id == self.client_message_id:
            raise ValueError("assistant_message_id must differ from client_message_id")
        if _has_invalid_capability_name(self.required_capabilities):
            raise ValueError("required_capabilities contains an invalid capability name")
        for field_name, value in (("settings", self.settings), ("metadata", self.metadata)):
            nodes = 0
            stack: list[tuple[Any, int]] = [(value, 1)] if value is not None else []
            while stack:
                item, depth = stack.pop()
                nodes += 1
                if depth > 8 or nodes > 512:
                    raise ValueError(f"{field_name} exceeds the depth or node limit")
                children = (
                    item.values()
                    if isinstance(item, dict)
                    else item
                    if isinstance(item, list)
                    else ()
                )
                stack.extend((child, depth + 1) for child in children)
        encoded = json.dumps(
            self.model_dump(mode="json"),
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if len(encoded) > MAX_LOCAL_REQUEST_BODY_BYTES:
            raise ValueError("run command exceeds the 1 MiB persistence limit")
        return self


ScheduledRunStatus = Literal["scheduled", "running", "completed", "failed", "canceled"]


class LocalScheduledRun(BaseModel):
    id: str
    goal: str
    status: ScheduledRunStatus
    run_at: str
    workspace_path: str | None = None
    model: str = "auto"
    history_json: str = "[]"
    settings_json: str = "{}"
    metadata_json: str = "{}"
    run_id: str | None = None
    result_text: str | None = None
    error_message: str | None = None
    created_at: str
    updated_at: str
    completed_at: str | None = None
    notified_at: str | None = None


class ListScheduledRunsResponse(BaseModel):
    schedules: list[LocalScheduledRun]


class CreateScheduledRunRequest(BaseModel):
    goal: str
    run_at: str
    workspace_path: str | None = None
    model: str = Field(min_length=1, max_length=128, pattern=r"^local:[^:]+:.+$")
    history: list[dict[str, str]] | None = None
    settings: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None


class ForkRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
    client_message_id: str = Field(
        min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$"
    )
    assistant_message_id: str = Field(
        min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$"
    )
    thread_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
    protocol_version: int = Field(ge=1, le=65_535)
    required_capabilities: list[str] = Field(max_length=32)
    checkpoint_id: str = Field(min_length=1, max_length=256)
    goal: str | None = Field(default=None, max_length=131_072)
    user_input: str = Field(max_length=131_072)
    thread_title: str | None = Field(default=None, max_length=512)
    thread_metadata: dict[str, Any] | None = None
    user_item_metadata: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None

    @model_validator(mode="after")
    def validate_client_ids(self) -> ForkRunRequest:
        if self.client_message_id == self.assistant_message_id:
            raise ValueError("client_message_id and assistant_message_id must differ")
        if _has_invalid_capability_name(self.required_capabilities):
            raise ValueError("required_capabilities contains an invalid capability name")
        encoded = json.dumps(
            self.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        if len(encoded) > MAX_LOCAL_REQUEST_BODY_BYTES:
            raise ValueError("fork command exceeds the 1 MiB persistence limit")
        return self


class InjectRunInstructionRequest(BaseModel):
    content: str


class InjectRunInstructionResponse(BaseModel):
    run_id: str
    instruction_id: str
    queued: Literal[True] = True


PlanApprovalDecision = Literal["approve", "modify", "reject"]


class ResolvePlanApprovalRequest(BaseModel):
    decision: PlanApprovalDecision
    instructions: str | None = Field(default=None, max_length=8192)


class PlanApprovalResolution(BaseModel):
    approval_id: str
    resolved: Literal[True] = True
    decision: PlanApprovalDecision
    resumed: bool


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


# ---------------------------------------------------------------------------
# Permissions (HITL)
# ---------------------------------------------------------------------------


PermissionDecision = Literal["approve", "edit", "deny"]
PermissionScope = Literal["once", "run"]


class EditedToolAction(BaseModel):
    name: str = Field(min_length=1)
    args: dict[str, Any]


class ResolvePermissionRequest(BaseModel):
    decision: PermissionDecision
    scope: PermissionScope = "once"
    edited_action: EditedToolAction | None = None

    @model_validator(mode="after")
    def validate_edit(self) -> ResolvePermissionRequest:
        if self.decision == "edit" and self.edited_action is None:
            raise ValueError("edited_action is required when decision is edit")
        if self.decision != "edit" and self.edited_action is not None:
            raise ValueError("edited_action is only valid when decision is edit")
        if self.decision == "edit" and self.scope != "once":
            raise ValueError("edited tool calls can only be approved once")
        return self


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


class ReconcileToolRequest(BaseModel):
    decision: Literal["confirmed_completed", "retry_not_executed", "abort"]


class ToolReconciliationResolution(BaseModel):
    operation_id: str
    resolved: Literal[True] = True
    decision: Literal["confirmed_completed", "retry_not_executed", "abort"]
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


class DiagnosticsFailure(BaseModel):
    """Structured classification for the latest failed run/tool event."""

    category: Literal[
        "transient",
        "auth",
        "quota",
        "permission",
        "configuration",
        "workspace",
        "validation",
        "fatal",
        "unknown",
    ]
    recoverable: bool
    retryable: bool
    action_kind: Literal["retry", "user_action", "repair", "operator_action", "inspect"]
    recovery_action: Literal[
        "retry", "repair", "recharge", "refresh_session", "workspace", "diagnostics"
    ]
    code: str | None = None
    message: str
    source_event_type: str
    tool: str | None = None
    suggested_action: str


class DiagnosticsVerification(BaseModel):
    """Latest machine-readable task.verify result, if any."""

    status: Literal["passed", "failed"]
    reason: str | None = None
    pass_count: int | None = None
    fail_count: int | None = None
    source_event_type: str


class DiagnosticsReflectionCritic(BaseModel):
    """Compact final-answer critic output, if reflection ran."""

    coverage: int | None = None
    clarity: int | None = None
    grounding: int | None = None
    notes: list[str] = Field(default_factory=list)
    raw: str | None = None


class DiagnosticsReflection(BaseModel):
    """Safe reflection summary from the latest checkpoint.

    This deliberately excludes checkpoint messages and raw tool output.
    """

    ai_messages: int | None = None
    tool_results: int | None = None
    final_answer_chars: int | None = None
    critic: DiagnosticsReflectionCritic | None = None


class DiagnosticsToolReceipt(BaseModel):
    """Safe execution identity/status without raw tool arguments or output."""

    operation_id: str
    tool_call_id: str
    tool_name: str
    tool_version: str
    arguments_hash: str
    risk: str
    status: Literal[
        "prepared",
        "running",
        "paused",
        "completed",
        "failed",
        "outcome_unknown",
        "rejected",
        "canceled",
    ]
    attempt_count: int
    result_hash: str | None = None
    error_type: str | None = None
    created_at: str
    started_at: str | None = None
    completed_at: str | None = None
    updated_at: str


class DiagnosticsWaitCandidate(BaseModel):
    id: str
    kind: Literal["tool_review", "question", "plan", "tool_reconciliation"]
    status: Literal["pending", "resolved"]
    created_at: str
    resolved_at: str | None = None


class DiagnosticsHandoff(BaseModel):
    """Compact handoff summary for long-running or resumed work.

    This is derived from redacted run metadata and event types. It deliberately
    does not include full checkpoint messages, artifact bodies, or raw tool
    output.
    """

    status: str
    headline: str
    next_actions: list[str] = Field(default_factory=list)
    blockers: list[str] = Field(default_factory=list)
    recent_event_types: list[str] = Field(default_factory=list)
    ledger_state: Literal["not_required", "missing", "fresh", "stale"] = "not_required"
    ledger_message: str | None = None
    failure: DiagnosticsFailure | None = None
    verification: DiagnosticsVerification | None = None


class FeatureLedger(BaseModel):
    """Latest durable progress ledger entry for the run."""

    summary: str
    status: str
    acceptance_criteria: list[str] = Field(default_factory=list)
    decisions: list[str] = Field(default_factory=list)
    files_touched: list[str] = Field(default_factory=list)
    validation_commands: list[str] = Field(default_factory=list)
    unresolved_risks: list[str] = Field(default_factory=list)
    next_actions: list[str] = Field(default_factory=list)
    artifact_id: str | None = None
    created_at: str | None = None


class LocalRunDiagnostics(BaseModel):
    schema_version: Literal[1] = 1
    exported_at: str
    local_host_version: str | None = None
    run: LocalRun
    events: list[DiagnosticsEvent]
    permissions: list[DiagnosticsPermission]
    tool_receipts: list[DiagnosticsToolReceipt] = Field(default_factory=list)
    wait_candidates: list[DiagnosticsWaitCandidate] = Field(default_factory=list)
    artifacts: list[DiagnosticsArtifact]
    latest_checkpoint: LatestCheckpoint | None = None
    handoff: DiagnosticsHandoff
    feature_ledger: FeatureLedger | None = None
    reflection: DiagnosticsReflection | None = None


# ---------------------------------------------------------------------------
# Simple ack envelopes — used by handlers that don't have a richer return.
# ---------------------------------------------------------------------------


class CancelRunResponse(BaseModel):
    canceled: bool


class CancelRunCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["run.cancel"]
    command_id: str = Field(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    )
    run_id: str = Field(min_length=1, max_length=128)


class CancelRunCommandReceipt(BaseModel):
    type: Literal["run.cancel"]
    command_id: str
    run_id: str
    canceled: bool


class AnswerQuestionCommand(AnswerQuestionRequest):
    model_config = ConfigDict(extra="forbid")

    type: Literal["question.answer"]
    command_id: str = Field(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    )
    question_id: str = Field(min_length=1, max_length=128)


class AnswerQuestionCommandReceipt(BaseModel):
    type: Literal["question.answer"]
    command_id: str
    question_id: str
    run_id: str
    answered: Literal[True] = True
    resumed: bool


class ResolvePermissionCommand(ResolvePermissionRequest):
    model_config = ConfigDict(extra="forbid")

    type: Literal["permission.resolve"]
    command_id: str = Field(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    )
    permission_id: str = Field(min_length=1, max_length=128)


class ResolvePermissionCommandReceipt(BaseModel):
    type: Literal["permission.resolve"]
    command_id: str
    permission_id: str
    run_id: str
    resolved: Literal[True] = True
    decision: PermissionDecision
    scope: PermissionScope
    resumed: bool


class PlanResolveCommand(ResolvePlanApprovalRequest):
    model_config = ConfigDict(extra="forbid")

    type: Literal["plan.resolve"]
    command_id: str = Field(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    )
    approval_id: str = Field(min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_instructions(self) -> PlanResolveCommand:
        instructions = (self.instructions or "").strip()
        if self.decision == "modify" and not instructions:
            raise ValueError("instructions are required when decision is modify")
        if self.decision != "modify" and instructions:
            raise ValueError("instructions are only valid when decision is modify")
        return self


class PlanResolveCommandReceipt(BaseModel):
    type: Literal["plan.resolve"]
    command_id: str
    approval_id: str
    run_id: str
    resolved: Literal[True] = True
    decision: PlanApprovalDecision
    instructions: str | None = None
    resumed: bool


class ToolReconcileCommand(ReconcileToolRequest):
    model_config = ConfigDict(extra="forbid")

    type: Literal["tool.reconcile"]
    command_id: str = Field(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    )
    operation_id: str = Field(min_length=1, max_length=128)


class ToolReconcileCommandReceipt(BaseModel):
    type: Literal["tool.reconcile"]
    command_id: str
    operation_id: str
    run_id: str
    resolved: Literal[True] = True
    decision: Literal["confirmed_completed", "retry_not_executed", "abort"]
    resumed: bool


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
# MCP servers
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


class McpServerWriteRequest(BaseModel):
    """Create/update one SheJane-managed MCP server.

    This writes only `~/.shejane/mcp-servers.json`; discovered Claude
    Desktop / Cursor / Codex entries remain read-only.
    """

    name: str | None = None
    transport: str = "stdio"
    command: str | None = None
    args: list[str] = []
    url: str | None = None
    env: dict[str, str] = {}
    cwd: str | None = None


class McpServerWriteResponse(BaseModel):
    server: McpServerInfo


class McpServerDeleteResponse(BaseModel):
    deleted: bool = True
    name: str


# ---------------------------------------------------------------------------
# Skills
# ---------------------------------------------------------------------------


class SkillWriteRequest(BaseModel):
    """Create/update one SheJane-managed skill under `~/.shejane/skills`."""

    name: str | None = None
    description: str = ""
    content: str | None = None


class SkillFile(BaseModel):
    name: str
    description: str = ""
    path: str
    root_path: str
    content: str


class SkillWriteResponse(BaseModel):
    skill: SkillFile


class SkillDeleteResponse(BaseModel):
    deleted: bool = True
    name: str
