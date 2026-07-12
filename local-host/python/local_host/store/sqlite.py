"""SQLite-backed local store. Async via aiosqlite.

Schema mirrors the Node daemon's tables conceptually but is intentionally
slimmer: anything LangGraph owns (message history, graph checkpoints) lives
in `agent.db` via AsyncSqliteSaver, not here.

Tables in this file:
- `local_workspaces`  — authorized filesystem roots
- `local_commands`    — immutable client commands and their accepted run
- `local_run_jobs`    — durable pending/leased execution attempts
- `local_runs`        — run metadata (status, goal, parent, settings, metadata)
- `local_events`      — append-only event log (one row per emit)
- `local_permissions` — pending / resolved permission requests
- `local_questions`   — pending / answered user questions
- `local_artifacts`   — tool-produced artifacts (file content, snapshots)
- `local_steering`    — user instructions queued into an active run
- `local_plan_approvals` — pending / resolved plan-mode approvals
- `local_scheduled_runs` — local-only delayed run requests
- `local_model_providers` — non-secret BYOK provider configuration
- `local_model_calls` — durable model-call reservations and usage receipts
- `local_assistant_drafts` — latest complete top-level assistant model round
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import aiosqlite

from ..auth import LOCAL_OWNER_PRINCIPAL_ID

MAX_ARTIFACT_BYTES = 32 * 1024 * 1024
MAX_RUN_ARTIFACT_BYTES = 128 * 1024 * 1024
MAX_PRINCIPAL_ARTIFACT_BYTES = 512 * 1024 * 1024
MAX_TOTAL_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
MAX_SETTLEMENT_ARTIFACT_REFS = 256


def _principal_thread_id(principal_id: str, requested_id: str) -> str:
    """Scope client-chosen IDs for future remote principals without moving local IDs."""
    if principal_id == LOCAL_OWNER_PRINCIPAL_ID and not requested_id.startswith("pt_"):
        return requested_id
    principal_prefix = hashlib.sha256(principal_id.encode("utf-8")).hexdigest()[:16]
    prefix = f"pt_{principal_prefix}_"
    if requested_id.startswith(prefix):
        return requested_id
    logical_hash = hashlib.sha256(requested_id.encode("utf-8")).hexdigest()
    return f"{prefix}{logical_hash}"


def _principal_item_id(principal_id: str, requested_id: str) -> str:
    """Keep local item IDs stable and isolate remote client-chosen physical keys."""
    if principal_id == LOCAL_OWNER_PRINCIPAL_ID and not requested_id.startswith("pi_"):
        return requested_id
    principal_prefix = hashlib.sha256(principal_id.encode("utf-8")).hexdigest()[:16]
    prefix = f"pi_{principal_prefix}_"
    if requested_id.startswith(prefix):
        return requested_id
    logical_hash = hashlib.sha256(requested_id.encode("utf-8")).hexdigest()
    return f"{prefix}{logical_hash}"


SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS local_workspaces (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    path TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    UNIQUE (principal_id, path)
);

CREATE TABLE IF NOT EXISTS local_model_providers (
    principal_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('openai_compatible')),
    base_url TEXT NOT NULL,
    requires_api_key INTEGER NOT NULL DEFAULT 1,
    credential_ref TEXT NOT NULL,
    models_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (principal_id, id)
);

CREATE TABLE IF NOT EXISTS local_runs (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL DEFAULT 'local:owner',
    graph_thread_id TEXT NOT NULL,
    graph_checkpoint_id TEXT,
    graph_definition_id TEXT,
    graph_input_kind TEXT NOT NULL DEFAULT 'new',
    thread_id TEXT,
    assistant_item_id TEXT,
    user_input TEXT,
    goal TEXT NOT NULL,
    workspace_path TEXT,
    status TEXT NOT NULL,
    history_json TEXT NOT NULL DEFAULT '[]',
    parent_run_id TEXT,
    settings_json TEXT NOT NULL DEFAULT '{}',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    -- Resolved tier (fast|deep) once known, else the requested mode. Persisted
    -- so a HITL resume AFTER a daemon restart keeps the user's chosen tier
    -- instead of silently downgrading to fast. Added late, hence the additive
    -- migration in _ensure_columns() for DBs created before this column.
    mode TEXT NOT NULL DEFAULT 'fast',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS local_threads (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_local_threads_owner_updated
    ON local_threads(principal_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS local_thread_items (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    run_id TEXT,
    client_id TEXT,
    item_type TEXT NOT NULL,
    status TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    position INTEGER NOT NULL,
    event_high_watermark INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    superseded_at TEXT,
    superseded_by_run_id TEXT,
    FOREIGN KEY (thread_id) REFERENCES local_threads(id),
    FOREIGN KEY (run_id) REFERENCES local_runs(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_local_thread_items_client
    ON local_thread_items(thread_id, client_id) WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_local_thread_items_run_type
    ON local_thread_items(run_id, item_type) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_local_thread_items_order
    ON local_thread_items(thread_id, created_at, id);

CREATE TABLE IF NOT EXISTS local_thread_changes (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    principal_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    thread_version INTEGER NOT NULL,
    change_type TEXT NOT NULL,
    run_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES local_threads(id),
    FOREIGN KEY (run_id) REFERENCES local_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_local_thread_changes_owner_cursor
    ON local_thread_changes(principal_id, cursor);

CREATE TABLE IF NOT EXISTS local_commands (
    principal_id TEXT NOT NULL,
    id TEXT NOT NULL,
    command_type TEXT NOT NULL,
    client_message_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    response_json TEXT NOT NULL DEFAULT '{}',
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (principal_id, id),
    FOREIGN KEY (run_id) REFERENCES local_runs(id)
);

CREATE TABLE IF NOT EXISTS local_run_jobs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('start', 'resume')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'completed', 'dead', 'canceled')),
    input_json TEXT NOT NULL,
    resume_json TEXT,
    lease_owner TEXT,
    lease_generation INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    cancel_requested_at TEXT,
    quarantined_at TEXT,
    quarantine_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    FOREIGN KEY (run_id) REFERENCES local_runs(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_local_run_jobs_one_active
    ON local_run_jobs(run_id) WHERE status IN ('pending', 'leased');
CREATE INDEX IF NOT EXISTS idx_local_run_jobs_pending
    ON local_run_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS local_model_calls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    execution_attempt_id TEXT NOT NULL,
    call_index INTEGER NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN (
            'reserved', 'streaming', 'completed', 'completed_unmetered',
            'failed', 'outcome_unknown'
        )
    ),
    output_started INTEGER NOT NULL DEFAULT 0,
    provider_request_id TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    credits_cost INTEGER,
    error_code TEXT,
    created_at TEXT NOT NULL,
    first_output_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (run_id) REFERENCES local_runs(id),
    UNIQUE (run_id, execution_attempt_id, call_index)
);

CREATE TABLE IF NOT EXISTS local_tool_receipts (
    operation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    execution_attempt_id TEXT NOT NULL,
    execution_namespace TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool_version TEXT NOT NULL,
    arguments_hash TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    risk TEXT NOT NULL,
    status TEXT NOT NULL, -- prepared | running | paused | completed | failed | outcome_unknown | rejected | canceled
    attempt_count INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    result_hash TEXT,
    error_type TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES local_runs(id),
    UNIQUE (run_id, execution_namespace, tool_call_id)
);
CREATE INDEX IF NOT EXISTS idx_local_tool_receipts_run_status
    ON local_tool_receipts(run_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_local_model_calls_run
    ON local_model_calls(run_id, call_index);

CREATE TABLE IF NOT EXISTS local_assistant_drafts (
    run_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    message_key TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES local_runs(id)
);

CREATE TABLE IF NOT EXISTS local_scheduled_runs (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    goal TEXT NOT NULL,
    workspace_path TEXT,
    model TEXT NOT NULL DEFAULT 'auto',
    history_json TEXT NOT NULL DEFAULT '[]',
    settings_json TEXT NOT NULL DEFAULT '{}',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    run_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    run_id TEXT,
    result_text TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    notified_at TEXT,
    FOREIGN KEY (run_id) REFERENCES local_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_local_scheduled_runs_due
    ON local_scheduled_runs(status, run_at);
CREATE INDEX IF NOT EXISTS idx_local_scheduled_runs_notify
    ON local_scheduled_runs(status, notified_at, updated_at);

CREATE TABLE IF NOT EXISTS local_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES local_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_local_events_run_seq ON local_events(run_id, seq);

CREATE TABLE IF NOT EXISTS local_permissions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    tool_call_id TEXT,
    wait_cycle_id TEXT,
    interrupt_id TEXT,
    action_index INTEGER NOT NULL DEFAULT 0,
    operation_id TEXT,
    tool_name TEXT NOT NULL,
    tool_version TEXT NOT NULL DEFAULT '',
    arguments_hash TEXT,
    arguments_json TEXT NOT NULL,
    risk TEXT,
    decision_json TEXT,
    status TEXT NOT NULL,                -- pending | approved | denied | canceled
    scope TEXT NOT NULL DEFAULT 'once',  -- once | run
    grant_max_uses INTEGER NOT NULL DEFAULT 0,
    grant_use_count INTEGER NOT NULL DEFAULT 0,
    grant_expires_at TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY (run_id) REFERENCES local_runs(id)
);
CREATE TABLE IF NOT EXISTS local_permission_grant_uses (
    permission_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, operation_id),
    FOREIGN KEY (permission_id) REFERENCES local_permissions(id),
    FOREIGN KEY (run_id) REFERENCES local_runs(id)
);

CREATE TABLE IF NOT EXISTS local_wait_candidates (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,                  -- tool_review | question | plan | tool_reconciliation
    wait_cycle_id TEXT NOT NULL,
    interrupt_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,                -- pending | resolved
    payload_json TEXT NOT NULL,
    decision_json TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY (run_id) REFERENCES local_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_local_wait_candidates_run_status
    ON local_wait_candidates(run_id, status, created_at);
CREATE TABLE IF NOT EXISTS local_questions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    tool_call_id TEXT,
    wait_cycle_id TEXT,
    interrupt_id TEXT,
    questions_json TEXT NOT NULL,
    status TEXT NOT NULL,                -- pending | answered | canceled
    answers_json TEXT,
    created_at TEXT NOT NULL,
    answered_at TEXT,
    FOREIGN KEY (run_id) REFERENCES local_runs(id)
);
CREATE TABLE IF NOT EXISTS local_artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    tool_call_id TEXT,
    tool_name TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES local_runs(id)
);

CREATE TABLE IF NOT EXISTS local_steering (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | injected
    created_at TEXT NOT NULL,
    injected_at TEXT,
    FOREIGN KEY (run_id) REFERENCES local_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_local_steering_run_status
    ON local_steering(run_id, status, created_at);

CREATE TABLE IF NOT EXISTS local_plan_approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    wait_cycle_id TEXT,
    interrupt_id TEXT,
    todos_json TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | modified | rejected | canceled
    instructions TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY (run_id) REFERENCES local_runs(id),
    UNIQUE (run_id, tool_call_id)
);
CREATE INDEX IF NOT EXISTS idx_local_plan_approvals_run_status
    ON local_plan_approvals(run_id, status, created_at);

"""


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


class RunResultConflictError(RuntimeError):
    """A persisted run result cannot be replaced by a different result."""


class CommandConflictError(RuntimeError):
    """A command id was reused with different immutable content."""


class WorkspaceAdmissionError(RuntimeError):
    """A command references a workspace the principal cannot use."""


class ParentRunAdmissionError(RuntimeError):
    """A command references a parent Run outside the principal scope."""


class ThreadAdmissionError(RuntimeError):
    """A command references a product thread outside the principal scope."""


class RunAdmissionError(RuntimeError):
    """A deterministic Runtime prerequisite is not satisfied."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class LeaseFenceError(RuntimeError):
    """An execution attempted to write after losing its job lease."""


class GraphHeadConflictError(RuntimeError):
    """A stale execution attempted to move a product Run's graph head."""


class GraphDefinitionMismatchError(RuntimeError):
    """A checkpoint was opened with an incompatible Agent definition."""


class ModelCallBudgetExceeded(RuntimeError):
    """A run tried to reserve more model calls than its frozen budget."""

    code = "model_call_budget_exhausted"
    retryable = False


class ToolReceiptConflictError(RuntimeError):
    """A tool call id was reused with different arguments or identity."""

    code = "tool_receipt_conflict"
    retryable = False


class ToolOutcomeUnknownError(RuntimeError):
    """A prior side-effecting tool attempt may have executed."""

    code = "tool_outcome_unknown"
    retryable = False


class ToolReceiptStateError(RuntimeError):
    """A tool operation cannot transition from its durable state."""

    code = "tool_receipt_state_invalid"
    retryable = False


class PermissionDecisionConflictError(RuntimeError):
    """A resolved permission received a different decision."""

    code = "permission_decision_conflict"
    retryable = False


class WaitDecisionConflictError(RuntimeError):
    """A durable wait candidate received a conflicting second answer."""

    code = "wait_decision_conflict"
    retryable = False


class ArtifactQuotaError(RuntimeError):
    """An artifact write would exceed a local persistence safety budget."""

    code = "artifact_quota_exceeded"
    retryable = False


@dataclass(frozen=True, slots=True)
class ExecutionLease:
    job_id: str
    run_id: str
    lease_owner: str
    lease_generation: int


_CURRENT_EXECUTION_LEASE: ContextVar[ExecutionLease | None] = ContextVar(
    "shejane_execution_lease", default=None
)


_RUN_RESULT_EVENTS = {
    "completed": "run.completed",
    "failed": "run.failed",
    "canceled": "run.canceled",
    "waiting_permission": "run.waiting",
    "waiting_input": "run.waiting",
}
_TERMINAL_RUN_STATUSES = {"completed", "failed", "canceled"}


def _encode_payload(payload: dict[str, Any]) -> str:
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


def _json_payload(raw: Any) -> dict[str, Any]:
    try:
        value = json.loads(str(raw or "{}"))
    except (json.JSONDecodeError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def _decode_plan_approval_record(record: dict[str, Any]) -> dict[str, Any]:
    try:
        todos = json.loads(str(record.get("todos_json") or "[]"))
    except json.JSONDecodeError:
        todos = []
    return {
        **record,
        "todos": todos if isinstance(todos, list) else [],
    }


class LocalStore:
    """Thin async wrapper over aiosqlite. Connection-per-store."""

    def __init__(self, conn: aiosqlite.Connection, db_path: Path) -> None:
        self._conn = conn
        self._db_path = db_path

    @classmethod
    async def open(cls, db_path: Path) -> LocalStore:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = await aiosqlite.connect(str(db_path))
        conn.row_factory = aiosqlite.Row
        await conn.executescript(SCHEMA)
        await cls._ensure_columns(conn)
        await conn.commit()
        return cls(conn, db_path)

    @staticmethod
    async def _ensure_columns(conn: aiosqlite.Connection) -> None:
        """Additive migrations for DBs created before a column existed.
        `CREATE TABLE IF NOT EXISTS` never alters an existing table, so a new
        column has to be added explicitly. SQLite ADD COLUMN is cheap + safe."""
        await LocalStore._ensure_principal_scoped_workspaces(conn)
        cursor = await conn.execute("PRAGMA table_info(local_runs)")
        columns = {row[1] for row in await cursor.fetchall()}
        if "mode" not in columns:
            await conn.execute(
                "ALTER TABLE local_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'fast'"
            )
        if "metadata_json" not in columns:
            await conn.execute(
                "ALTER TABLE local_runs ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'"
            )
        if "principal_id" not in columns:
            await conn.execute(
                "ALTER TABLE local_runs ADD COLUMN principal_id TEXT NOT NULL DEFAULT 'local:owner'"
            )
        if "graph_thread_id" not in columns:
            await conn.execute("ALTER TABLE local_runs ADD COLUMN graph_thread_id TEXT")
            await conn.execute(
                "UPDATE local_runs SET graph_thread_id = id WHERE graph_thread_id IS NULL"
            )
        if "graph_checkpoint_id" not in columns:
            await conn.execute("ALTER TABLE local_runs ADD COLUMN graph_checkpoint_id TEXT")
        if "graph_definition_id" not in columns:
            await conn.execute("ALTER TABLE local_runs ADD COLUMN graph_definition_id TEXT")
        if "graph_input_kind" not in columns:
            await conn.execute(
                "ALTER TABLE local_runs ADD COLUMN graph_input_kind TEXT NOT NULL DEFAULT 'new'"
            )
        if "thread_id" not in columns:
            await conn.execute("ALTER TABLE local_runs ADD COLUMN thread_id TEXT")
        if "assistant_item_id" not in columns:
            await conn.execute("ALTER TABLE local_runs ADD COLUMN assistant_item_id TEXT")
        if "user_input" not in columns:
            await conn.execute("ALTER TABLE local_runs ADD COLUMN user_input TEXT")
            await conn.execute("UPDATE local_runs SET user_input = goal WHERE user_input IS NULL")
        cursor = await conn.execute("PRAGMA table_info(local_threads)")
        thread_columns = {row[1] for row in await cursor.fetchall()}
        if "metadata_json" not in thread_columns:
            await conn.execute(
                "ALTER TABLE local_threads ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'"
            )
        if "deleted_at" not in thread_columns:
            await conn.execute("ALTER TABLE local_threads ADD COLUMN deleted_at TEXT")
        cursor = await conn.execute("PRAGMA table_info(local_thread_items)")
        thread_item_columns = {row[1] for row in await cursor.fetchall()}
        if "position" not in thread_item_columns:
            await conn.execute(
                "ALTER TABLE local_thread_items ADD COLUMN position INTEGER NOT NULL DEFAULT 0"
            )
        if "superseded_at" not in thread_item_columns:
            await conn.execute("ALTER TABLE local_thread_items ADD COLUMN superseded_at TEXT")
        if "superseded_by_run_id" not in thread_item_columns:
            await conn.execute(
                "ALTER TABLE local_thread_items ADD COLUMN superseded_by_run_id TEXT"
            )
        if "event_high_watermark" not in thread_item_columns:
            await conn.execute(
                "ALTER TABLE local_thread_items "
                "ADD COLUMN event_high_watermark INTEGER NOT NULL DEFAULT 0"
            )
            await conn.execute(
                "UPDATE local_thread_items SET event_high_watermark = COALESCE(("
                "SELECT MAX(e.seq) FROM local_events e "
                "WHERE e.run_id = local_thread_items.run_id "
                "AND e.event_type IN ('run.waiting', 'run.completed', 'run.failed', "
                "'run.canceled', 'run.cleanup_required')"
                "), 0) WHERE item_type = 'assistant_message' AND run_id IS NOT NULL"
            )
        await conn.execute("DROP INDEX IF EXISTS idx_local_thread_items_order")
        await conn.execute(
            "CREATE INDEX idx_local_thread_items_order "
            "ON local_thread_items(thread_id, position, id)"
        )
        cursor = await conn.execute("PRAGMA table_info(local_scheduled_runs)")
        schedule_columns = {row[1] for row in await cursor.fetchall()}
        if "principal_id" not in schedule_columns:
            await conn.execute(
                "ALTER TABLE local_scheduled_runs ADD COLUMN principal_id "
                "TEXT NOT NULL DEFAULT 'local:owner'"
            )
        await LocalStore._ensure_principal_scoped_commands(conn)
        await LocalStore._ensure_generic_commands(conn)
        await LocalStore._ensure_run_job_principals(conn)
        cursor = await conn.execute("PRAGMA table_info(local_run_jobs)")
        job_columns = {row[1] for row in await cursor.fetchall()}
        if "quarantined_at" not in job_columns:
            await conn.execute("ALTER TABLE local_run_jobs ADD COLUMN quarantined_at TEXT")
        if "quarantine_reason" not in job_columns:
            await conn.execute("ALTER TABLE local_run_jobs ADD COLUMN quarantine_reason TEXT")
        await LocalStore._ensure_permission_identity_columns(conn)
        await LocalStore._ensure_wait_identity_columns(conn)
        await LocalStore._ensure_tool_receipt_namespace(conn)
        await LocalStore._ensure_tool_receipt_version_column(conn)
        await LocalStore._ensure_wait_candidates(conn)
        # Lark integration was removed; delete its local-only cache and todo data.
        for table in (
            "local_todo_items",
            "local_lark_messages",
            "local_lark_sources",
            "local_lark_connections",
        ):
            await conn.execute(f"DROP TABLE IF EXISTS {table}")
        await LocalStore._ensure_event_sequence_index(conn)

    @staticmethod
    async def _ensure_permission_identity_columns(conn: aiosqlite.Connection) -> None:
        cursor = await conn.execute("PRAGMA table_info(local_permissions)")
        columns = {row[1] for row in await cursor.fetchall()}
        for column, definition in (
            ("operation_id", "TEXT"),
            ("tool_version", "TEXT NOT NULL DEFAULT ''"),
            ("arguments_hash", "TEXT"),
            ("risk", "TEXT"),
            ("decision_json", "TEXT"),
            ("grant_max_uses", "INTEGER NOT NULL DEFAULT 0"),
            ("grant_use_count", "INTEGER NOT NULL DEFAULT 0"),
            ("grant_expires_at", "TEXT"),
            ("wait_cycle_id", "TEXT"),
            ("interrupt_id", "TEXT"),
            ("action_index", "INTEGER NOT NULL DEFAULT 0"),
        ):
            if column not in columns:
                await conn.execute(
                    f"ALTER TABLE local_permissions ADD COLUMN {column} {definition}"
                )
        await conn.execute(
            "UPDATE local_permissions SET wait_cycle_id = COALESCE(wait_cycle_id, id), "
            "interrupt_id = COALESCE(interrupt_id, id)"
        )
        await conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_local_permissions_run_operation "
            "ON local_permissions(run_id, operation_id) "
            "WHERE operation_id IS NOT NULL"
        )
        await conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_local_permissions_interrupt_action "
            "ON local_permissions(run_id, interrupt_id, action_index) "
            "WHERE interrupt_id IS NOT NULL"
        )

    @staticmethod
    async def _ensure_wait_identity_columns(conn: aiosqlite.Connection) -> None:
        cursor = await conn.execute("PRAGMA table_info(local_wait_candidates)")
        wait_columns = {row[1] for row in await cursor.fetchall()}
        for column, definition in (
            ("wait_cycle_id", "TEXT"),
            ("interrupt_id", "TEXT"),
            ("position", "INTEGER NOT NULL DEFAULT 0"),
        ):
            if column not in wait_columns:
                await conn.execute(
                    f"ALTER TABLE local_wait_candidates ADD COLUMN {column} {definition}"
                )
        await conn.execute(
            "UPDATE local_wait_candidates SET wait_cycle_id = COALESCE(wait_cycle_id, id), "
            "interrupt_id = COALESCE(interrupt_id, id)"
        )
        await conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_local_wait_candidates_interrupt_position "
            "ON local_wait_candidates(run_id, interrupt_id, position)"
        )
        cursor = await conn.execute("PRAGMA table_info(local_questions)")
        question_columns = {row[1] for row in await cursor.fetchall()}
        for column in ("wait_cycle_id", "interrupt_id"):
            if column not in question_columns:
                await conn.execute(f"ALTER TABLE local_questions ADD COLUMN {column} TEXT")
        await conn.execute(
            "UPDATE local_questions SET wait_cycle_id = COALESCE(wait_cycle_id, id), "
            "interrupt_id = COALESCE(interrupt_id, id)"
        )
        await conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_local_questions_interrupt "
            "ON local_questions(run_id, interrupt_id) WHERE interrupt_id IS NOT NULL"
        )
        cursor = await conn.execute("PRAGMA table_info(local_plan_approvals)")
        plan_columns = {row[1] for row in await cursor.fetchall()}
        for column in ("wait_cycle_id", "interrupt_id"):
            if column not in plan_columns:
                await conn.execute(f"ALTER TABLE local_plan_approvals ADD COLUMN {column} TEXT")
        await LocalStore._backfill_plan_approval_wait_identity(conn)

    @staticmethod
    async def _backfill_plan_approval_wait_identity(conn: aiosqlite.Connection) -> None:
        plans = await (
            await conn.execute(
                "SELECT id, run_id, tool_call_id FROM local_plan_approvals "
                "WHERE wait_cycle_id IS NULL OR interrupt_id IS NULL"
            )
        ).fetchall()
        for plan in plans:
            approval_events = await (
                await conn.execute(
                    "SELECT seq, payload_json FROM local_events WHERE run_id = ? "
                    "AND event_type = 'plan.approval_required' ORDER BY seq",
                    (plan[1],),
                )
            ).fetchall()
            approval_seq = next(
                (
                    int(event[0])
                    for event in approval_events
                    if _json_payload(event[1]).get("request_id") == plan[0]
                ),
                None,
            )
            if approval_seq is None:
                continue
            waiting_events = await (
                await conn.execute(
                    "SELECT payload_json FROM local_events WHERE run_id = ? AND seq > ? "
                    "AND event_type = 'run.waiting' ORDER BY seq",
                    (plan[1], approval_seq),
                )
            ).fetchall()
            identity: tuple[str, str] | None = None
            for event in waiting_events:
                payload = _json_payload(event[0])
                wait_cycle_id = str(payload.get("wait_cycle_id") or "")
                interrupts = payload.get("interrupts")
                if not wait_cycle_id or not isinstance(interrupts, list):
                    continue
                candidates = [
                    interrupt
                    for interrupt in interrupts
                    if isinstance(interrupt, dict)
                    and isinstance(interrupt.get("value"), dict)
                    and interrupt["value"].get("kind") == "plan_approval"
                ]
                matching = [
                    interrupt
                    for interrupt in candidates
                    if interrupt["value"].get("tool_call_id") == plan[2]
                    or interrupt.get("id") == plan[2]
                ]
                candidate = matching[0] if len(matching) == 1 else None
                interrupt_id = str(candidate.get("id") or "") if candidate else ""
                if interrupt_id:
                    identity = (wait_cycle_id, interrupt_id)
                    break
            if identity is not None:
                await conn.execute(
                    "UPDATE local_plan_approvals SET wait_cycle_id = ?, interrupt_id = ? "
                    "WHERE id = ?",
                    (*identity, plan[0]),
                )

    @staticmethod
    async def _ensure_tool_receipt_version_column(conn: aiosqlite.Connection) -> None:
        cursor = await conn.execute("PRAGMA table_info(local_tool_receipts)")
        columns = {row[1] for row in await cursor.fetchall()}
        if "tool_version" not in columns:
            await conn.execute(
                "ALTER TABLE local_tool_receipts ADD COLUMN tool_version TEXT NOT NULL DEFAULT ''"
            )

    @staticmethod
    async def _ensure_tool_receipt_namespace(conn: aiosqlite.Connection) -> None:
        cursor = await conn.execute("PRAGMA table_info(local_tool_receipts)")
        columns = {row[1] for row in await cursor.fetchall()}
        if "execution_namespace" in columns:
            return
        tool_version_expr = "tool_version" if "tool_version" in columns else "''"
        await conn.execute("SAVEPOINT tool_receipt_namespace")
        try:
            await conn.execute(
                "CREATE TABLE local_tool_receipts_v2 ("
                "operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, "
                "execution_attempt_id TEXT NOT NULL, execution_namespace TEXT NOT NULL, "
                "tool_call_id TEXT NOT NULL, tool_name TEXT NOT NULL, "
                "tool_version TEXT NOT NULL DEFAULT '', arguments_hash TEXT NOT NULL, "
                "arguments_json TEXT NOT NULL, risk TEXT NOT NULL, status TEXT NOT NULL, "
                "attempt_count INTEGER NOT NULL DEFAULT 0, result_json TEXT, "
                "result_hash TEXT, error_type TEXT, created_at TEXT NOT NULL, "
                "started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL, "
                "FOREIGN KEY (run_id) REFERENCES local_runs(id), "
                "UNIQUE (run_id, execution_namespace, tool_call_id))"
            )
            await conn.execute(
                "INSERT INTO local_tool_receipts_v2 "
                "(operation_id, run_id, execution_attempt_id, execution_namespace, "
                "tool_call_id, tool_name, tool_version, arguments_hash, arguments_json, "
                "risk, status, attempt_count, result_json, result_hash, error_type, "
                "created_at, started_at, completed_at, updated_at) "
                "SELECT operation_id, run_id, execution_attempt_id, 'main', "
                f"tool_call_id, tool_name, {tool_version_expr}, arguments_hash, arguments_json, risk, status, "
                "attempt_count, result_json, result_hash, error_type, created_at, "
                "started_at, completed_at, updated_at FROM local_tool_receipts"
            )
            await conn.execute("DROP TABLE local_tool_receipts")
            await conn.execute("ALTER TABLE local_tool_receipts_v2 RENAME TO local_tool_receipts")
            await conn.execute(
                "CREATE INDEX idx_local_tool_receipts_run_status "
                "ON local_tool_receipts(run_id, status, created_at)"
            )
            await conn.execute("RELEASE tool_receipt_namespace")
        except BaseException:
            await conn.execute("ROLLBACK TO tool_receipt_namespace")
            await conn.execute("RELEASE tool_receipt_namespace")
            raise

    @staticmethod
    async def _ensure_wait_candidates(conn: aiosqlite.Connection) -> None:
        await conn.execute(
            "INSERT OR IGNORE INTO local_wait_candidates "
            "(id, run_id, kind, wait_cycle_id, interrupt_id, position, status, "
            "payload_json, decision_json, created_at, resolved_at) "
            "SELECT id, run_id, 'tool_review', COALESCE(wait_cycle_id, id), "
            "COALESCE(interrupt_id, id), action_index, "
            "CASE WHEN status = 'pending' THEN 'pending' ELSE 'resolved' END, "
            "arguments_json, decision_json, created_at, resolved_at FROM local_permissions"
        )
        await conn.execute(
            "INSERT OR IGNORE INTO local_wait_candidates "
            "(id, run_id, kind, wait_cycle_id, interrupt_id, position, status, "
            "payload_json, decision_json, created_at, resolved_at) "
            "SELECT id, run_id, 'question', COALESCE(wait_cycle_id, id), "
            "COALESCE(interrupt_id, id), 0, "
            "CASE WHEN status = 'pending' THEN 'pending' ELSE 'resolved' END, "
            "questions_json, answers_json, created_at, answered_at FROM local_questions"
        )
        await conn.execute(
            "INSERT OR IGNORE INTO local_wait_candidates "
            "(id, run_id, kind, wait_cycle_id, interrupt_id, position, status, "
            "payload_json, decision_json, created_at, resolved_at) "
            "SELECT id, run_id, 'plan', wait_cycle_id, interrupt_id, 0, 'pending', "
            "todos_json, NULL, created_at, NULL FROM local_plan_approvals "
            "WHERE status = 'pending' AND wait_cycle_id IS NOT NULL "
            "AND interrupt_id IS NOT NULL"
        )
        resolved_plans = await (
            await conn.execute(
                "SELECT id, run_id, wait_cycle_id, interrupt_id, todos_json, status, "
                "instructions, created_at, resolved_at FROM local_plan_approvals "
                "WHERE status IN ('approved', 'modified', 'rejected') "
                "AND wait_cycle_id IS NOT NULL AND interrupt_id IS NOT NULL"
            )
        ).fetchall()
        for plan in resolved_plans:
            decision = {
                "approved": "approve",
                "modified": "modify",
                "rejected": "reject",
            }[str(plan[5])]
            await conn.execute(
                "INSERT OR IGNORE INTO local_wait_candidates "
                "(id, run_id, kind, wait_cycle_id, interrupt_id, position, status, "
                "payload_json, decision_json, created_at, resolved_at) "
                "VALUES (?, ?, 'plan', ?, ?, 0, 'resolved', ?, ?, ?, ?)",
                (
                    plan[0],
                    plan[1],
                    plan[2],
                    plan[3],
                    plan[4],
                    _encode_payload(
                        {
                            "approval_id": plan[0],
                            "decision": decision,
                            "instructions": plan[6],
                        }
                    ),
                    plan[7],
                    plan[8],
                ),
            )

    @staticmethod
    async def _ensure_principal_scoped_workspaces(conn: aiosqlite.Connection) -> None:
        cursor = await conn.execute("PRAGMA table_info(local_workspaces)")
        columns = {row[1] for row in await cursor.fetchall()}
        if "principal_id" in columns:
            return
        await conn.execute("SAVEPOINT principal_scoped_workspaces")
        try:
            await conn.execute(
                "CREATE TABLE local_workspaces_v2 ("
                "id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, path TEXT NOT NULL, "
                "label TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, "
                "UNIQUE (principal_id, path))"
            )
            await conn.execute(
                "INSERT INTO local_workspaces_v2 "
                "(id, principal_id, path, label, created_at, last_used_at) "
                "SELECT id, ?, path, label, created_at, last_used_at FROM local_workspaces",
                (LOCAL_OWNER_PRINCIPAL_ID,),
            )
            await conn.execute("DROP TABLE local_workspaces")
            await conn.execute("ALTER TABLE local_workspaces_v2 RENAME TO local_workspaces")
            await conn.execute("RELEASE principal_scoped_workspaces")
        except BaseException:
            await conn.execute("ROLLBACK TO principal_scoped_workspaces")
            await conn.execute("RELEASE principal_scoped_workspaces")
            raise

    @staticmethod
    async def _ensure_principal_scoped_commands(conn: aiosqlite.Connection) -> None:
        cursor = await conn.execute("PRAGMA table_info(local_commands)")
        columns = {row[1] for row in await cursor.fetchall()}
        if "principal_id" in columns:
            return
        await conn.execute("SAVEPOINT principal_scoped_commands")
        try:
            await conn.execute(
                "CREATE TABLE local_commands_v2 ("
                "principal_id TEXT NOT NULL, id TEXT NOT NULL, command_type TEXT NOT NULL, "
                "client_message_id TEXT NOT NULL, payload_json TEXT NOT NULL, "
                "run_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, "
                "PRIMARY KEY (principal_id, id), "
                "FOREIGN KEY (run_id) REFERENCES local_runs(id))"
            )
            await conn.execute(
                "INSERT INTO local_commands_v2 "
                "(principal_id, id, command_type, client_message_id, payload_json, "
                "run_id, created_at) "
                "SELECT ?, id, command_type, client_message_id, payload_json, run_id, "
                "created_at FROM local_commands",
                (LOCAL_OWNER_PRINCIPAL_ID,),
            )
            await conn.execute("DROP TABLE local_commands")
            await conn.execute("ALTER TABLE local_commands_v2 RENAME TO local_commands")
            await conn.execute("RELEASE principal_scoped_commands")
        except BaseException:
            await conn.execute("ROLLBACK TO principal_scoped_commands")
            await conn.execute("RELEASE principal_scoped_commands")
            raise

    @staticmethod
    async def _ensure_generic_commands(conn: aiosqlite.Connection) -> None:
        cursor = await conn.execute("PRAGMA table_info(local_commands)")
        columns = {row[1] for row in await cursor.fetchall()}
        schema = await (
            await conn.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'local_commands'"
            )
        ).fetchone()
        table_sql = str(schema[0] if schema else "").upper()
        if "response_json" in columns and "RUN_ID TEXT NOT NULL UNIQUE" not in table_sql:
            return
        await conn.execute("SAVEPOINT generic_commands")
        try:
            await conn.execute(
                "CREATE TABLE local_commands_v3 ("
                "principal_id TEXT NOT NULL, id TEXT NOT NULL, command_type TEXT NOT NULL, "
                "client_message_id TEXT NOT NULL, payload_json TEXT NOT NULL, "
                "response_json TEXT NOT NULL DEFAULT '{}', run_id TEXT NOT NULL, "
                "created_at TEXT NOT NULL, PRIMARY KEY (principal_id, id), "
                "FOREIGN KEY (run_id) REFERENCES local_runs(id))"
            )
            response_expression = "response_json" if "response_json" in columns else "'{}'"
            await conn.execute(
                "INSERT INTO local_commands_v3 "
                "(principal_id, id, command_type, client_message_id, payload_json, "
                "response_json, run_id, created_at) "
                "SELECT principal_id, id, command_type, client_message_id, payload_json, "
                f"{response_expression}, run_id, created_at FROM local_commands"
            )
            await conn.execute("DROP TABLE local_commands")
            await conn.execute("ALTER TABLE local_commands_v3 RENAME TO local_commands")
            await conn.execute("RELEASE generic_commands")
        except BaseException:
            await conn.execute("ROLLBACK TO generic_commands")
            await conn.execute("RELEASE generic_commands")
            raise

    @staticmethod
    async def _ensure_run_job_principals(conn: aiosqlite.Connection) -> None:
        cursor = await conn.execute(
            "SELECT jobs.id, jobs.input_json, runs.principal_id "
            "FROM local_run_jobs AS jobs "
            "JOIN local_runs AS runs ON runs.id = jobs.run_id"
        )
        for job_id, raw_input, principal_id in await cursor.fetchall():
            try:
                payload = json.loads(raw_input or "{}")
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(payload, dict) or payload.get("principal_id"):
                continue
            payload["principal_id"] = principal_id
            await conn.execute(
                "UPDATE local_run_jobs SET input_json = ? WHERE id = ?",
                (json.dumps(payload, ensure_ascii=False, default=str), job_id),
            )

    @staticmethod
    async def _ensure_event_sequence_index(conn: aiosqlite.Connection) -> None:
        """Repair legacy duplicate sequences, then enforce one sequence per run."""
        cursor = await conn.execute(
            "SELECT run_id FROM local_events GROUP BY run_id HAVING COUNT(*) != COUNT(DISTINCT seq)"
        )
        for row in await cursor.fetchall():
            run_id = row[0]
            events = await (
                await conn.execute(
                    "SELECT id FROM local_events WHERE run_id = ? ORDER BY seq, created_at, id",
                    (run_id,),
                )
            ).fetchall()
            # Use temporary negative values so this migration also remains safe
            # if a partially migrated database already has a unique index.
            await conn.executemany(
                "UPDATE local_events SET seq = ? WHERE id = ?",
                [(-(index + 1), event[0]) for index, event in enumerate(events)],
            )
            await conn.executemany(
                "UPDATE local_events SET seq = ? WHERE id = ?",
                [((index + 1), event[0]) for index, event in enumerate(events)],
            )
        await conn.execute("DROP INDEX IF EXISTS idx_local_events_run_seq")
        await conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_local_events_run_seq "
            "ON local_events(run_id, seq)"
        )

    async def close(self) -> None:
        await self._conn.close()

    @contextmanager
    def bind_execution_lease(
        self,
        *,
        job_id: str,
        run_id: str,
        lease_owner: str,
        lease_generation: int,
    ):
        lease = ExecutionLease(job_id, run_id, lease_owner, lease_generation)
        token = _CURRENT_EXECUTION_LEASE.set(lease)
        try:
            yield lease
        finally:
            _CURRENT_EXECUTION_LEASE.reset(token)

    @staticmethod
    def current_execution_lease() -> ExecutionLease | None:
        return _CURRENT_EXECUTION_LEASE.get()

    @asynccontextmanager
    async def run_write_transaction(
        self,
        run_id: str,
        *,
        lease: ExecutionLease | None = None,
    ):
        active_lease = lease or _CURRENT_EXECUTION_LEASE.get()
        async with aiosqlite.connect(str(self._db_path)) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA busy_timeout=5000")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                if active_lease is not None:
                    if active_lease.run_id != run_id:
                        raise LeaseFenceError(
                            f"lease for {active_lease.run_id} cannot write run {run_id}"
                        )
                    row = await (
                        await conn.execute(
                            "SELECT 1 FROM local_run_jobs WHERE id = ? AND run_id = ? "
                            "AND status = 'leased' AND lease_owner = ? "
                            "AND lease_generation = ? AND quarantined_at IS NULL "
                            "AND lease_expires_at > ?",
                            (
                                active_lease.job_id,
                                active_lease.run_id,
                                active_lease.lease_owner,
                                active_lease.lease_generation,
                                _now(),
                            ),
                        )
                    ).fetchone()
                    if row is None:
                        raise LeaseFenceError(
                            f"run {run_id} lease generation {active_lease.lease_generation} is stale"
                        )
                yield conn
                await conn.commit()
            except BaseException:
                await conn.rollback()
                raise

    # --- model providers ---

    async def reserve_model_call(
        self,
        *,
        run_id: str,
        execution_attempt_id: str,
        model: str,
        max_calls: int,
    ) -> dict[str, Any]:
        """Atomically reserve one durable model-call slot for a run."""
        async with self.run_write_transaction(run_id) as conn:
            row = await (
                await conn.execute(
                    "SELECT COUNT(*) AS count FROM local_model_calls WHERE run_id = ?",
                    (run_id,),
                )
            ).fetchone()
            call_index = int(row["count"] if row is not None else 0) + 1
            if call_index > max(1, int(max_calls)):
                raise ModelCallBudgetExceeded(
                    f"model call budget exhausted for run {run_id}: {max_calls}"
                )
            record = {
                "id": _new_id("model_call"),
                "run_id": run_id,
                "execution_attempt_id": execution_attempt_id,
                "call_index": call_index,
                "model": model,
                "status": "reserved",
                "created_at": _now(),
            }
            await conn.execute(
                "INSERT INTO local_model_calls "
                "(id, run_id, execution_attempt_id, call_index, model, status, created_at) "
                "VALUES (:id, :run_id, :execution_attempt_id, :call_index, :model, :status, "
                ":created_at)",
                record,
            )
        return record

    async def mark_model_call_output(self, *, run_id: str, call_id: str) -> None:
        async with self.run_write_transaction(run_id) as conn:
            await conn.execute(
                "UPDATE local_model_calls SET status = 'streaming', output_started = 1, "
                "first_output_at = COALESCE(first_output_at, ?) "
                "WHERE id = ? AND run_id = ? AND status IN ('reserved', 'streaming')",
                (_now(), call_id, run_id),
            )

    async def settle_model_call(
        self,
        *,
        run_id: str,
        call_id: str,
        provider_request_id: str | None,
        input_tokens: int | None,
        output_tokens: int | None,
        credits_cost: int | None,
    ) -> None:
        usage_known = input_tokens is not None or output_tokens is not None
        status = "completed" if usage_known else "completed_unmetered"
        async with self.run_write_transaction(run_id) as conn:
            cursor = await conn.execute(
                "UPDATE local_model_calls SET status = ?, provider_request_id = ?, "
                "input_tokens = ?, output_tokens = ?, credits_cost = ?, completed_at = ? "
                "WHERE id = ? AND run_id = ? AND status IN ('reserved', 'streaming')",
                (
                    status,
                    provider_request_id,
                    input_tokens,
                    output_tokens,
                    credits_cost,
                    _now(),
                    call_id,
                    run_id,
                ),
            )
            if cursor.rowcount != 1:
                raise RuntimeError(f"model call {call_id} cannot be settled twice")

    async def fail_model_call(
        self,
        *,
        run_id: str,
        call_id: str,
        outcome_unknown: bool,
        error_code: str | None = None,
    ) -> None:
        status = "outcome_unknown" if outcome_unknown else "failed"
        async with self.run_write_transaction(run_id) as conn:
            await conn.execute(
                "UPDATE local_model_calls SET status = ?, error_code = ?, completed_at = ? "
                "WHERE id = ? AND run_id = ? AND status IN ('reserved', 'streaming')",
                (status, error_code, _now(), call_id, run_id),
            )

    async def model_usage_summary(self, run_id: str) -> dict[str, int]:
        row = await (
            await self._conn.execute(
                "SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens, "
                "COALESCE(SUM(output_tokens), 0) AS output_tokens, "
                "COALESCE(SUM(credits_cost), 0) AS credits_cost, "
                "SUM(CASE WHEN status = 'completed_unmetered' THEN 1 ELSE 0 END) "
                "AS unmetered_calls, "
                "SUM(CASE WHEN status = 'outcome_unknown' THEN 1 ELSE 0 END) "
                "AS outcome_unknown_calls, COUNT(*) AS model_calls "
                "FROM local_model_calls WHERE run_id = ?",
                (run_id,),
            )
        ).fetchone()
        return {
            key: int(row[key] or 0)
            for key in (
                "input_tokens",
                "output_tokens",
                "credits_cost",
                "unmetered_calls",
                "outcome_unknown_calls",
                "model_calls",
            )
        }

    async def execution_settlement_snapshot(self, run_id: str) -> dict[str, Any]:
        """Read the authoritative records needed to settle one execution."""
        model_rows = await (
            await self._conn.execute(
                "SELECT status, COUNT(*) AS count FROM local_model_calls "
                "WHERE run_id = ? GROUP BY status ORDER BY status",
                (run_id,),
            )
        ).fetchall()
        tool_rows = await (
            await self._conn.execute(
                "SELECT status, COUNT(*) AS count FROM local_tool_receipts "
                "WHERE run_id = ? GROUP BY status ORDER BY status",
                (run_id,),
            )
        ).fetchall()
        draft = await (
            await self._conn.execute(
                "SELECT * FROM local_assistant_drafts WHERE run_id = ?",
                (run_id,),
            )
        ).fetchone()
        artifact_count_row = await (
            await self._conn.execute(
                "SELECT COUNT(*) AS count FROM local_artifacts WHERE run_id = ?",
                (run_id,),
            )
        ).fetchone()
        artifacts = await (
            await self._conn.execute(
                "SELECT id, kind, content_type, bytes FROM local_artifacts "
                "WHERE run_id = ? ORDER BY created_at, id LIMIT ?",
                (run_id, MAX_SETTLEMENT_ARTIFACT_REFS),
            )
        ).fetchall()
        verification = await (
            await self._conn.execute(
                "SELECT operation_id, status, result_hash FROM local_tool_receipts "
                "WHERE run_id = ? AND tool_name = 'task.verify' "
                "ORDER BY created_at DESC, operation_id DESC LIMIT 1",
                (run_id,),
            )
        ).fetchone()
        return {
            "assistant": dict(draft) if draft is not None else None,
            "usage": await self.model_usage_summary(run_id),
            "model_statuses": {str(row["status"]): int(row["count"]) for row in model_rows},
            "tool_statuses": {str(row["status"]): int(row["count"]) for row in tool_rows},
            "artifacts": {
                "count": int(artifact_count_row["count"] if artifact_count_row else 0),
                "items": [dict(row) for row in artifacts],
                "truncated": int(artifact_count_row["count"] if artifact_count_row else 0)
                > len(artifacts),
            },
            "verification": dict(verification) if verification is not None else None,
        }

    async def update_assistant_draft(
        self,
        *,
        run_id: str,
        message_key: str,
        content: str,
        tool_calls: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Persist one fully assembled top-level assistant model round."""
        now = _now()
        async with self.run_write_transaction(run_id) as conn:
            existing = await (
                await conn.execute(
                    "SELECT * FROM local_assistant_drafts WHERE run_id = ?",
                    (run_id,),
                )
            ).fetchone()
            if existing is not None and existing["message_key"] == message_key:
                return dict(existing)
            revision = int(existing["revision"] if existing is not None else 0) + 1
            created_at = str(existing["created_at"] if existing is not None else now)
            await conn.execute(
                "INSERT INTO local_assistant_drafts "
                "(run_id, revision, message_key, content, tool_calls_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(run_id) DO UPDATE SET revision = excluded.revision, "
                "message_key = excluded.message_key, content = excluded.content, "
                "tool_calls_json = excluded.tool_calls_json, updated_at = excluded.updated_at",
                (
                    run_id,
                    revision,
                    message_key,
                    content,
                    json.dumps(tool_calls, ensure_ascii=False, separators=(",", ":"), default=str),
                    created_at,
                    now,
                ),
            )
        return {
            "run_id": run_id,
            "revision": revision,
            "message_key": message_key,
            "content": content,
            "tool_calls_json": json.dumps(
                tool_calls,
                ensure_ascii=False,
                separators=(",", ":"),
                default=str,
            ),
            "created_at": created_at,
            "updated_at": now,
        }

    # --- durable tool execution receipts ---

    async def prepare_tool_receipt(
        self,
        *,
        operation_id: str,
        run_id: str,
        execution_attempt_id: str,
        tool_call_id: str,
        tool_name: str,
        arguments_hash: str,
        arguments_json: str,
        risk: str,
        tool_version: str = "",
        execution_namespace: str = "main",
    ) -> dict[str, Any]:
        async with self.run_write_transaction(run_id) as conn:
            existing = await (
                await conn.execute(
                    "SELECT * FROM local_tool_receipts WHERE run_id = ? "
                    "AND execution_namespace = ? AND tool_call_id = ?",
                    (run_id, execution_namespace, tool_call_id),
                )
            ).fetchone()
            if existing is not None:
                record = dict(existing)
                if (
                    record["operation_id"] != operation_id
                    or record["execution_namespace"] != execution_namespace
                    or record["tool_name"] != tool_name
                    or record["tool_version"] != tool_version
                    or record["arguments_hash"] != arguments_hash
                ):
                    raise ToolReceiptConflictError(
                        f"tool call {tool_call_id} was reused with different arguments"
                    )
                return record
            now = _now()
            await conn.execute(
                "INSERT INTO local_tool_receipts "
                "(operation_id, run_id, execution_attempt_id, execution_namespace, "
                "tool_call_id, tool_name, "
                "tool_version, arguments_hash, arguments_json, risk, status, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)",
                (
                    operation_id,
                    run_id,
                    execution_attempt_id,
                    execution_namespace,
                    tool_call_id,
                    tool_name,
                    tool_version,
                    arguments_hash,
                    arguments_json,
                    risk,
                    now,
                    now,
                ),
            )
            row = await (
                await conn.execute(
                    "SELECT * FROM local_tool_receipts WHERE operation_id = ?",
                    (operation_id,),
                )
            ).fetchone()
            assert row is not None
            return dict(row)

    async def begin_tool_receipt(
        self,
        *,
        operation_id: str,
        run_id: str,
        execution_attempt_id: str,
    ) -> dict[str, Any]:
        async with self.run_write_transaction(run_id) as conn:
            row = await (
                await conn.execute(
                    "SELECT * FROM local_tool_receipts WHERE operation_id = ? AND run_id = ?",
                    (operation_id, run_id),
                )
            ).fetchone()
            if row is None:
                raise ToolReceiptStateError(f"tool receipt {operation_id} is missing")
            record = dict(row)
            status = str(record["status"])
            if status in {"completed", "failed", "rejected"}:
                return record
            if status in {"running", "outcome_unknown"}:
                raise ToolOutcomeUnknownError(
                    f"tool operation {operation_id} has unresolved outcome {status}"
                )
            if status not in {"prepared", "paused"}:
                raise ToolReceiptStateError(
                    f"tool operation {operation_id} cannot start from {status}"
                )
            now = _now()
            await conn.execute(
                "UPDATE local_tool_receipts SET status = 'running', "
                "execution_attempt_id = ?, attempt_count = attempt_count + 1, "
                "started_at = COALESCE(started_at, ?), updated_at = ? "
                "WHERE operation_id = ? AND run_id = ?",
                (execution_attempt_id, now, now, operation_id, run_id),
            )
            updated = await (
                await conn.execute(
                    "SELECT * FROM local_tool_receipts WHERE operation_id = ?",
                    (operation_id,),
                )
            ).fetchone()
            assert updated is not None
            return dict(updated)

    async def settle_tool_receipt(
        self,
        *,
        operation_id: str,
        run_id: str,
        status: str,
        result_json: str | None = None,
        result_hash: str | None = None,
        error_type: str | None = None,
    ) -> dict[str, Any]:
        if status not in {
            "paused",
            "completed",
            "failed",
            "outcome_unknown",
            "rejected",
            "canceled",
        }:
            raise ValueError(f"invalid tool receipt status: {status}")
        async with self.run_write_transaction(run_id) as conn:
            now = _now()
            cursor = await conn.execute(
                "UPDATE local_tool_receipts SET status = ?, result_json = ?, result_hash = ?, "
                "error_type = ?, updated_at = ?, completed_at = CASE WHEN ? = 'paused' "
                "THEN completed_at ELSE ? END WHERE operation_id = ? AND run_id = ? "
                "AND (status = 'running' OR (? IN ('rejected', 'failed', 'canceled') "
                "AND status = 'prepared'))",
                (
                    status,
                    result_json,
                    result_hash,
                    error_type,
                    now,
                    status,
                    now,
                    operation_id,
                    run_id,
                    status,
                ),
            )
            if cursor.rowcount != 1:
                raise ToolReceiptStateError(f"tool operation {operation_id} is not running")
            row = await (
                await conn.execute(
                    "SELECT * FROM local_tool_receipts WHERE operation_id = ?",
                    (operation_id,),
                )
            ).fetchone()
            assert row is not None
            return dict(row)

    async def reconcile_tool_receipt(
        self,
        *,
        operation_id: str,
        run_id: str,
        decision: str,
        result_json: str | None = None,
        result_hash: str | None = None,
    ) -> dict[str, Any]:
        """Resolve an uncertain side effect without guessing or blind retry."""
        if decision not in {"confirmed_completed", "retry_not_executed", "abort"}:
            raise ValueError(f"invalid tool reconciliation decision: {decision}")
        status = {
            "confirmed_completed": "completed",
            "retry_not_executed": "prepared",
            "abort": "failed",
        }[decision]
        async with self.run_write_transaction(run_id) as conn:
            now = _now()
            cursor = await conn.execute(
                "UPDATE local_tool_receipts SET status = ?, result_json = ?, "
                "result_hash = ?, error_type = ?, updated_at = ?, "
                "completed_at = CASE WHEN ? = 'prepared' THEN NULL ELSE ? END "
                "WHERE operation_id = ? AND run_id = ? AND status = 'outcome_unknown'",
                (
                    status,
                    result_json,
                    result_hash,
                    None if decision == "confirmed_completed" else "ReconciledByUser",
                    now,
                    status,
                    now,
                    operation_id,
                    run_id,
                ),
            )
            if cursor.rowcount != 1:
                raise ToolReceiptStateError(
                    f"tool operation {operation_id} is not awaiting reconciliation"
                )
            row = await (
                await conn.execute(
                    "SELECT * FROM local_tool_receipts WHERE operation_id = ?",
                    (operation_id,),
                )
            ).fetchone()
            assert row is not None
            return dict(row)

    async def tool_execution_cancel_requested(self, run_id: str) -> bool:
        """Fence a tool start against the currently leased run job."""
        lease = _CURRENT_EXECUTION_LEASE.get()
        if lease is None:
            return False
        if lease.run_id != run_id:
            raise LeaseFenceError("tool execution is missing its run job lease")
        row = await (
            await self._conn.execute(
                "SELECT status, lease_owner, lease_generation, lease_expires_at, "
                "cancel_requested_at FROM local_run_jobs WHERE id = ? AND run_id = ?",
                (lease.job_id, run_id),
            )
        ).fetchone()
        if (
            row is None
            or row["status"] != "leased"
            or row["lease_owner"] != lease.lease_owner
            or int(row["lease_generation"] or 0) != lease.lease_generation
            or str(row["lease_expires_at"] or "") <= _now()
        ):
            raise LeaseFenceError("tool execution lease is stale")
        return row["cancel_requested_at"] is not None

    async def get_tool_receipt(self, operation_id: str) -> dict[str, Any] | None:
        row = await (
            await self._conn.execute(
                "SELECT * FROM local_tool_receipts WHERE operation_id = ?",
                (operation_id,),
            )
        ).fetchone()
        return dict(row) if row is not None else None

    async def list_tool_receipts_for_run(self, run_id: str) -> list[dict[str, Any]]:
        rows = await (
            await self._conn.execute(
                "SELECT * FROM local_tool_receipts WHERE run_id = ? ORDER BY created_at, operation_id",
                (run_id,),
            )
        ).fetchall()
        return [dict(row) for row in rows]

    async def get_assistant_draft(self, run_id: str) -> dict[str, Any] | None:
        row = await (
            await self._conn.execute(
                "SELECT * FROM local_assistant_drafts WHERE run_id = ?",
                (run_id,),
            )
        ).fetchone()
        return dict(row) if row is not None else None

    async def list_model_providers(self, *, principal_id: str) -> list[dict[str, Any]]:
        rows = await (
            await self._conn.execute(
                "SELECT * FROM local_model_providers WHERE principal_id = ? ORDER BY name, id",
                (principal_id,),
            )
        ).fetchall()
        return [dict(row) for row in rows]

    async def get_model_provider(
        self,
        *,
        principal_id: str,
        provider_id: str,
    ) -> dict[str, Any] | None:
        row = await (
            await self._conn.execute(
                "SELECT * FROM local_model_providers WHERE principal_id = ? AND id = ?",
                (principal_id, provider_id),
            )
        ).fetchone()
        return dict(row) if row is not None else None

    async def upsert_model_provider(
        self,
        *,
        principal_id: str,
        provider_id: str,
        name: str,
        kind: str,
        base_url: str,
        requires_api_key: bool,
        credential_ref: str,
        models: list[dict[str, Any]],
        enabled: bool,
    ) -> dict[str, Any]:
        now = _now()
        await self._conn.execute(
            "INSERT INTO local_model_providers "
            "(principal_id, id, name, kind, base_url, requires_api_key, credential_ref, "
            " models_json, enabled, version, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) "
            "ON CONFLICT(principal_id, id) DO UPDATE SET "
            "name = excluded.name, kind = excluded.kind, base_url = excluded.base_url, "
            "requires_api_key = excluded.requires_api_key, "
            "credential_ref = excluded.credential_ref, models_json = excluded.models_json, "
            "enabled = excluded.enabled, version = local_model_providers.version + 1, "
            "updated_at = excluded.updated_at",
            (
                principal_id,
                provider_id,
                name,
                kind,
                base_url,
                int(requires_api_key),
                credential_ref,
                json.dumps(models, ensure_ascii=False, separators=(",", ":")),
                int(enabled),
                now,
                now,
            ),
        )
        await self._conn.commit()
        provider = await self.get_model_provider(
            principal_id=principal_id,
            provider_id=provider_id,
        )
        assert provider is not None
        return provider

    async def delete_model_provider(
        self,
        *,
        principal_id: str,
        provider_id: str,
    ) -> dict[str, Any] | None:
        provider = await self.get_model_provider(
            principal_id=principal_id,
            provider_id=provider_id,
        )
        if provider is None:
            return None
        await self._conn.execute(
            "DELETE FROM local_model_providers WHERE principal_id = ? AND id = ?",
            (principal_id, provider_id),
        )
        await self._conn.commit()
        return provider

    # --- workspaces ---

    async def create_workspace(self, *, principal_id: str, path: str, label: str) -> dict[str, Any]:
        ws = {
            "id": _new_id("ws"),
            "principal_id": principal_id,
            "path": path,
            "label": label,
            "created_at": _now(),
            "last_used_at": _now(),
        }
        try:
            await self._conn.execute(
                "INSERT INTO local_workspaces "
                "(id, principal_id, path, label, created_at, last_used_at) "
                "VALUES (:id, :principal_id, :path, :label, :created_at, :last_used_at)",
                ws,
            )
            await self._conn.commit()
        except aiosqlite.IntegrityError:
            # path already registered — return the existing record
            row = await (
                await self._conn.execute(
                    "SELECT * FROM local_workspaces WHERE principal_id = ? AND path = ?",
                    (principal_id, path),
                )
            ).fetchone()
            assert row is not None
            return dict(row)
        return ws

    async def list_workspaces(self, *, principal_id: str) -> list[dict[str, Any]]:
        cursor = await self._conn.execute(
            "SELECT * FROM local_workspaces WHERE principal_id = ? ORDER BY last_used_at DESC",
            (principal_id,),
        )
        return [dict(row) for row in await cursor.fetchall()]

    async def workspace_by_path(self, *, principal_id: str, path: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM local_workspaces WHERE principal_id = ? AND path = ?",
            (principal_id, path),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def find_outcome_unknown_tool_receipt_in_lineage(
        self,
        *,
        current_run_id: str,
        tool_name: str,
        arguments_hash: str,
        risk: str,
    ) -> dict[str, Any] | None:
        row = await (
            await self._conn.execute(
                "WITH RECURSIVE lineage(id, owner, depth) AS ("
                "SELECT parent_run_id, principal_id, 0 FROM local_runs "
                "WHERE id = ? AND parent_run_id IS NOT NULL UNION ALL "
                "SELECT ancestor.parent_run_id, lineage.owner, lineage.depth + 1 "
                "FROM local_runs AS ancestor JOIN lineage ON ancestor.id = lineage.id "
                "WHERE ancestor.principal_id = lineage.owner "
                "AND ancestor.parent_run_id IS NOT NULL AND lineage.depth < 64"
                ") SELECT local_tool_receipts.* FROM local_tool_receipts "
                "JOIN lineage ON lineage.id = local_tool_receipts.run_id "
                "JOIN local_runs AS ancestor ON ancestor.id = lineage.id "
                "AND ancestor.principal_id = lineage.owner "
                "WHERE local_tool_receipts.tool_name = ? "
                "AND local_tool_receipts.arguments_hash = ? "
                "AND local_tool_receipts.risk = ? "
                "AND local_tool_receipts.status = 'outcome_unknown' "
                "ORDER BY lineage.depth, local_tool_receipts.updated_at DESC LIMIT 1",
                (current_run_id, tool_name, arguments_hash, risk),
            )
        ).fetchone()
        return dict(row) if row else None

    async def workspace_admission_error(self, *, principal_id: str, path: str | None) -> str | None:
        owner_error = await self._workspace_owner_error(
            self._conn,
            principal_id=principal_id,
            path=path,
        )
        return owner_error or await self._workspace_path_error(path)

    @staticmethod
    async def _workspace_owner_error(
        conn: aiosqlite.Connection, *, principal_id: str, path: str | None
    ) -> str | None:
        if path is None:
            return None
        workspace = await (
            await conn.execute(
                "SELECT 1 FROM local_workspaces WHERE principal_id = ? AND path = ?",
                (principal_id, path),
            )
        ).fetchone()
        if workspace is None:
            return "workspace is not authorized"
        return None

    @staticmethod
    async def _workspace_path_error(path: str | None) -> str | None:
        if path is None:
            return None
        return await asyncio.to_thread(LocalStore._workspace_path_error_sync, path)

    @staticmethod
    def _workspace_path_error_sync(path: str) -> str | None:
        root = Path(path)
        try:
            if root.is_symlink() or str(root.resolve(strict=True)) != path or not root.is_dir():
                return "workspace is no longer available"
        except OSError:
            return "workspace is no longer available"
        return None

    async def delete_workspace(self, *, principal_id: str, workspace_id: str) -> bool:
        cursor = await self._conn.execute(
            "DELETE FROM local_workspaces WHERE principal_id = ? AND id = ?",
            (principal_id, workspace_id),
        )
        await self._conn.commit()
        return cursor.rowcount > 0

    async def touch_workspace(self, *, principal_id: str, workspace_id: str) -> None:
        await self._conn.execute(
            "UPDATE local_workspaces SET last_used_at = ? WHERE principal_id = ? AND id = ?",
            (_now(), principal_id, workspace_id),
        )
        await self._conn.commit()

    # --- runs ---

    async def create_run(
        self,
        *,
        principal_id: str,
        goal: str,
        workspace_path: str | None,
        parent_run_id: str | None = None,
        settings: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        mode: str = "fast",
        graph_thread_id: str | None = None,
        graph_checkpoint_id: str | None = None,
        graph_definition_id: str | None = None,
        graph_input_kind: str = "new",
    ) -> dict[str, Any]:
        run = self._new_run_record(
            principal_id=principal_id,
            goal=goal,
            workspace_path=workspace_path,
            parent_run_id=parent_run_id,
            settings=settings,
            metadata=metadata,
            mode=mode,
            graph_thread_id=graph_thread_id,
            graph_checkpoint_id=graph_checkpoint_id,
            graph_definition_id=graph_definition_id,
            graph_input_kind=graph_input_kind,
        )
        await self._insert_run(self._conn, run)
        await self._conn.commit()
        return run

    @staticmethod
    def _new_run_record(
        *,
        principal_id: str,
        goal: str,
        workspace_path: str | None,
        parent_run_id: str | None,
        settings: dict[str, Any] | None,
        metadata: dict[str, Any] | None,
        mode: str,
        history: list[dict[str, str]] | None = None,
        graph_thread_id: str | None = None,
        graph_checkpoint_id: str | None = None,
        graph_definition_id: str | None = None,
        graph_input_kind: str = "new",
        thread_id: str | None = None,
        assistant_item_id: str | None = None,
        user_input: str | None = None,
    ) -> dict[str, Any]:
        if graph_input_kind not in {"new", "fork"}:
            raise ValueError(f"invalid graph input kind: {graph_input_kind}")
        return {
            "id": _new_id("run"),
            "principal_id": principal_id,
            "graph_thread_id": graph_thread_id or _new_id("thread"),
            "graph_checkpoint_id": graph_checkpoint_id,
            "graph_definition_id": graph_definition_id,
            "graph_input_kind": graph_input_kind,
            "thread_id": thread_id,
            "assistant_item_id": assistant_item_id,
            "user_input": user_input or goal,
            "goal": goal,
            "workspace_path": workspace_path,
            "status": "queued",
            "history_json": json.dumps(history or [], ensure_ascii=False, default=str),
            "parent_run_id": parent_run_id,
            "settings_json": json.dumps(settings or {}, ensure_ascii=False),
            "metadata_json": json.dumps(metadata or {}, ensure_ascii=False, default=str),
            "mode": mode,
            "created_at": _now(),
            "updated_at": _now(),
            "completed_at": None,
        }

    @staticmethod
    async def _insert_run(conn: aiosqlite.Connection, run: dict[str, Any]) -> None:
        await conn.execute(
            "INSERT INTO local_runs "
            "(id, principal_id, graph_thread_id, graph_checkpoint_id, graph_definition_id, "
            " graph_input_kind, thread_id, assistant_item_id, user_input, goal, workspace_path, status, history_json, parent_run_id, "
            " settings_json, metadata_json, mode, created_at, updated_at, completed_at) "
            "VALUES (:id, :principal_id, :graph_thread_id, :graph_checkpoint_id, "
            "        :graph_definition_id, :graph_input_kind, :thread_id, :assistant_item_id, :user_input, :goal, :workspace_path, "
            "        :status, :history_json, :parent_run_id, :settings_json, :metadata_json, "
            "        :mode, :created_at, :updated_at, :completed_at)",
            run,
        )

    @staticmethod
    def _run_job_input(run: dict[str, Any]) -> dict[str, Any]:
        return {
            "principal_id": run["principal_id"],
            "goal": run["goal"],
            "user_input": run.get("user_input") or run["goal"],
            "workspace_path": run["workspace_path"],
            "mode": run["mode"],
            "history": json.loads(run["history_json"] or "[]"),
            "settings": json.loads(run["settings_json"] or "{}"),
            "metadata": json.loads(run["metadata_json"] or "{}"),
        }

    @staticmethod
    def _new_run_job_record(
        *,
        run_id: str,
        kind: str,
        input_payload: dict[str, Any],
        resume_payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        created_at = _now()
        return {
            "id": _new_id("job"),
            "run_id": run_id,
            "kind": kind,
            "status": "pending",
            "input_json": _encode_payload(input_payload),
            "resume_json": _encode_payload(resume_payload) if resume_payload is not None else None,
            "lease_owner": None,
            "lease_generation": 0,
            "lease_expires_at": None,
            "attempt": 0,
            "cancel_requested_at": None,
            "created_at": created_at,
            "updated_at": created_at,
            "finished_at": None,
        }

    @staticmethod
    async def _insert_run_job(conn: aiosqlite.Connection, job: dict[str, Any]) -> None:
        await conn.execute(
            "INSERT INTO local_run_jobs "
            "(id, run_id, kind, status, input_json, resume_json, lease_owner, "
            " lease_generation, lease_expires_at, attempt, cancel_requested_at, "
            " created_at, updated_at, finished_at) "
            "VALUES (:id, :run_id, :kind, :status, :input_json, :resume_json, "
            " :lease_owner, :lease_generation, :lease_expires_at, :attempt, "
            " :cancel_requested_at, :created_at, :updated_at, :finished_at)",
            job,
        )

    @staticmethod
    async def _accepted_run_for_command(
        conn: aiosqlite.Connection,
        *,
        principal_id: str,
        command_id: str,
        payload_json: str,
    ) -> dict[str, Any] | None:
        command = await (
            await conn.execute(
                "SELECT payload_json, run_id FROM local_commands WHERE principal_id = ? AND id = ?",
                (principal_id, command_id),
            )
        ).fetchone()
        if command is None:
            return None
        if command["payload_json"] != payload_json:
            raise CommandConflictError(
                f"command {command_id} was already accepted with different content"
            )
        run = await (
            await conn.execute(
                "SELECT r.*, c.id AS command_id, c.client_message_id "
                "FROM local_runs r JOIN local_commands c ON c.run_id = r.id "
                "AND c.principal_id = r.principal_id "
                "WHERE r.id = ? AND c.principal_id = ? AND c.id = ?",
                (command["run_id"], principal_id, command_id),
            )
        ).fetchone()
        if run is None:
            raise RuntimeError(f"command {command_id} references a missing run")
        return dict(run)

    @staticmethod
    async def _accepted_command_receipt_uncommitted(
        conn: aiosqlite.Connection,
        *,
        principal_id: str,
        command_id: str,
        command_type: str,
        payload_json: str,
    ) -> dict[str, Any] | None:
        existing = await (
            await conn.execute(
                "SELECT command_type, payload_json, response_json "
                "FROM local_commands WHERE principal_id = ? AND id = ?",
                (principal_id, command_id),
            )
        ).fetchone()
        if existing is None:
            return None
        if existing["command_type"] != command_type or existing["payload_json"] != payload_json:
            raise CommandConflictError(
                f"command {command_id} was already accepted with different content"
            )
        return json.loads(existing["response_json"])

    async def accepted_command_receipt(
        self,
        *,
        principal_id: str,
        command_id: str,
        command_type: str,
        payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        return await self._accepted_command_receipt_uncommitted(
            self._conn,
            principal_id=principal_id,
            command_id=command_id,
            command_type=command_type,
            payload_json=_encode_payload(payload),
        )

    async def accepted_run_for_command(
        self,
        *,
        principal_id: str,
        command_id: str,
        client_message_id: str,
        command_payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Return an immutable command receipt before checking mutable resources."""
        return await self._accepted_run_for_command(
            self._conn,
            principal_id=principal_id,
            command_id=command_id,
            payload_json=_encode_payload(
                {"client_message_id": client_message_id, "payload": command_payload}
            ),
        )

    async def accept_run_command(
        self,
        *,
        principal_id: str,
        command_id: str,
        client_message_id: str,
        command_payload: dict[str, Any],
        goal: str,
        workspace_path: str | None,
        mode: str,
        thread_id: str | None = None,
        user_input: str | None = None,
        assistant_message_id: str | None = None,
        thread_title: str | None = None,
        thread_metadata: dict[str, Any] | None = None,
        user_item_metadata: dict[str, Any] | None = None,
        replace_from_client_id: str | None = None,
        require_new_thread: bool = False,
        graph_thread_id: str | None = None,
        graph_checkpoint_id: str | None = None,
        graph_definition_id: str | None = None,
        graph_input_kind: str = "new",
        history: list[dict[str, str]] | None = None,
        parent_run_id: str | None = None,
        settings: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        admission_error: RunAdmissionError | None = None,
    ) -> tuple[dict[str, Any], bool]:
        """Persist one immutable start command and its queued run."""
        payload_json = _encode_payload(
            {"client_message_id": client_message_id, "payload": command_payload}
        )
        existing = await self._accepted_run_for_command(
            self._conn,
            principal_id=principal_id,
            command_id=command_id,
            payload_json=payload_json,
        )
        if existing is not None:
            return existing, False
        path_error = (
            await self._workspace_path_error(workspace_path) if admission_error is None else None
        )
        if path_error is not None:
            existing = await self._accepted_run_for_command(
                self._conn,
                principal_id=principal_id,
                command_id=command_id,
                payload_json=payload_json,
            )
            if existing is not None:
                return existing, False
            raise WorkspaceAdmissionError(path_error)

        async with aiosqlite.connect(str(self._db_path)) as transaction_conn:
            transaction_conn.row_factory = aiosqlite.Row
            await transaction_conn.execute("PRAGMA busy_timeout=5000")
            await transaction_conn.execute("BEGIN IMMEDIATE")
            try:
                existing = await self._accepted_run_for_command(
                    transaction_conn,
                    principal_id=principal_id,
                    command_id=command_id,
                    payload_json=payload_json,
                )
                if existing is not None:
                    await transaction_conn.rollback()
                    return existing, False
                if admission_error is not None:
                    raise admission_error
                if path_error is not None:
                    raise WorkspaceAdmissionError(path_error)

                workspace_error = await self._workspace_owner_error(
                    transaction_conn,
                    principal_id=principal_id,
                    path=workspace_path,
                )
                if workspace_error is not None:
                    raise WorkspaceAdmissionError(workspace_error)
                if parent_run_id is not None:
                    parent = await (
                        await transaction_conn.execute(
                            "SELECT status FROM local_runs WHERE principal_id = ? AND id = ?",
                            (principal_id, parent_run_id),
                        )
                    ).fetchone()
                    if parent is None:
                        raise ParentRunAdmissionError("parent run not found")
                    if str(parent["status"]) in {"queued", "running", "cleanup_required"}:
                        raise ParentRunAdmissionError(
                            "parent run has not reached a safely settled state"
                        )

                product_thread_id = (
                    _principal_thread_id(principal_id, thread_id)
                    if thread_id is not None
                    else _new_id("thread")
                )
                thread = await (
                    await transaction_conn.execute(
                        "SELECT * FROM local_threads WHERE id = ?",
                        (product_thread_id,),
                    )
                ).fetchone()
                now = _now()
                seed_history: list[dict[str, str]] = []
                if thread is not None and require_new_thread:
                    raise ThreadAdmissionError("fork target thread already exists")
                if thread is None:
                    if replace_from_client_id is not None:
                        raise ThreadAdmissionError("thread not found")
                    await transaction_conn.execute(
                        "INSERT INTO local_threads "
                        "(id, principal_id, title, metadata_json, version, created_at, updated_at) "
                        "VALUES (?, ?, ?, ?, 1, ?, ?)",
                        (
                            product_thread_id,
                            principal_id,
                            " ".join((thread_title or user_input or goal).split())[:80],
                            _encode_payload(thread_metadata or {}),
                            now,
                            now,
                        ),
                    )
                    thread_version = 1
                    seed_history = [
                        {"role": str(message["role"]), "content": str(message["content"])}
                        for message in history or []
                        if message.get("role") in {"user", "assistant"}
                        and str(message.get("content") or "").strip()
                    ]
                    base_position = len(seed_history)
                else:
                    if thread["principal_id"] != principal_id:
                        raise ThreadAdmissionError("thread not found")
                    if thread["deleted_at"] is not None:
                        raise ThreadAdmissionError("thread not found")
                    if thread["archived_at"] is not None:
                        raise ThreadAdmissionError("thread is archived")
                    duplicate_item = await (
                        await transaction_conn.execute(
                            "SELECT 1 FROM local_thread_items "
                            "WHERE thread_id = ? AND client_id = ?",
                            (product_thread_id, client_message_id),
                        )
                    ).fetchone()
                    if duplicate_item is not None:
                        raise CommandConflictError(
                            f"client message {client_message_id} already belongs to another command"
                        )
                    active = await (
                        await transaction_conn.execute(
                            "SELECT 1 FROM local_runs r "
                            "LEFT JOIN local_run_jobs j ON j.run_id = r.id "
                            "WHERE r.principal_id = ? AND r.thread_id = ? AND ("
                            "r.status NOT IN ('completed', 'failed', 'canceled') "
                            "OR j.status IN ('pending', 'leased')) LIMIT 1",
                            (principal_id, product_thread_id),
                        )
                    ).fetchone()
                    if active is not None:
                        raise ThreadAdmissionError("thread has an unsettled run")
                    if replace_from_client_id is not None:
                        target = await (
                            await transaction_conn.execute(
                                "SELECT position FROM local_thread_items "
                                "WHERE thread_id = ? AND client_id = ? "
                                "AND item_type = 'user_message' AND superseded_at IS NULL",
                                (product_thread_id, replace_from_client_id),
                            )
                        ).fetchone()
                        if target is None:
                            raise ThreadAdmissionError("thread message not found")
                        base_position = int(target["position"]) - 1
                    else:
                        position_row = await (
                            await transaction_conn.execute(
                                "SELECT COALESCE(MAX(position), 0) FROM local_thread_items "
                                "WHERE thread_id = ? AND superseded_at IS NULL",
                                (product_thread_id,),
                            )
                        ).fetchone()
                        base_position = int(position_row[0] if position_row else 0)
                    thread_version = int(thread["version"]) + 1
                    await transaction_conn.execute(
                        "UPDATE local_threads SET version = ?, title = ?, metadata_json = ?, "
                        "updated_at = ? WHERE id = ?",
                        (
                            thread_version,
                            " ".join((thread_title or thread["title"]).split())[:80],
                            _encode_payload(thread_metadata)
                            if thread_metadata is not None
                            else thread["metadata_json"],
                            now,
                            product_thread_id,
                        ),
                    )

                if thread is None:
                    authoritative_history = seed_history
                    if seed_history:
                        await transaction_conn.executemany(
                            "INSERT INTO local_thread_items "
                            "(id, thread_id, run_id, client_id, item_type, status, content, "
                            "metadata_json, position, version, created_at, updated_at, completed_at) "
                            "VALUES (?, ?, NULL, NULL, ?, 'completed', ?, '{}', ?, 1, ?, ?, ?)",
                            [
                                (
                                    _new_id("item"),
                                    product_thread_id,
                                    f"{message['role']}_message",
                                    message["content"],
                                    position,
                                    now,
                                    now,
                                    now,
                                )
                                for position, message in enumerate(seed_history, start=1)
                            ],
                        )
                else:
                    history_rows = await (
                        await transaction_conn.execute(
                            "SELECT item_type, content FROM local_thread_items "
                            "WHERE thread_id = ? AND superseded_at IS NULL "
                            "AND position <= ? AND item_type IN "
                            "('user_message', 'assistant_message') AND content != '' "
                            "ORDER BY position, id",
                            (product_thread_id, base_position),
                        )
                    ).fetchall()
                    authoritative_history = [
                        {
                            "role": "user" if row["item_type"] == "user_message" else "assistant",
                            "content": str(row["content"]),
                        }
                        for row in history_rows
                    ]

                assistant_item_id = (
                    _principal_item_id(principal_id, assistant_message_id)
                    if assistant_message_id is not None
                    else _new_id("item")
                )
                run = self._new_run_record(
                    principal_id=principal_id,
                    goal=goal,
                    workspace_path=workspace_path,
                    parent_run_id=parent_run_id,
                    settings=settings,
                    metadata=metadata,
                    mode=mode,
                    history=authoritative_history,
                    thread_id=product_thread_id,
                    assistant_item_id=assistant_item_id,
                    user_input=user_input,
                    graph_thread_id=graph_thread_id,
                    graph_checkpoint_id=graph_checkpoint_id,
                    graph_definition_id=graph_definition_id,
                    graph_input_kind=graph_input_kind,
                )
                await self._insert_run(transaction_conn, run)
                if replace_from_client_id is not None:
                    await transaction_conn.execute(
                        "UPDATE local_thread_items SET superseded_at = ?, "
                        "superseded_by_run_id = ?, updated_at = ? "
                        "WHERE thread_id = ? AND position > ? AND superseded_at IS NULL",
                        (now, run["id"], now, product_thread_id, base_position),
                    )
                await transaction_conn.executemany(
                    "INSERT INTO local_thread_items "
                    "(id, thread_id, run_id, client_id, item_type, status, content, "
                    "metadata_json, position, version, created_at, updated_at, completed_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
                    (
                        (
                            _new_id("item"),
                            product_thread_id,
                            run["id"],
                            client_message_id,
                            "user_message",
                            "completed",
                            user_input or goal,
                            _encode_payload(user_item_metadata or {}),
                            base_position + 1,
                            now,
                            now,
                            now,
                        ),
                        (
                            assistant_item_id,
                            product_thread_id,
                            run["id"],
                            assistant_message_id,
                            "assistant_message",
                            "in_progress",
                            "",
                            "{}",
                            base_position + 2,
                            now,
                            now,
                            None,
                        ),
                    ),
                )
                await transaction_conn.execute(
                    "INSERT INTO local_thread_changes "
                    "(principal_id, thread_id, thread_version, change_type, run_id, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        principal_id,
                        product_thread_id,
                        thread_version,
                        "thread.rewritten"
                        if replace_from_client_id is not None
                        else "turn.started",
                        run["id"],
                        now,
                    ),
                )
                await self._insert_run_job(
                    transaction_conn,
                    self._new_run_job_record(
                        run_id=run["id"],
                        kind="start",
                        input_payload={
                            "principal_id": principal_id,
                            "goal": goal,
                            "user_input": user_input or goal,
                            "workspace_path": workspace_path,
                            "mode": mode,
                            "history": authoritative_history,
                            "settings": settings or {},
                            "metadata": metadata or {},
                        },
                    ),
                )
                await transaction_conn.execute(
                    "INSERT INTO local_commands "
                    "(principal_id, id, command_type, client_message_id, payload_json, "
                    "response_json, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        principal_id,
                        command_id,
                        str(command_payload.get("type") or "run.start"),
                        client_message_id,
                        payload_json,
                        _encode_payload(run),
                        run["id"],
                        run["created_at"],
                    ),
                )
                await transaction_conn.commit()
                return {
                    **run,
                    "command_id": command_id,
                    "client_message_id": client_message_id,
                }, True
            except BaseException:
                await transaction_conn.rollback()
                raise

    async def enqueue_run_job(
        self,
        run_id: str,
        *,
        kind: str,
        resume_payload: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        existing_run = await self.get_run(run_id)
        if existing_run is None:
            return None
        path_error = await self._workspace_path_error(existing_run.get("workspace_path"))
        if path_error is not None:
            raise WorkspaceAdmissionError(path_error)
        async with aiosqlite.connect(str(self._db_path)) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA busy_timeout=5000")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                row = await (
                    await conn.execute("SELECT * FROM local_runs WHERE id = ?", (run_id,))
                ).fetchone()
                if row is None:
                    await conn.rollback()
                    return None
                run = dict(row)
                workspace_error = await self._workspace_owner_error(
                    conn,
                    principal_id=str(run["principal_id"]),
                    path=run["workspace_path"],
                )
                if workspace_error is not None:
                    raise WorkspaceAdmissionError(workspace_error)
                active = await (
                    await conn.execute(
                        "SELECT * FROM local_run_jobs WHERE run_id = ? "
                        "AND status IN ('pending', 'leased')",
                        (run_id,),
                    )
                ).fetchone()
                if active is not None:
                    await conn.rollback()
                    return dict(active)
                job = self._new_run_job_record(
                    run_id=run_id,
                    kind=kind,
                    input_payload=self._run_job_input(run),
                    resume_payload=resume_payload,
                )
                await self._insert_run_job(conn, job)
                await conn.commit()
                return job
            except BaseException:
                await conn.rollback()
                raise

    async def get_active_run_job(self, run_id: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM local_run_jobs WHERE run_id = ? "
            "AND status IN ('pending', 'leased') AND quarantined_at IS NULL",
            (run_id,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def get_run_job(self, job_id: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM local_run_jobs WHERE id = ?",
            (job_id,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def _requeue_expired_jobs_uncommitted(
        self,
        conn: aiosqlite.Connection,
        now: str,
    ) -> None:
        expired = await (
            await conn.execute(
                "SELECT local_run_jobs.*, local_runs.status AS run_status "
                "FROM local_run_jobs JOIN local_runs ON local_runs.id = local_run_jobs.run_id "
                "WHERE local_run_jobs.status = 'leased' "
                "AND local_run_jobs.lease_expires_at <= ? "
                "ORDER BY local_run_jobs.lease_expires_at, local_run_jobs.id",
                (now,),
            )
        ).fetchall()
        for expired_row in expired:
            job = dict(expired_row)
            execution_attempt_id = f"{job['id']}:{job['lease_generation']}"
            await conn.execute(
                "UPDATE local_model_calls SET status = 'outcome_unknown', completed_at = ? "
                "WHERE run_id = ? AND execution_attempt_id = ? "
                "AND status IN ('reserved', 'streaming')",
                (now, job["run_id"], execution_attempt_id),
            )
            await conn.execute(
                "UPDATE local_tool_receipts SET status = 'outcome_unknown', "
                "error_type = 'execution_lease_expired', updated_at = ?, completed_at = ? "
                "WHERE run_id = ? AND execution_attempt_id = ? AND status = 'running'",
                (now, now, job["run_id"], execution_attempt_id),
            )
            settled_job_status = {
                "completed": "completed",
                "failed": "dead",
                "canceled": "canceled",
                "waiting_permission": "completed",
                "waiting_input": "completed",
            }.get(str(job["run_status"]))
            if settled_job_status is not None:
                await conn.execute(
                    "UPDATE local_run_jobs SET status = ?, updated_at = ?, finished_at = ?, "
                    "lease_owner = NULL, lease_expires_at = NULL "
                    "WHERE id = ? AND status = 'leased'",
                    (settled_job_status, now, now, job["id"]),
                )
                continue
            await conn.execute(
                "UPDATE local_run_jobs SET quarantined_at = ?, "
                "quarantine_reason = 'execution_lease_expired', "
                "lease_expires_at = NULL, updated_at = ? "
                "WHERE id = ? AND status = 'leased'",
                (now, now, job["id"]),
            )
            await conn.execute(
                "UPDATE local_runs SET status = 'cleanup_required', updated_at = ?, "
                "completed_at = NULL "
                "WHERE id = ?",
                (now, job["run_id"]),
            )
            cleanup_payload = {
                "error": "The execution lease expired before the Runtime could prove that external work stopped. This run is quarantined and cannot be retried automatically.",
                "type": "ExecutionLeaseExpiredError",
                "retryable": False,
                "category": "execution_lease_expired",
                "cleanup": {"status": "unconfirmed"},
            }
            event = await self._append_event_uncommitted(
                conn,
                job["run_id"],
                "run.cleanup_required",
                payload_json=_encode_payload(cleanup_payload),
                created_at=now,
            )
            await self._update_thread_projection_uncommitted(
                conn,
                run_id=job["run_id"],
                run_status="cleanup_required",
                change_type="run.cleanup_required",
                payload=cleanup_payload,
                event_high_watermark=int(event["seq"]),
                changed_at=now,
            )

    async def claim_run_job(
        self,
        *,
        worker_id: str,
        lease_seconds: float = 30.0,
    ) -> dict[str, Any] | None:
        async with aiosqlite.connect(str(self._db_path)) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA busy_timeout=5000")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                now = _now()
                await self._requeue_expired_jobs_uncommitted(conn, now)
                row = await (
                    await conn.execute(
                        "SELECT * FROM local_run_jobs WHERE status = 'pending' "
                        "ORDER BY created_at, id LIMIT 1"
                    )
                ).fetchone()
                if row is None:
                    await conn.commit()
                    return None
                job = dict(row)
                expires_at = (datetime.now(UTC) + timedelta(seconds=lease_seconds)).isoformat()
                await conn.execute(
                    "UPDATE local_run_jobs SET status = 'leased', lease_owner = ?, "
                    "lease_generation = lease_generation + 1, lease_expires_at = ?, "
                    "attempt = attempt + 1, updated_at = ? WHERE id = ? AND status = 'pending'",
                    (worker_id, expires_at, now, job["id"]),
                )
                await conn.execute(
                    "UPDATE local_runs SET status = 'running', updated_at = ?, completed_at = NULL "
                    "WHERE id = ?",
                    (now, job["run_id"]),
                )
                claimed = await (
                    await conn.execute("SELECT * FROM local_run_jobs WHERE id = ?", (job["id"],))
                ).fetchone()
                await conn.commit()
                return dict(claimed) if claimed else None
            except BaseException:
                await conn.rollback()
                raise

    async def renew_run_job(
        self,
        job_id: str,
        *,
        lease_owner: str,
        lease_generation: int,
        lease_seconds: float = 30.0,
    ) -> tuple[bool, bool]:
        renewed_at = _now()
        expires_at = (datetime.now(UTC) + timedelta(seconds=lease_seconds)).isoformat()
        async with aiosqlite.connect(str(self._db_path)) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA busy_timeout=5000")
            await conn.execute("BEGIN IMMEDIATE")
            cursor = await conn.execute(
                "UPDATE local_run_jobs SET lease_expires_at = ?, updated_at = ? "
                "WHERE id = ? AND status = 'leased' AND lease_owner = ? "
                "AND lease_generation = ? AND quarantined_at IS NULL "
                "AND lease_expires_at > ?",
                (
                    expires_at,
                    renewed_at,
                    job_id,
                    lease_owner,
                    lease_generation,
                    renewed_at,
                ),
            )
            if cursor.rowcount != 1:
                await conn.rollback()
                return False, False
            row = await (
                await conn.execute(
                    "SELECT cancel_requested_at FROM local_run_jobs WHERE id = ?", (job_id,)
                )
            ).fetchone()
            await conn.commit()
            return True, bool(row and row[0])

    async def quarantine_execution_attempt(
        self,
        run_id: str,
        *,
        reason: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Fence an attempt whose resource stillness cannot be proven.

        The job intentionally remains leased to its exact owner/generation,
        but with no renewable expiry. It therefore blocks new attempts while
        allowing that original owner to submit a final cleanup confirmation.
        """
        lease = _CURRENT_EXECUTION_LEASE.get()
        if lease is None or lease.run_id != run_id:
            raise LeaseFenceError("execution quarantine requires the current run lease")
        now = _now()
        async with self.run_write_transaction(run_id, lease=lease) as conn:
            execution_attempt_id = f"{lease.job_id}:{lease.lease_generation}"
            await conn.execute(
                "UPDATE local_model_calls SET status = 'outcome_unknown', completed_at = ? "
                "WHERE run_id = ? AND execution_attempt_id = ? "
                "AND status IN ('reserved', 'streaming')",
                (now, run_id, execution_attempt_id),
            )
            await conn.execute(
                "UPDATE local_tool_receipts SET status = 'outcome_unknown', "
                "error_type = ?, updated_at = ?, completed_at = ? "
                "WHERE run_id = ? AND execution_attempt_id = ? AND status = 'running'",
                (reason, now, now, run_id, execution_attempt_id),
            )
            await conn.execute(
                "UPDATE local_runs SET status = 'cleanup_required', updated_at = ?, "
                "completed_at = NULL WHERE id = ?",
                (now, run_id),
            )
            event = await self._append_event_uncommitted(
                conn,
                run_id,
                "run.cleanup_required",
                payload_json=_encode_payload(payload),
                created_at=now,
            )
            await self._update_thread_projection_uncommitted(
                conn,
                run_id=run_id,
                run_status="cleanup_required",
                change_type="run.cleanup_required",
                payload=payload,
                event_high_watermark=int(event["seq"]),
                changed_at=now,
            )
            cursor = await conn.execute(
                "UPDATE local_run_jobs SET quarantined_at = ?, quarantine_reason = ?, "
                "lease_expires_at = NULL, updated_at = ? WHERE id = ? AND run_id = ? "
                "AND status = 'leased' AND lease_owner = ? AND lease_generation = ?",
                (
                    now,
                    reason,
                    now,
                    lease.job_id,
                    run_id,
                    lease.lease_owner,
                    lease.lease_generation,
                ),
            )
            if cursor.rowcount != 1:
                raise LeaseFenceError("execution attempt could not be quarantined")
            return event

    async def confirm_quarantined_cleanup(
        self,
        run_id: str,
        *,
        job_id: str,
        lease_owner: str,
        lease_generation: int,
        payload: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Let only the quarantined owner close its attempt after cleanup."""
        now = _now()
        async with aiosqlite.connect(str(self._db_path)) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA busy_timeout=5000")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                row = await (
                    await conn.execute(
                        "SELECT 1 FROM local_run_jobs WHERE id = ? AND run_id = ? "
                        "AND status = 'leased' AND lease_owner = ? AND lease_generation = ? "
                        "AND quarantined_at IS NOT NULL",
                        (job_id, run_id, lease_owner, lease_generation),
                    )
                ).fetchone()
                if row is None:
                    await conn.rollback()
                    return None
                await conn.execute(
                    "UPDATE local_runs SET status = 'failed', updated_at = ?, completed_at = ? "
                    "WHERE id = ? AND status = 'cleanup_required'",
                    (now, now, run_id),
                )
                event = await self._append_event_uncommitted(
                    conn,
                    run_id,
                    "run.failed",
                    payload_json=_encode_payload(payload),
                    created_at=now,
                )
                await self._update_thread_projection_uncommitted(
                    conn,
                    run_id=run_id,
                    run_status="failed",
                    change_type="run.failed",
                    payload=payload,
                    event_high_watermark=int(event["seq"]),
                    changed_at=now,
                )
                await conn.execute(
                    "UPDATE local_run_jobs SET status = 'dead', updated_at = ?, "
                    "finished_at = ?, lease_expires_at = NULL WHERE id = ?",
                    (now, now, job_id),
                )
                await conn.commit()
                return event
            except BaseException:
                await conn.rollback()
                raise

    async def ensure_lost_execution_quarantined(
        self,
        run_id: str,
        *,
        job_id: str,
        lease_owner: str,
        lease_generation: int,
    ) -> tuple[bool, dict[str, Any] | None]:
        """Atomically record lease loss before an exact owner confirms cleanup.

        Heartbeat can observe expiry before the dispatcher/reaper does. This
        method closes that ordering window: the exact old generation may turn
        its expired lease into quarantine, settle uncertain ledgers, and then
        submit its already-completed cleanup proof. A crash between these two
        calls leaves a safe quarantine rather than a claimable job.
        """
        now = _now()
        async with aiosqlite.connect(str(self._db_path)) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA busy_timeout=5000")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                row = await (
                    await conn.execute(
                        "SELECT * FROM local_run_jobs WHERE id = ? AND run_id = ? "
                        "AND status = 'leased' AND lease_owner = ? AND lease_generation = ?",
                        (job_id, run_id, lease_owner, lease_generation),
                    )
                ).fetchone()
                if row is None:
                    await conn.rollback()
                    return False, None
                job = dict(row)
                already_quarantined = job.get("quarantined_at") is not None
                if not already_quarantined and str(job.get("lease_expires_at") or "") > now:
                    await conn.rollback()
                    return False, None
                execution_attempt_id = f"{job_id}:{lease_generation}"
                await conn.execute(
                    "UPDATE local_model_calls SET status = 'outcome_unknown', completed_at = ? "
                    "WHERE run_id = ? AND execution_attempt_id = ? "
                    "AND status IN ('reserved', 'streaming')",
                    (now, run_id, execution_attempt_id),
                )
                await conn.execute(
                    "UPDATE local_tool_receipts SET status = 'outcome_unknown', "
                    "error_type = 'execution_lease_expired', updated_at = ?, completed_at = ? "
                    "WHERE run_id = ? AND execution_attempt_id = ? AND status = 'running'",
                    (now, now, run_id, execution_attempt_id),
                )
                event: dict[str, Any] | None = None
                if not already_quarantined:
                    await conn.execute(
                        "UPDATE local_run_jobs SET quarantined_at = ?, "
                        "quarantine_reason = 'execution_lease_expired', "
                        "lease_expires_at = NULL, updated_at = ? WHERE id = ?",
                        (now, now, job_id),
                    )
                    await conn.execute(
                        "UPDATE local_runs SET status = 'cleanup_required', updated_at = ?, "
                        "completed_at = NULL WHERE id = ?",
                        (now, run_id),
                    )
                    event = await self._append_event_uncommitted(
                        conn,
                        run_id,
                        "run.cleanup_required",
                        payload_json=_encode_payload(
                            {
                                "error": "The execution lease expired before the Runtime could prove that external work stopped. This run is quarantined and cannot be retried automatically.",
                                "type": "ExecutionLeaseExpiredError",
                                "retryable": False,
                                "category": "execution_lease_expired",
                                "cleanup": {"status": "unconfirmed"},
                            }
                        ),
                        created_at=now,
                    )
                    await self._update_thread_projection_uncommitted(
                        conn,
                        run_id=run_id,
                        run_status="cleanup_required",
                        change_type="run.cleanup_required",
                        payload={
                            "error": "The execution lease expired before the Runtime could prove that external work stopped. This run is quarantined and cannot be retried automatically.",
                            "type": "ExecutionLeaseExpiredError",
                            "retryable": False,
                            "category": "execution_lease_expired",
                            "cleanup": {"status": "unconfirmed"},
                        },
                        event_high_watermark=int(event["seq"]),
                        changed_at=now,
                    )
                await conn.commit()
                return True, event
            except BaseException:
                await conn.rollback()
                raise

    async def finish_run_job(
        self,
        job_id: str,
        *,
        lease_owner: str,
        lease_generation: int,
        status: str,
    ) -> bool:
        if status not in {"completed", "canceled", "dead"}:
            raise ValueError(f"invalid finished job status: {status}")
        finished_at = _now()
        async with aiosqlite.connect(str(self._db_path)) as conn:
            await conn.execute("PRAGMA busy_timeout=5000")
            await conn.execute("BEGIN IMMEDIATE")
            cursor = await conn.execute(
                "UPDATE local_run_jobs SET status = ?, updated_at = ?, finished_at = ?, "
                "lease_expires_at = NULL WHERE id = ? AND status = 'leased' "
                "AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?",
                (
                    status,
                    finished_at,
                    finished_at,
                    job_id,
                    lease_owner,
                    lease_generation,
                    finished_at,
                ),
            )
            await conn.commit()
            return cursor.rowcount == 1

    async def request_run_cancel(self, run_id: str) -> str | None:
        async with aiosqlite.connect(str(self._db_path)) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA busy_timeout=5000")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                state = await self._request_run_cancel_uncommitted(conn, run_id)
                if state is None:
                    await conn.rollback()
                    return None
                await conn.commit()
                return state
            except BaseException:
                await conn.rollback()
                raise

    async def request_run_cancel_command(
        self,
        *,
        principal_id: str,
        command_id: str,
        run_id: str,
    ) -> tuple[dict[str, Any], bool]:
        payload_json = _encode_payload({"type": "run.cancel", "run_id": run_id})
        async with aiosqlite.connect(str(self._db_path)) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA busy_timeout=5000")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                existing = await self._accepted_command_receipt_uncommitted(
                    conn,
                    principal_id=principal_id,
                    command_id=command_id,
                    command_type="run.cancel",
                    payload_json=payload_json,
                )
                if existing is not None:
                    await conn.rollback()
                    return existing, False
                run = await (
                    await conn.execute(
                        "SELECT id, created_at FROM local_runs WHERE principal_id = ? AND id = ?",
                        (principal_id, run_id),
                    )
                ).fetchone()
                if run is None:
                    raise KeyError(f"unknown run: {run_id}")
                state = await self._request_run_cancel_uncommitted(conn, run_id)
                receipt = {
                    "type": "run.cancel",
                    "command_id": command_id,
                    "run_id": run_id,
                    "canceled": state is not None,
                }
                await conn.execute(
                    "INSERT INTO local_commands "
                    "(principal_id, id, command_type, client_message_id, payload_json, "
                    "response_json, run_id, created_at) VALUES (?, ?, 'run.cancel', '', ?, ?, ?, ?)",
                    (
                        principal_id,
                        command_id,
                        payload_json,
                        _encode_payload(receipt),
                        run_id,
                        _now(),
                    ),
                )
                await conn.commit()
                return receipt, True
            except BaseException:
                await conn.rollback()
                raise

    async def request_question_answer_command(
        self,
        *,
        principal_id: str,
        command_id: str,
        question_id: str,
        answers: dict[str, list[str]],
    ) -> tuple[dict[str, Any], bool]:
        payload_json = _encode_payload(
            {"type": "question.answer", "question_id": question_id, "answers": answers}
        )
        answers_json = json.dumps(
            answers,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        async with aiosqlite.connect(str(self._db_path)) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA busy_timeout=5000")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                existing = await self._accepted_command_receipt_uncommitted(
                    conn,
                    principal_id=principal_id,
                    command_id=command_id,
                    command_type="question.answer",
                    payload_json=payload_json,
                )
                if existing is not None:
                    await conn.rollback()
                    return existing, False

                record = await (
                    await conn.execute(
                        "SELECT q.run_id, q.wait_cycle_id, q.status AS question_status, "
                        "q.answers_json, r.status AS run_status, r.principal_id, "
                        "r.goal, r.user_input, r.workspace_path, r.mode, r.history_json, "
                        "r.settings_json, r.metadata_json "
                        "FROM local_questions q JOIN local_runs r ON r.id = q.run_id "
                        "WHERE q.id = ? AND r.principal_id = ?",
                        (question_id, principal_id),
                    )
                ).fetchone()
                if record is None:
                    raise KeyError(f"unknown question: {question_id}")
                run_id = str(record["run_id"])
                workspace_error = await self._workspace_owner_error(
                    conn,
                    principal_id=principal_id,
                    path=record["workspace_path"],
                ) or await self._workspace_path_error(record["workspace_path"])
                if workspace_error is not None:
                    raise WorkspaceAdmissionError(workspace_error)

                if record["question_status"] == "pending":
                    if record["run_status"] not in {"waiting_permission", "waiting_input"}:
                        raise WaitDecisionConflictError("run is not awaiting a question answer")
                    now = _now()
                    question_cursor = await conn.execute(
                        "UPDATE local_questions SET status = 'answered', answers_json = ?, "
                        "answered_at = ? WHERE id = ? AND status = 'pending'",
                        (answers_json, now, question_id),
                    )
                    wait_cursor = await conn.execute(
                        "UPDATE local_wait_candidates SET status = 'resolved', "
                        "decision_json = ?, resolved_at = ? "
                        "WHERE id = ? AND status = 'pending'",
                        (answers_json, now, question_id),
                    )
                    if question_cursor.rowcount != 1 or wait_cursor.rowcount != 1:
                        raise WaitDecisionConflictError("question was answered concurrently")
                    await self._append_event_uncommitted(
                        conn,
                        run_id,
                        "question.answered",
                        payload_json=_encode_payload(
                            {"request_id": question_id, "answers": answers}
                        ),
                        created_at=now,
                    )
                elif (
                    record["question_status"] != "answered"
                    or str(record["answers_json"] or "") != answers_json
                ):
                    raise WaitDecisionConflictError(
                        "question was already resolved with different content"
                    )

                resume_payload = await self._wait_cycle_resume_payload_uncommitted(
                    conn,
                    run_id=run_id,
                    wait_cycle_id=str(record["wait_cycle_id"]),
                )
                resumed = record["run_status"] in {
                    "queued",
                    "running",
                    "completed",
                    "failed",
                }
                if (
                    record["run_status"] in {"waiting_permission", "waiting_input"}
                    and resume_payload is not None
                ):
                    active_job = await (
                        await conn.execute(
                            "SELECT * FROM local_run_jobs WHERE run_id = ? "
                            "AND status IN ('pending', 'leased')",
                            (run_id,),
                        )
                    ).fetchone()
                    if active_job is None:
                        job = self._new_run_job_record(
                            run_id=run_id,
                            kind="resume",
                            input_payload=self._run_job_input(dict(record)),
                            resume_payload=resume_payload,
                        )
                        await self._insert_run_job(conn, job)
                    elif active_job["kind"] != "resume":
                        raise WaitDecisionConflictError("run already has a different active job")
                    resumed = True

                receipt = {
                    "type": "question.answer",
                    "command_id": command_id,
                    "question_id": question_id,
                    "run_id": run_id,
                    "answered": True,
                    "resumed": resumed,
                }
                await conn.execute(
                    "INSERT INTO local_commands "
                    "(principal_id, id, command_type, client_message_id, payload_json, "
                    "response_json, run_id, created_at) "
                    "VALUES (?, ?, 'question.answer', '', ?, ?, ?, ?)",
                    (
                        principal_id,
                        command_id,
                        payload_json,
                        _encode_payload(receipt),
                        run_id,
                        _now(),
                    ),
                )
                await conn.commit()
                return receipt, True
            except BaseException:
                await conn.rollback()
                raise

    async def request_permission_resolve_command(
        self,
        *,
        principal_id: str,
        command_id: str,
        permission_id: str,
        decision: str,
        scope: str,
        edited_action: dict[str, Any] | None,
    ) -> tuple[dict[str, Any], bool]:
        command_payload: dict[str, Any] = {
            "type": "permission.resolve",
            "permission_id": permission_id,
            "decision": decision,
            "scope": scope,
        }
        if edited_action is not None:
            command_payload["edited_action"] = edited_action
        payload_json = _encode_payload(command_payload)
        if decision == "approve":
            hitl_decision: dict[str, Any] = {"type": "approve"}
            permission_status = "approved"
        elif decision == "edit":
            hitl_decision = {"type": "edit", "edited_action": edited_action}
            permission_status = "approved"
        else:
            hitl_decision = {
                "type": "reject",
                "message": "Tool execution denied by user.",
            }
            permission_status = "denied"
        decision_json = _encode_payload(hitl_decision)
        grant_max_uses = 20 if scope == "run" and permission_status == "approved" else 0
        grant_expires_at = (
            (datetime.now(UTC) + timedelta(hours=24)).isoformat() if grant_max_uses else None
        )

        async with aiosqlite.connect(str(self._db_path)) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA busy_timeout=5000")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                existing = await self._accepted_command_receipt_uncommitted(
                    conn,
                    principal_id=principal_id,
                    command_id=command_id,
                    command_type="permission.resolve",
                    payload_json=payload_json,
                )
                if existing is not None:
                    await conn.rollback()
                    return existing, False

                record = await (
                    await conn.execute(
                        "SELECT p.run_id, p.wait_cycle_id, p.status AS permission_status, "
                        "p.scope AS permission_scope, p.decision_json, p.tool_name, "
                        "p.operation_id, r.status AS run_status, r.principal_id, "
                        "r.goal, r.user_input, r.workspace_path, r.mode, r.history_json, "
                        "r.settings_json, r.metadata_json "
                        "FROM local_permissions p JOIN local_runs r ON r.id = p.run_id "
                        "WHERE p.id = ? AND r.principal_id = ?",
                        (permission_id, principal_id),
                    )
                ).fetchone()
                if record is None:
                    raise KeyError(f"unknown permission: {permission_id}")
                run_id = str(record["run_id"])
                workspace_error = await self._workspace_owner_error(
                    conn,
                    principal_id=principal_id,
                    path=record["workspace_path"],
                ) or await self._workspace_path_error(record["workspace_path"])
                if workspace_error is not None:
                    raise WorkspaceAdmissionError(workspace_error)
                if decision == "edit" and (
                    edited_action is None or edited_action.get("name") != record["tool_name"]
                ):
                    raise WaitDecisionConflictError("tool name cannot be changed")

                if record["permission_status"] == "pending":
                    if record["run_status"] not in {"waiting_permission", "waiting_input"}:
                        raise WaitDecisionConflictError("run is not awaiting a permission decision")
                    now = _now()
                    permission_cursor = await conn.execute(
                        "UPDATE local_permissions SET status = ?, scope = ?, decision_json = ?, "
                        "grant_max_uses = ?, grant_expires_at = ?, resolved_at = ? "
                        "WHERE id = ? AND status = 'pending'",
                        (
                            permission_status,
                            scope,
                            decision_json,
                            grant_max_uses,
                            grant_expires_at,
                            now,
                            permission_id,
                        ),
                    )
                    wait_cursor = await conn.execute(
                        "UPDATE local_wait_candidates SET status = 'resolved', "
                        "decision_json = ?, resolved_at = ? "
                        "WHERE id = ? AND status = 'pending'",
                        (decision_json, now, permission_id),
                    )
                    if permission_cursor.rowcount != 1 or wait_cursor.rowcount != 1:
                        raise WaitDecisionConflictError("permission was resolved concurrently")
                    await self._append_event_uncommitted(
                        conn,
                        run_id,
                        "permission.resolved",
                        payload_json=_encode_payload(
                            {
                                "request_id": permission_id,
                                "tool": record["tool_name"],
                                "tool_name": record["tool_name"],
                                "operation_id": record["operation_id"],
                                "decision": decision,
                                "scope": scope,
                            }
                        ),
                        created_at=now,
                    )
                elif (
                    record["permission_status"] != permission_status
                    or record["permission_scope"] != scope
                    or str(record["decision_json"] or "") != decision_json
                ):
                    raise WaitDecisionConflictError(
                        "permission was already resolved with a different decision"
                    )

                resume_payload = await self._wait_cycle_resume_payload_uncommitted(
                    conn,
                    run_id=run_id,
                    wait_cycle_id=str(record["wait_cycle_id"]),
                )
                resumed = record["run_status"] in {
                    "queued",
                    "running",
                    "completed",
                    "failed",
                }
                if (
                    record["run_status"] in {"waiting_permission", "waiting_input"}
                    and resume_payload is not None
                ):
                    active_job = await (
                        await conn.execute(
                            "SELECT * FROM local_run_jobs WHERE run_id = ? "
                            "AND status IN ('pending', 'leased')",
                            (run_id,),
                        )
                    ).fetchone()
                    if active_job is None:
                        job = self._new_run_job_record(
                            run_id=run_id,
                            kind="resume",
                            input_payload=self._run_job_input(dict(record)),
                            resume_payload=resume_payload,
                        )
                        await self._insert_run_job(conn, job)
                    elif active_job["kind"] != "resume":
                        raise WaitDecisionConflictError("run already has a different active job")
                    resumed = True

                receipt = {
                    "type": "permission.resolve",
                    "command_id": command_id,
                    "permission_id": permission_id,
                    "run_id": run_id,
                    "resolved": True,
                    "decision": decision,
                    "scope": scope,
                    "resumed": resumed,
                }
                await conn.execute(
                    "INSERT INTO local_commands "
                    "(principal_id, id, command_type, client_message_id, payload_json, "
                    "response_json, run_id, created_at) "
                    "VALUES (?, ?, 'permission.resolve', '', ?, ?, ?, ?)",
                    (
                        principal_id,
                        command_id,
                        payload_json,
                        _encode_payload(receipt),
                        run_id,
                        _now(),
                    ),
                )
                await conn.commit()
                return receipt, True
            except BaseException:
                await conn.rollback()
                raise

    async def request_plan_resolve_command(
        self,
        *,
        principal_id: str,
        command_id: str,
        approval_id: str,
        decision: str,
        instructions: str | None,
    ) -> tuple[dict[str, Any], bool]:
        command_payload: dict[str, Any] = {
            "type": "plan.resolve",
            "approval_id": approval_id,
            "decision": decision,
        }
        if instructions is not None:
            command_payload["instructions"] = instructions
        payload_json = _encode_payload(command_payload)
        status = {
            "approve": "approved",
            "modify": "modified",
            "reject": "rejected",
        }[decision]
        resume_decision = {
            "approval_id": approval_id,
            "decision": decision,
            "instructions": instructions,
        }
        decision_json = _encode_payload(resume_decision)

        async with aiosqlite.connect(str(self._db_path)) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA busy_timeout=5000")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                existing = await self._accepted_command_receipt_uncommitted(
                    conn,
                    principal_id=principal_id,
                    command_id=command_id,
                    command_type="plan.resolve",
                    payload_json=payload_json,
                )
                if existing is not None:
                    await conn.rollback()
                    return existing, False

                record = await (
                    await conn.execute(
                        "SELECT p.run_id, p.wait_cycle_id, p.status AS approval_status, "
                        "p.instructions AS approval_instructions, "
                        "r.status AS run_status, r.principal_id, r.goal, r.user_input, r.workspace_path, "
                        "r.mode, r.history_json, r.settings_json, r.metadata_json "
                        "FROM local_plan_approvals p JOIN local_runs r ON r.id = p.run_id "
                        "WHERE p.id = ? AND r.principal_id = ?",
                        (approval_id, principal_id),
                    )
                ).fetchone()
                if record is None:
                    raise KeyError(f"unknown plan approval: {approval_id}")
                run_id = str(record["run_id"])
                workspace_error = await self._workspace_owner_error(
                    conn,
                    principal_id=principal_id,
                    path=record["workspace_path"],
                ) or await self._workspace_path_error(record["workspace_path"])
                if workspace_error is not None:
                    raise WorkspaceAdmissionError(workspace_error)

                if record["approval_status"] == "pending":
                    if record["run_status"] not in {"waiting_permission", "waiting_input"}:
                        raise WaitDecisionConflictError(
                            "run is not awaiting a plan approval decision"
                        )
                    now = _now()
                    approval_cursor = await conn.execute(
                        "UPDATE local_plan_approvals SET status = ?, instructions = ?, "
                        "resolved_at = ? WHERE id = ? AND status = 'pending'",
                        (status, instructions, now, approval_id),
                    )
                    wait_cursor = await conn.execute(
                        "UPDATE local_wait_candidates SET status = 'resolved', "
                        "decision_json = ?, resolved_at = ? "
                        "WHERE id = ? AND status = 'pending'",
                        (decision_json, now, approval_id),
                    )
                    if approval_cursor.rowcount != 1 or wait_cursor.rowcount != 1:
                        raise WaitDecisionConflictError("plan approval was resolved concurrently")
                    await self._append_event_uncommitted(
                        conn,
                        run_id,
                        "plan.approval_resolved",
                        payload_json=_encode_payload(
                            {
                                "request_id": approval_id,
                                "decision": decision,
                                "instructions": instructions,
                            }
                        ),
                        created_at=now,
                    )
                elif (
                    record["approval_status"] != status
                    or record["approval_instructions"] != instructions
                ):
                    raise WaitDecisionConflictError(
                        "plan approval was already resolved with a different decision"
                    )

                resume_payload = await self._wait_cycle_resume_payload_uncommitted(
                    conn,
                    run_id=run_id,
                    wait_cycle_id=str(record["wait_cycle_id"]),
                )
                resumed = record["run_status"] in {
                    "queued",
                    "running",
                    "completed",
                    "failed",
                }
                if (
                    record["run_status"] in {"waiting_permission", "waiting_input"}
                    and resume_payload is not None
                ):
                    active_job = await (
                        await conn.execute(
                            "SELECT * FROM local_run_jobs WHERE run_id = ? "
                            "AND status IN ('pending', 'leased')",
                            (run_id,),
                        )
                    ).fetchone()
                    if active_job is None:
                        job = self._new_run_job_record(
                            run_id=run_id,
                            kind="resume",
                            input_payload=self._run_job_input(dict(record)),
                            resume_payload=resume_payload,
                        )
                        await self._insert_run_job(conn, job)
                    elif active_job["kind"] != "resume":
                        raise WaitDecisionConflictError("run already has a different active job")
                    resumed = True

                receipt = {
                    "type": "plan.resolve",
                    "command_id": command_id,
                    "approval_id": approval_id,
                    "run_id": run_id,
                    "resolved": True,
                    "decision": decision,
                    "instructions": instructions,
                    "resumed": resumed,
                }
                await conn.execute(
                    "INSERT INTO local_commands "
                    "(principal_id, id, command_type, client_message_id, payload_json, "
                    "response_json, run_id, created_at) "
                    "VALUES (?, ?, 'plan.resolve', '', ?, ?, ?, ?)",
                    (
                        principal_id,
                        command_id,
                        payload_json,
                        _encode_payload(receipt),
                        run_id,
                        _now(),
                    ),
                )
                await conn.commit()
                return receipt, True
            except BaseException:
                await conn.rollback()
                raise

    async def request_tool_reconcile_command(
        self,
        *,
        principal_id: str,
        command_id: str,
        operation_id: str,
        decision: str,
        current_result_json: str | None,
        current_result_hash: str | None,
        prior_result_json: str,
        prior_result_hash: str,
    ) -> tuple[dict[str, Any], bool]:
        payload_json = _encode_payload(
            {
                "type": "tool.reconcile",
                "operation_id": operation_id,
                "decision": decision,
            }
        )
        async with aiosqlite.connect(str(self._db_path)) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA busy_timeout=5000")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                existing = await self._accepted_command_receipt_uncommitted(
                    conn,
                    principal_id=principal_id,
                    command_id=command_id,
                    command_type="tool.reconcile",
                    payload_json=payload_json,
                )
                if existing is not None:
                    await conn.rollback()
                    return existing, False

                record = await (
                    await conn.execute(
                        "SELECT c.*, r.status AS run_status, r.principal_id, r.goal, "
                        "r.user_input, r.workspace_path, r.mode, r.history_json, "
                        "r.settings_json, r.metadata_json "
                        "FROM local_wait_candidates c JOIN local_runs r ON r.id = c.run_id "
                        "WHERE c.id = ? AND c.kind = 'tool_reconciliation' "
                        "AND r.principal_id = ?",
                        (operation_id, principal_id),
                    )
                ).fetchone()
                if record is None:
                    raise KeyError(f"unknown tool reconciliation: {operation_id}")
                run_id = str(record["run_id"])
                workspace_error = await self._workspace_owner_error(
                    conn,
                    principal_id=principal_id,
                    path=record["workspace_path"],
                ) or await self._workspace_path_error(record["workspace_path"])
                if workspace_error is not None:
                    raise WorkspaceAdmissionError(workspace_error)
                if record["status"] == "pending" and record["run_status"] not in {
                    "waiting_permission",
                    "waiting_input",
                }:
                    raise WaitDecisionConflictError(
                        "run is not awaiting a tool reconciliation decision"
                    )

                updated, newly_resolved = await self._resolve_tool_reconciliation_uncommitted(
                    conn,
                    candidate_id=operation_id,
                    decision=decision,
                    current_result_json=current_result_json,
                    current_result_hash=current_result_hash,
                    prior_result_json=prior_result_json,
                    prior_result_hash=prior_result_hash,
                )
                now = _now()
                if newly_resolved:
                    await self._append_event_uncommitted(
                        conn,
                        run_id,
                        "tool.reconciliation_resolved",
                        payload_json=_encode_payload(
                            {
                                "request_id": operation_id,
                                "operation_id": operation_id,
                                "decision": decision,
                            }
                        ),
                        created_at=now,
                    )

                resume_payload = await self._wait_cycle_resume_payload_uncommitted(
                    conn,
                    run_id=run_id,
                    wait_cycle_id=str(updated["wait_cycle_id"]),
                )
                resumed = record["run_status"] in {
                    "queued",
                    "running",
                    "completed",
                    "failed",
                }
                if (
                    record["run_status"] in {"waiting_permission", "waiting_input"}
                    and resume_payload is not None
                ):
                    active_job = await (
                        await conn.execute(
                            "SELECT * FROM local_run_jobs WHERE run_id = ? "
                            "AND status IN ('pending', 'leased')",
                            (run_id,),
                        )
                    ).fetchone()
                    if active_job is None:
                        job = self._new_run_job_record(
                            run_id=run_id,
                            kind="resume",
                            input_payload=self._run_job_input(dict(record)),
                            resume_payload=resume_payload,
                        )
                        await self._insert_run_job(conn, job)
                    elif active_job["kind"] != "resume":
                        raise WaitDecisionConflictError("run already has a different active job")
                    resumed = True

                receipt = {
                    "type": "tool.reconcile",
                    "command_id": command_id,
                    "operation_id": operation_id,
                    "run_id": run_id,
                    "resolved": True,
                    "decision": decision,
                    "resumed": resumed,
                }
                await conn.execute(
                    "INSERT INTO local_commands "
                    "(principal_id, id, command_type, client_message_id, payload_json, "
                    "response_json, run_id, created_at) "
                    "VALUES (?, ?, 'tool.reconcile', '', ?, ?, ?, ?)",
                    (
                        principal_id,
                        command_id,
                        payload_json,
                        _encode_payload(receipt),
                        run_id,
                        now,
                    ),
                )
                await conn.commit()
                return receipt, True
            except BaseException:
                await conn.rollback()
                raise

    async def _request_run_cancel_uncommitted(
        self,
        conn: aiosqlite.Connection,
        run_id: str,
    ) -> str | None:
        row = await (
            await conn.execute(
                "SELECT * FROM local_run_jobs WHERE run_id = ? "
                "AND status IN ('pending', 'leased') AND quarantined_at IS NULL",
                (run_id,),
            )
        ).fetchone()
        if row is None:
            run = await (
                await conn.execute(
                    "SELECT status FROM local_runs WHERE id = ?",
                    (run_id,),
                )
            ).fetchone()
            if run is None or run["status"] not in {"waiting_permission", "waiting_input"}:
                return None
            requested_at = _now()
            await self._finish_run_cancel_uncommitted(
                conn,
                run_id=run_id,
                requested_at=requested_at,
            )
            return "waiting"
        job = dict(row)
        requested_at = _now()
        if job["status"] == "leased":
            await conn.execute(
                "UPDATE local_run_jobs SET cancel_requested_at = ?, updated_at = ? "
                "WHERE id = ? AND status = 'leased'",
                (requested_at, requested_at, job["id"]),
            )
            return "leased"

        await conn.execute(
            "UPDATE local_run_jobs SET status = 'canceled', cancel_requested_at = ?, "
            "updated_at = ?, finished_at = ? WHERE id = ? AND status = 'pending'",
            (requested_at, requested_at, requested_at, job["id"]),
        )
        await self._finish_run_cancel_uncommitted(
            conn,
            run_id=run_id,
            requested_at=requested_at,
        )
        return "pending"

    async def _finish_run_cancel_uncommitted(
        self,
        conn: aiosqlite.Connection,
        *,
        run_id: str,
        requested_at: str,
    ) -> None:
        cancel_decision = _encode_payload({"type": "cancel", "reason": "run_canceled"})
        await conn.execute(
            "UPDATE local_permissions SET status = 'canceled', decision_json = ?, "
            "resolved_at = ? WHERE run_id = ? AND status = 'pending'",
            (cancel_decision, requested_at, run_id),
        )
        await conn.execute(
            "UPDATE local_questions SET status = 'canceled' "
            "WHERE run_id = ? AND status = 'pending'",
            (run_id,),
        )
        await conn.execute(
            "UPDATE local_wait_candidates SET status = 'resolved', decision_json = ?, "
            "resolved_at = ? WHERE run_id = ? AND status = 'pending'",
            (cancel_decision, requested_at, run_id),
        )
        await conn.execute(
            "UPDATE local_plan_approvals SET status = 'canceled', resolved_at = ? "
            "WHERE run_id = ? AND status = 'pending'",
            (requested_at, run_id),
        )
        await conn.execute(
            "UPDATE local_runs SET status = 'canceled', updated_at = ?, completed_at = ? "
            "WHERE id = ?",
            (requested_at, requested_at, run_id),
        )
        event = await self._append_event_uncommitted(
            conn,
            run_id,
            "run.canceled",
            payload_json="{}",
            created_at=requested_at,
        )
        await self._update_thread_projection_uncommitted(
            conn,
            run_id=run_id,
            run_status="canceled",
            change_type="run.canceled",
            payload={},
            event_high_watermark=int(event["seq"]),
            changed_at=requested_at,
        )

    async def update_run_mode(self, run_id: str, mode: str) -> None:
        """Persist the RESOLVED tier (fast|deep) once classification settles,
        so a resume after restart continues at the right tier."""
        async with self.run_write_transaction(run_id) as conn:
            await conn.execute(
                "UPDATE local_runs SET mode = ?, updated_at = ? WHERE id = ?",
                (mode, _now(), run_id),
            )

    async def bind_graph_definition(self, run_id: str, definition_id: str) -> None:
        """Bind once, then reject checkpoint execution with a different graph."""
        async with self.run_write_transaction(run_id) as conn:
            row = await (
                await conn.execute(
                    "SELECT graph_definition_id FROM local_runs WHERE id = ?", (run_id,)
                )
            ).fetchone()
            if row is None:
                raise KeyError(f"unknown run: {run_id}")
            current = row[0]
            if current is not None and current != definition_id:
                raise GraphDefinitionMismatchError(
                    f"run {run_id} checkpoint is incompatible with the current agent definition"
                )
            if current is None:
                await conn.execute(
                    "UPDATE local_runs SET graph_definition_id = ?, updated_at = ? WHERE id = ?",
                    (definition_id, _now(), run_id),
                )

    async def advance_graph_checkpoint(
        self,
        run_id: str,
        *,
        graph_thread_id: str,
        expected_checkpoint_id: str | None,
        checkpoint_id: str,
    ) -> None:
        """Move one product Run's branch head with lease-fenced compare-and-swap."""
        async with self.run_write_transaction(run_id) as conn:
            row = await (
                await conn.execute(
                    "SELECT graph_thread_id, graph_checkpoint_id FROM local_runs WHERE id = ?",
                    (run_id,),
                )
            ).fetchone()
            if row is None:
                raise KeyError(f"unknown run: {run_id}")
            if row[0] != graph_thread_id:
                raise GraphHeadConflictError(f"run {run_id} graph branch head changed")
            if row[1] == checkpoint_id:
                return
            if row[1] != expected_checkpoint_id:
                raise GraphHeadConflictError(f"run {run_id} graph branch head changed")
            if checkpoint_id != expected_checkpoint_id:
                await conn.execute(
                    "UPDATE local_runs SET graph_checkpoint_id = ?, updated_at = ? WHERE id = ?",
                    (checkpoint_id, _now(), run_id),
                )

    async def list_active_runs(self) -> list[dict[str, Any]]:
        """Runs not in a terminal state — used at boot to recover orphans left
        behind by a daemon restart (queued/running are dead and must be failed;
        waiting_permission/waiting_input are resumable from the checkpointer)."""
        cursor = await self._conn.execute(
            "SELECT * FROM local_runs WHERE status IN "
            "('queued', 'running', 'waiting_permission', 'waiting_input')"
        )
        return [dict(row) for row in await cursor.fetchall()]

    async def get_run(self, run_id: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT r.*, c.id AS command_id, c.client_message_id "
            "FROM local_runs r LEFT JOIN local_commands c ON c.run_id = r.id "
            "AND c.principal_id = r.principal_id "
            "AND c.command_type IN ('run.start', 'run.fork') "
            "WHERE r.id = ?",
            (run_id,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def get_run_for_principal(
        self, *, principal_id: str, run_id: str
    ) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT r.*, c.id AS command_id, c.client_message_id "
            "FROM local_runs r LEFT JOIN local_commands c ON c.run_id = r.id "
            "AND c.principal_id = r.principal_id "
            "AND c.command_type IN ('run.start', 'run.fork') "
            "WHERE r.principal_id = ? AND r.id = ?",
            (principal_id, run_id),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def list_runs(self, *, principal_id: str, limit: int = 50) -> list[dict[str, Any]]:
        """Return recent runs newest-first with a per-row events_count.

        The client's `listLocalRuns()` (`client/src/shared/local-host/
        client.ts:283`) reads `{runs: LocalRun[]}` on every boot to
        repopulate the conversation history sidebar. Each row must
        include the `LocalRun` fields the renderer reads:
        id, goal, status, workspace_path, created_at, updated_at,
        completed_at, canceled_at, events_count.
        """
        cursor = await self._conn.execute(
            """
            SELECT r.id, r.graph_thread_id, r.graph_checkpoint_id,
                   r.thread_id, r.assistant_item_id,
                   r.goal, r.user_input, r.status, r.workspace_path,
                   r.created_at, r.updated_at, r.completed_at,
                   r.metadata_json, c.id AS command_id, c.client_message_id,
                   (SELECT COUNT(*) FROM local_events e
                      WHERE e.run_id = r.id) AS events_count
              FROM local_runs r
              LEFT JOIN local_commands c ON c.run_id = r.id
                   AND c.principal_id = r.principal_id
                   AND c.command_type IN ('run.start', 'run.fork')
             WHERE r.principal_id = ?
             ORDER BY datetime(r.updated_at) DESC, r.id DESC
             LIMIT ?
            """,
            (principal_id, limit),
        )
        return [dict(row) for row in await cursor.fetchall()]

    async def list_threads(
        self,
        *,
        principal_id: str,
        limit: int = 100,
        before_created_at: str | None = None,
        before_id: str | None = None,
    ) -> tuple[list[dict[str, Any]], int, bool]:
        async with aiosqlite.connect(str(self._db_path)) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA busy_timeout=5000")
            await conn.execute("BEGIN")
            page_limit = max(1, min(int(limit), 500))
            page_filter = ""
            params: list[Any] = [principal_id]
            if before_created_at is not None and before_id is not None:
                page_filter = "AND (created_at < ? OR (created_at = ? AND id < ?)) "
                params.extend([before_created_at, before_created_at, before_id])
            params.append(page_limit + 1)
            rows = await (
                await conn.execute(
                    "SELECT * FROM local_threads WHERE principal_id = ? AND deleted_at IS NULL "
                    + page_filter
                    + "ORDER BY created_at DESC, id DESC LIMIT ?",
                    params,
                )
            ).fetchall()
            cursor_row = await (
                await conn.execute(
                    "SELECT COALESCE(MAX(cursor), 0) FROM local_thread_changes WHERE principal_id = ?",
                    (principal_id,),
                )
            ).fetchone()
            await conn.commit()
            has_more = len(rows) > page_limit
            return (
                [dict(row) for row in rows[:page_limit]],
                int(cursor_row[0] if cursor_row else 0),
                has_more,
            )

    async def get_thread_snapshot(
        self,
        *,
        principal_id: str,
        thread_id: str,
        before_position: int | None = None,
        item_limit: int = 200,
        event_limit: int = 5000,
        expected_version: int | None = None,
    ) -> dict[str, Any] | None:
        async with aiosqlite.connect(str(self._db_path)) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA busy_timeout=5000")
            await conn.execute("BEGIN")
            thread = await (
                await conn.execute(
                    "SELECT * FROM local_threads WHERE principal_id = ? AND id = ? "
                    "AND deleted_at IS NULL",
                    (principal_id, thread_id),
                )
            ).fetchone()
            if thread is None:
                await conn.rollback()
                return None
            if expected_version is not None and int(thread["version"]) != expected_version:
                await conn.rollback()
                raise RunResultConflictError("thread changed while reading snapshot")
            bounded_item_limit = max(2, min(int(item_limit), 500))
            item_filter = ""
            item_params: list[Any] = [thread_id]
            if before_position is not None:
                item_filter = "AND position < ? "
                item_params.append(before_position)
            item_params.append(bounded_item_limit + 1)
            items = await (
                await conn.execute(
                    "SELECT * FROM local_thread_items WHERE thread_id = ? "
                    "AND superseded_at IS NULL "
                    + item_filter
                    + "ORDER BY position DESC, id DESC LIMIT ?",
                    item_params,
                )
            ).fetchall()
            has_more_items = len(items) > bounded_item_limit
            page_items = list(reversed(items[:bounded_item_limit]))
            run_ids = list(
                dict.fromkeys(
                    str(item["run_id"])
                    for item in page_items
                    if item["item_type"] == "assistant_message" and item["run_id"]
                )
            )
            runs: list[aiosqlite.Row] = []
            events: list[aiosqlite.Row] = []
            event_high_watermarks: dict[str, int] = {}
            events_truncated = False
            if run_ids:
                placeholders = ",".join("?" for _ in run_ids)
                runs = await (
                    await conn.execute(
                        "SELECT r.*, c.id AS command_id, c.client_message_id, "
                        "(SELECT COUNT(*) FROM local_events e WHERE e.run_id = r.id) AS events_count "
                        "FROM local_runs r LEFT JOIN local_commands c ON c.run_id = r.id "
                        "AND c.principal_id = r.principal_id "
                        "AND c.command_type IN ('run.start', 'run.fork') "
                        f"WHERE r.principal_id = ? AND r.id IN ({placeholders}) "
                        "ORDER BY datetime(r.created_at), r.id",
                        [principal_id, *run_ids],
                    )
                ).fetchall()
                bounded_event_limit = max(1, min(int(event_limit), 10000))
                events = await (
                    await conn.execute(
                        "SELECT e.* FROM local_events e JOIN local_runs r ON r.id = e.run_id "
                        f"WHERE r.principal_id = ? AND e.run_id IN ({placeholders}) "
                        "ORDER BY datetime(r.created_at), r.id, e.seq LIMIT ?",
                        [principal_id, *run_ids, bounded_event_limit + 1],
                    )
                ).fetchall()
                events_truncated = len(events) > bounded_event_limit
                events = events[:bounded_event_limit]
                watermark_rows = await (
                    await conn.execute(
                        "SELECT run_id, MAX(event_high_watermark) AS high_watermark "
                        "FROM local_thread_items "
                        f"WHERE run_id IN ({placeholders}) GROUP BY run_id",
                        run_ids,
                    )
                ).fetchall()
                event_high_watermarks = {
                    str(row["run_id"]): int(row["high_watermark"]) for row in watermark_rows
                }
            cursor_row = await (
                await conn.execute(
                    "SELECT COALESCE(MAX(cursor), 0) FROM local_thread_changes "
                    "WHERE principal_id = ? AND thread_id = ?",
                    (principal_id, thread_id),
                )
            ).fetchone()
            await conn.commit()
            return {
                "thread": dict(thread),
                "items": [dict(item) for item in page_items],
                "runs": [dict(run) for run in runs],
                "events": [dict(event) for event in events],
                "event_high_watermarks": event_high_watermarks,
                "cursor": int(cursor_row[0] if cursor_row else 0),
                "has_more_items": has_more_items,
                "next_before_position": int(page_items[0]["position"])
                if has_more_items and page_items
                else None,
                "events_truncated": events_truncated,
            }

    async def update_thread(
        self,
        *,
        principal_id: str,
        thread_id: str,
        title: str | None,
        metadata: dict[str, Any] | None,
        archived: bool | None,
    ) -> dict[str, Any] | None:
        async with aiosqlite.connect(str(self._db_path)) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA busy_timeout=5000")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                row = await (
                    await conn.execute(
                        "SELECT * FROM local_threads WHERE principal_id = ? AND id = ? "
                        "AND deleted_at IS NULL",
                        (principal_id, thread_id),
                    )
                ).fetchone()
                if row is None:
                    await conn.rollback()
                    return None
                now = _now()
                version = int(row["version"]) + 1
                archived_at = row["archived_at"]
                if archived is True and archived_at is None:
                    archived_at = now
                elif archived is False:
                    archived_at = None
                await conn.execute(
                    "UPDATE local_threads SET title = ?, metadata_json = ?, archived_at = ?, "
                    "version = ?, updated_at = ? WHERE id = ?",
                    (
                        " ".join((title or row["title"]).split())[:80],
                        _encode_payload(metadata) if metadata is not None else row["metadata_json"],
                        archived_at,
                        version,
                        now,
                        thread_id,
                    ),
                )
                await conn.execute(
                    "INSERT INTO local_thread_changes "
                    "(principal_id, thread_id, thread_version, change_type, created_at) "
                    "VALUES (?, ?, ?, 'thread.updated', ?)",
                    (principal_id, thread_id, version, now),
                )
                updated = await (
                    await conn.execute("SELECT * FROM local_threads WHERE id = ?", (thread_id,))
                ).fetchone()
                await conn.commit()
                return dict(updated) if updated else None
            except BaseException:
                await conn.rollback()
                raise

    async def delete_thread(self, *, principal_id: str, thread_id: str) -> int | None:
        async with aiosqlite.connect(str(self._db_path)) as conn:
            conn.row_factory = aiosqlite.Row
            await conn.execute("PRAGMA busy_timeout=5000")
            await conn.execute("BEGIN IMMEDIATE")
            try:
                row = await (
                    await conn.execute(
                        "SELECT * FROM local_threads WHERE principal_id = ? AND id = ?",
                        (principal_id, thread_id),
                    )
                ).fetchone()
                if row is None:
                    await conn.rollback()
                    return None
                if row["deleted_at"] is not None:
                    await conn.commit()
                    return int(row["version"])
                active = await (
                    await conn.execute(
                        "SELECT 1 FROM local_runs r "
                        "LEFT JOIN local_run_jobs j ON j.run_id = r.id "
                        "WHERE r.principal_id = ? AND r.thread_id = ? AND ("
                        "r.status NOT IN ('completed', 'failed', 'canceled') OR "
                        "j.status IN ('pending', 'leased')) LIMIT 1",
                        (principal_id, thread_id),
                    )
                ).fetchone()
                if active is not None:
                    raise RunResultConflictError("thread has an unsettled run")
                now = _now()
                version = int(row["version"]) + 1
                await conn.execute(
                    "UPDATE local_threads SET deleted_at = ?, archived_at = ?, version = ?, "
                    "updated_at = ? WHERE id = ?",
                    (now, now, version, now, thread_id),
                )
                await conn.execute(
                    "INSERT INTO local_thread_changes "
                    "(principal_id, thread_id, thread_version, change_type, created_at) "
                    "VALUES (?, ?, ?, 'thread.deleted', ?)",
                    (principal_id, thread_id, version, now),
                )
                await conn.commit()
                return version
            except BaseException:
                await conn.rollback()
                raise

    async def thread_changes_since(
        self,
        *,
        principal_id: str,
        after_cursor: int,
        limit: int = 500,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = await (
            await self._conn.execute(
                "SELECT cursor, thread_id, thread_version, change_type, run_id, created_at "
                "FROM local_thread_changes WHERE principal_id = ? AND cursor > ? "
                "ORDER BY cursor LIMIT ?",
                (principal_id, max(0, int(after_cursor)), max(1, min(int(limit), 1000))),
            )
        ).fetchall()
        changes = [dict(row) for row in rows]
        return changes, (int(changes[-1]["cursor"]) if changes else max(0, int(after_cursor)))

    async def list_scheduled_runs_for_principal(
        self,
        *,
        principal_id: str,
        limit: int = 50,
        status: str | None = None,
        notify_pending: bool = False,
    ) -> list[dict[str, Any]]:
        clauses = ["principal_id = ?"]
        params: list[Any] = [principal_id]
        if notify_pending:
            clauses.extend(["status IN ('completed', 'failed')", "notified_at IS NULL"])
        elif status:
            clauses.append("status = ?")
            params.append(status)
        if notify_pending:
            order = "datetime(updated_at) ASC, id ASC"
        elif status:
            order = "datetime(run_at) ASC, id ASC"
        else:
            order = "datetime(run_at) DESC, id DESC"
        params.append(limit)
        cursor = await self._conn.execute(
            f"SELECT * FROM local_scheduled_runs WHERE {' AND '.join(clauses)} "
            f"ORDER BY {order} LIMIT ?",
            tuple(params),
        )
        return [dict(row) for row in await cursor.fetchall()]

    async def update_run_status(
        self, run_id: str, status: str, *, completed_at: str | None = None
    ) -> None:
        async with self.run_write_transaction(run_id) as conn:
            await conn.execute(
                "UPDATE local_runs SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?",
                (status, _now(), completed_at, run_id),
            )

    async def commit_run_result(
        self,
        run_id: str,
        *,
        status: str,
        event_type: str,
        payload: dict[str, Any],
        orphan_recovery: bool = False,
    ) -> tuple[dict[str, Any], bool]:
        """Atomically persist a waiting or terminal run state and its event.

        Returns ``(event, created)``. Repeating the exact same result returns
        the original event with ``created=False``; a different result cannot
        replace an already persisted waiting/terminal result.
        """
        expected_event = _RUN_RESULT_EVENTS.get(status)
        if expected_event != event_type:
            raise ValueError(f"{status!r} must be committed with {expected_event!r}")

        payload_json = _encode_payload(payload)
        execution_lease = _CURRENT_EXECUTION_LEASE.get()
        async with self.run_write_transaction(run_id) as conn:
            run_row = await (
                await conn.execute("SELECT status FROM local_runs WHERE id = ?", (run_id,))
            ).fetchone()
            if run_row is None:
                raise KeyError(f"unknown run: {run_id}")

            if execution_lease is None:
                if not orphan_recovery:
                    raise LeaseFenceError(
                        f"run {run_id} result requires the active execution lease"
                    )
                active_job = await (
                    await conn.execute(
                        "SELECT 1 FROM local_run_jobs WHERE run_id = ? "
                        "AND status IN ('pending', 'leased') LIMIT 1",
                        (run_id,),
                    )
                ).fetchone()
                if active_job is not None:
                    raise LeaseFenceError(f"run {run_id} still has an unsettled execution job")

            current_status = str(run_row[0])
            if current_status == status:
                existing_row = await (
                    await conn.execute(
                        "SELECT * FROM local_events WHERE run_id = ? AND event_type = ? "
                        "ORDER BY seq DESC LIMIT 1",
                        (run_id, event_type),
                    )
                ).fetchone()
                if existing_row is not None:
                    existing = dict(existing_row)
                    try:
                        existing_payload = _encode_payload(
                            json.loads(existing["payload_json"] or "{}")
                        )
                    except (json.JSONDecodeError, TypeError):
                        existing_payload = str(existing["payload_json"])
                    if existing_payload == payload_json:
                        if execution_lease is not None:
                            await self._settle_execution_job_uncommitted(
                                conn,
                                execution_lease,
                                run_status=status,
                                settled_at=_now(),
                            )
                        return existing, False
                    raise RunResultConflictError(
                        f"run {run_id} already has a different {status} result"
                    )
            elif current_status in _TERMINAL_RUN_STATUSES:
                raise RunResultConflictError(
                    f"run {run_id} is already terminal with status {current_status}"
                )

            committed_at = _now()
            completed_at = committed_at if status in _TERMINAL_RUN_STATUSES else None
            await conn.execute(
                "UPDATE local_runs SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?",
                (status, committed_at, completed_at, run_id),
            )
            event = await self._append_event_uncommitted(
                conn,
                run_id,
                event_type,
                payload_json=payload_json,
                created_at=committed_at,
            )
            await self._update_thread_projection_uncommitted(
                conn,
                run_id=run_id,
                run_status=status,
                change_type=event_type,
                payload=payload,
                event_high_watermark=int(event["seq"]),
                changed_at=committed_at,
            )
            if execution_lease is not None:
                await self._settle_execution_job_uncommitted(
                    conn,
                    execution_lease,
                    run_status=status,
                    settled_at=committed_at,
                )
            return event, True

    @staticmethod
    async def _update_thread_projection_uncommitted(
        conn: aiosqlite.Connection,
        *,
        run_id: str,
        run_status: str,
        change_type: str,
        payload: dict[str, Any],
        event_high_watermark: int,
        changed_at: str,
    ) -> None:
        run = await (
            await conn.execute(
                "SELECT principal_id, thread_id, assistant_item_id FROM local_runs WHERE id = ?",
                (run_id,),
            )
        ).fetchone()
        if run is None or not run["thread_id"] or not run["assistant_item_id"]:
            return
        draft = await (
            await conn.execute(
                "SELECT content FROM local_assistant_drafts WHERE run_id = ?",
                (run_id,),
            )
        ).fetchone()
        content = str(payload.get("final_text") or "") if run_status == "completed" else ""
        if not content and draft is not None:
            content = str(draft["content"] or "")
        item_status = {
            "completed": "completed",
            "failed": "failed",
            "canceled": "canceled",
            "waiting_permission": "in_progress",
            "waiting_input": "in_progress",
            "cleanup_required": "cleanup_required",
        }[run_status]
        terminal = run_status in _TERMINAL_RUN_STATUSES
        cursor = await conn.execute(
            "UPDATE local_thread_items SET status = ?, content = ?, event_high_watermark = ?, "
            "version = version + 1, updated_at = ?, completed_at = ? "
            "WHERE id = ? AND run_id = ?",
            (
                item_status,
                content,
                event_high_watermark,
                changed_at,
                changed_at if terminal else None,
                run["assistant_item_id"],
                run_id,
            ),
        )
        if cursor.rowcount != 1:
            raise RunResultConflictError(f"run {run_id} is missing its assistant projection")
        thread = await (
            await conn.execute(
                "SELECT version FROM local_threads WHERE id = ? AND principal_id = ?",
                (run["thread_id"], run["principal_id"]),
            )
        ).fetchone()
        if thread is None:
            raise RunResultConflictError(f"run {run_id} is missing its thread projection")
        thread_version = int(thread["version"]) + 1
        await conn.execute(
            "UPDATE local_threads SET version = ?, updated_at = ? WHERE id = ?",
            (thread_version, changed_at, run["thread_id"]),
        )
        await conn.execute(
            "INSERT INTO local_thread_changes "
            "(principal_id, thread_id, thread_version, change_type, run_id, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                run["principal_id"],
                run["thread_id"],
                thread_version,
                change_type,
                run_id,
                changed_at,
            ),
        )

    @staticmethod
    async def _settle_execution_job_uncommitted(
        conn: aiosqlite.Connection,
        lease: ExecutionLease,
        *,
        run_status: str,
        settled_at: str,
    ) -> None:
        fence_at = _now()
        job_status = {
            "completed": "completed",
            "failed": "dead",
            "canceled": "canceled",
            "waiting_permission": "completed",
            "waiting_input": "completed",
        }[run_status]
        cursor = await conn.execute(
            "UPDATE local_run_jobs SET status = ?, updated_at = ?, finished_at = ?, "
            "lease_expires_at = NULL WHERE id = ? AND run_id = ? AND status = 'leased' "
            "AND lease_owner = ? AND lease_generation = ? AND quarantined_at IS NULL "
            "AND lease_expires_at > ?",
            (
                job_status,
                settled_at,
                settled_at,
                lease.job_id,
                lease.run_id,
                lease.lease_owner,
                lease.lease_generation,
                fence_at,
            ),
        )
        if cursor.rowcount != 1:
            raise LeaseFenceError(
                f"run {lease.run_id} lease generation {lease.lease_generation} is stale"
            )

    # --- scheduled runs ---

    async def create_scheduled_run(
        self,
        *,
        principal_id: str,
        goal: str,
        run_at: str,
        workspace_path: str | None = None,
        model: str = "auto",
        history: list[dict[str, str]] | None = None,
        settings: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        record = {
            "id": _new_id("sched"),
            "principal_id": principal_id,
            "goal": goal,
            "workspace_path": workspace_path,
            "model": model or "auto",
            "history_json": json.dumps(history or [], ensure_ascii=False, default=str),
            "settings_json": json.dumps(settings or {}, ensure_ascii=False, default=str),
            "metadata_json": json.dumps(metadata or {}, ensure_ascii=False, default=str),
            "run_at": run_at,
            "status": "scheduled",
            "run_id": None,
            "result_text": None,
            "error_message": None,
            "created_at": _now(),
            "updated_at": _now(),
            "completed_at": None,
            "notified_at": None,
        }
        path_error = await self._workspace_path_error(workspace_path)
        if path_error is not None:
            raise WorkspaceAdmissionError(path_error)
        async with aiosqlite.connect(str(self._db_path)) as transaction_conn:
            transaction_conn.row_factory = aiosqlite.Row
            await transaction_conn.execute("PRAGMA busy_timeout=5000")
            await transaction_conn.execute("BEGIN IMMEDIATE")
            try:
                workspace_error = await self._workspace_owner_error(
                    transaction_conn,
                    principal_id=principal_id,
                    path=workspace_path,
                )
                if workspace_error is not None:
                    raise WorkspaceAdmissionError(workspace_error)
                await transaction_conn.execute(
                    "INSERT INTO local_scheduled_runs "
                    "(id, principal_id, goal, workspace_path, model, history_json, "
                    " settings_json, metadata_json, run_at, status, run_id, result_text, "
                    " error_message, created_at, updated_at, completed_at, notified_at) "
                    "VALUES (:id, :principal_id, :goal, :workspace_path, :model, "
                    " :history_json, :settings_json, :metadata_json, :run_at, :status, "
                    " :run_id, :result_text, :error_message, :created_at, :updated_at, "
                    " :completed_at, :notified_at)",
                    record,
                )
                await transaction_conn.commit()
            except BaseException:
                await transaction_conn.rollback()
                raise
        return record

    async def get_scheduled_run(self, schedule_id: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM local_scheduled_runs WHERE id = ?",
            (schedule_id,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def list_scheduled_runs(
        self,
        *,
        limit: int = 50,
        status: str | None = None,
        notify_pending: bool = False,
    ) -> list[dict[str, Any]]:
        if notify_pending:
            cursor = await self._conn.execute(
                """
                SELECT * FROM local_scheduled_runs
                 WHERE status IN ('completed', 'failed')
                   AND notified_at IS NULL
                 ORDER BY datetime(updated_at) ASC, id ASC
                 LIMIT ?
                """,
                (limit,),
            )
            return [dict(row) for row in await cursor.fetchall()]
        if status:
            cursor = await self._conn.execute(
                """
                SELECT * FROM local_scheduled_runs
                 WHERE status = ?
                 ORDER BY datetime(run_at) ASC, id ASC
                 LIMIT ?
                """,
                (status, limit),
            )
            return [dict(row) for row in await cursor.fetchall()]
        cursor = await self._conn.execute(
            """
            SELECT * FROM local_scheduled_runs
             ORDER BY datetime(run_at) DESC, id DESC
             LIMIT ?
            """,
            (limit,),
        )
        return [dict(row) for row in await cursor.fetchall()]

    async def claim_due_scheduled_runs(
        self,
        *,
        now: str,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        cursor = await self._conn.execute(
            """
            SELECT * FROM local_scheduled_runs
             WHERE status = 'scheduled'
               AND run_at <= ?
             ORDER BY run_at ASC, id ASC
             LIMIT ?
            """,
            (now, limit),
        )
        rows = [dict(row) for row in await cursor.fetchall()]
        if not rows:
            return []
        updated_at = _now()
        await self._conn.executemany(
            "UPDATE local_scheduled_runs SET status = 'running', updated_at = ? "
            "WHERE id = ? AND status = 'scheduled'",
            [(updated_at, row["id"]) for row in rows],
        )
        await self._conn.commit()
        claimed: list[dict[str, Any]] = []
        for row in rows:
            fresh = await self.get_scheduled_run(row["id"])
            if fresh and fresh["status"] == "running":
                claimed.append(fresh)
        return claimed

    async def mark_scheduled_run_started(
        self, schedule_id: str, run_id: str
    ) -> dict[str, Any] | None:
        await self._conn.execute(
            "UPDATE local_scheduled_runs SET status = 'running', run_id = ?, updated_at = ? "
            "WHERE id = ?",
            (run_id, _now(), schedule_id),
        )
        await self._conn.commit()
        return await self.get_scheduled_run(schedule_id)

    async def complete_scheduled_run(
        self,
        schedule_id: str,
        *,
        status: str,
        result_text: str | None = None,
        error_message: str | None = None,
    ) -> dict[str, Any] | None:
        completed_at = _now()
        await self._conn.execute(
            "UPDATE local_scheduled_runs "
            "SET status = ?, result_text = ?, error_message = ?, completed_at = ?, updated_at = ? "
            "WHERE id = ?",
            (status, result_text, error_message, completed_at, completed_at, schedule_id),
        )
        await self._conn.commit()
        return await self.get_scheduled_run(schedule_id)

    async def cancel_scheduled_run(
        self, *, principal_id: str, schedule_id: str
    ) -> dict[str, Any] | None:
        existing = await self._scheduled_run_for_principal(principal_id, schedule_id)
        if existing is None:
            return None
        if existing["status"] != "scheduled":
            return existing
        canceled_at = _now()
        await self._conn.execute(
            "UPDATE local_scheduled_runs "
            "SET status = 'canceled', completed_at = ?, updated_at = ? "
            "WHERE principal_id = ? AND id = ?",
            (canceled_at, canceled_at, principal_id, schedule_id),
        )
        await self._conn.commit()
        return await self._scheduled_run_for_principal(principal_id, schedule_id)

    async def mark_scheduled_run_notified(
        self, *, principal_id: str, schedule_id: str
    ) -> dict[str, Any] | None:
        await self._conn.execute(
            "UPDATE local_scheduled_runs SET notified_at = ?, updated_at = ? "
            "WHERE principal_id = ? AND id = ?",
            (_now(), _now(), principal_id, schedule_id),
        )
        await self._conn.commit()
        return await self._scheduled_run_for_principal(principal_id, schedule_id)

    async def _scheduled_run_for_principal(
        self, principal_id: str, schedule_id: str
    ) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM local_scheduled_runs WHERE principal_id = ? AND id = ?",
            (principal_id, schedule_id),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    # --- events ---

    async def append_event(
        self,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        async with self.run_write_transaction(run_id) as conn:
            event = await self._append_event_uncommitted(
                conn,
                run_id,
                event_type,
                payload_json=_encode_payload(payload),
                created_at=_now(),
            )
            return event

    async def _append_event_uncommitted(
        self,
        conn: aiosqlite.Connection,
        run_id: str,
        event_type: str,
        *,
        payload_json: str,
        created_at: str,
    ) -> dict[str, Any]:
        cursor = await conn.execute(
            "SELECT COALESCE(MAX(seq), 0) FROM local_events WHERE run_id = ?", (run_id,)
        )
        row = await cursor.fetchone()
        next_seq = (row[0] if row else 0) + 1
        event = {
            "id": _new_id("evt"),
            "run_id": run_id,
            "seq": next_seq,
            "event_type": event_type,
            "payload_json": payload_json,
            "created_at": created_at,
        }
        await conn.execute(
            "INSERT INTO local_events (id, run_id, seq, event_type, payload_json, created_at) "
            "VALUES (:id, :run_id, :seq, :event_type, :payload_json, :created_at)",
            event,
        )
        return event

    async def events_since(self, run_id: str, after_seq: int = 0) -> list[dict[str, Any]]:
        cursor = await self._conn.execute(
            "SELECT * FROM local_events WHERE run_id = ? AND seq > ? ORDER BY seq",
            (run_id, after_seq),
        )
        return [dict(row) for row in await cursor.fetchall()]

    # --- steering ---

    async def create_steering_instruction(
        self,
        *,
        run_id: str,
        content: str,
    ) -> dict[str, Any]:
        record = {
            "id": _new_id("steer"),
            "run_id": run_id,
            "content": content,
            "status": "pending",
            "created_at": _now(),
            "injected_at": None,
        }
        await self._conn.execute(
            "INSERT INTO local_steering "
            "(id, run_id, content, status, created_at, injected_at) "
            "VALUES (:id, :run_id, :content, :status, :created_at, :injected_at)",
            record,
        )
        await self._conn.commit()
        return record

    async def claim_pending_steering(self, run_id: str) -> list[dict[str, Any]]:
        async with self.run_write_transaction(run_id) as conn:
            cursor = await conn.execute(
                "SELECT * FROM local_steering "
                "WHERE run_id = ? AND status = 'pending' ORDER BY created_at, id",
                (run_id,),
            )
            rows = [dict(row) for row in await cursor.fetchall()]
            if not rows:
                return []
            injected_at = _now()
            await conn.executemany(
                "UPDATE local_steering SET status = 'injected', injected_at = ? "
                "WHERE id = ? AND status = 'pending'",
                [(injected_at, row["id"]) for row in rows],
            )
            return [{**row, "status": "injected", "injected_at": injected_at} for row in rows]

    # --- plan approvals ---

    async def create_plan_approval(
        self,
        *,
        run_id: str,
        tool_call_id: str,
        todos: list[dict[str, Any]],
        summary: str = "",
        wait_cycle_id: str | None = None,
        interrupt_id: str | None = None,
    ) -> dict[str, Any]:
        record = {
            "id": _new_id("plan"),
            "run_id": run_id,
            "tool_call_id": tool_call_id,
            "wait_cycle_id": wait_cycle_id,
            "interrupt_id": interrupt_id,
            "todos_json": json.dumps(todos, ensure_ascii=False, default=str),
            "summary": summary,
            "status": "pending",
            "instructions": None,
            "created_at": _now(),
            "resolved_at": None,
        }
        record["wait_cycle_id"] = record["wait_cycle_id"] or record["id"]
        record["interrupt_id"] = record["interrupt_id"] or record["id"]
        try:
            async with self.run_write_transaction(run_id) as conn:
                await conn.execute(
                    "INSERT INTO local_plan_approvals "
                    "(id, run_id, tool_call_id, wait_cycle_id, interrupt_id, todos_json, "
                    "summary, status, instructions, created_at, resolved_at) "
                    "VALUES (:id, :run_id, :tool_call_id, :wait_cycle_id, :interrupt_id, "
                    ":todos_json, :summary, :status, :instructions, :created_at, :resolved_at)",
                    record,
                )
                await conn.execute(
                    "INSERT INTO local_wait_candidates "
                    "(id, run_id, kind, wait_cycle_id, interrupt_id, position, status, "
                    "payload_json, decision_json, created_at, resolved_at) "
                    "VALUES (?, ?, 'plan', ?, ?, 0, 'pending', ?, NULL, ?, NULL)",
                    (
                        record["id"],
                        run_id,
                        record["wait_cycle_id"],
                        record["interrupt_id"],
                        record["todos_json"],
                        record["created_at"],
                    ),
                )
        except aiosqlite.IntegrityError:
            existing = await self.get_plan_approval_by_tool_call(
                run_id=run_id,
                tool_call_id=tool_call_id,
            )
            assert existing is not None
            if (
                wait_cycle_id
                and interrupt_id
                and (not existing.get("wait_cycle_id") or not existing.get("interrupt_id"))
            ):
                async with self.run_write_transaction(run_id) as conn:
                    await conn.execute(
                        "UPDATE local_plan_approvals SET wait_cycle_id = ?, interrupt_id = ? "
                        "WHERE id = ?",
                        (wait_cycle_id, interrupt_id, existing["id"]),
                    )
                    await conn.execute(
                        "INSERT OR IGNORE INTO local_wait_candidates "
                        "(id, run_id, kind, wait_cycle_id, interrupt_id, position, status, "
                        "payload_json, decision_json, created_at, resolved_at) "
                        "VALUES (?, ?, 'plan', ?, ?, 0, 'pending', ?, NULL, ?, NULL)",
                        (
                            existing["id"],
                            run_id,
                            wait_cycle_id,
                            interrupt_id,
                            existing["todos_json"],
                            existing["created_at"],
                        ),
                    )
                existing = {
                    **existing,
                    "wait_cycle_id": wait_cycle_id,
                    "interrupt_id": interrupt_id,
                }
            return existing
        return _decode_plan_approval_record(record)

    async def get_plan_approval(self, approval_id: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM local_plan_approvals WHERE id = ?",
            (approval_id,),
        )
        row = await cursor.fetchone()
        return _decode_plan_approval_record(dict(row)) if row else None

    async def get_plan_approval_by_tool_call(
        self,
        *,
        run_id: str,
        tool_call_id: str,
    ) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM local_plan_approvals WHERE run_id = ? AND tool_call_id = ?",
            (run_id, tool_call_id),
        )
        row = await cursor.fetchone()
        return _decode_plan_approval_record(dict(row)) if row else None

    # --- permissions (HumanInTheLoop pause record) ---

    async def create_permission(
        self,
        *,
        run_id: str,
        tool_call_id: str,
        tool_name: str,
        arguments: dict[str, Any],
        tool_version: str = "",
        operation_id: str | None = None,
        arguments_hash: str | None = None,
        risk: str | None = None,
        wait_cycle_id: str | None = None,
        interrupt_id: str | None = None,
        action_index: int = 0,
        scope: str = "once",
    ) -> dict[str, Any]:
        """Get or create the approval record for one concrete tool operation.

        The returned `id` is what gets surfaced to the renderer as the
        `request_id` in the `permission.required` SSE event, and what
        the client posts back to `POST /local/v1/permissions/{id}` to
        approve or deny. Without this row, the client cannot look up
        which paused run to resume.
        """
        if operation_id:
            cursor = await self._conn.execute(
                "SELECT * FROM local_permissions WHERE run_id = ? AND operation_id = ?",
                (run_id, operation_id),
            )
            row = await cursor.fetchone()
            if row is not None:
                existing = dict(row)
                if (
                    existing.get("tool_call_id") != tool_call_id
                    or existing.get("tool_name") != tool_name
                    or str(existing.get("tool_version") or "") != tool_version
                    or existing.get("arguments_hash") != arguments_hash
                ):
                    raise PermissionDecisionConflictError(
                        "permission operation identity was reused with different content"
                    )
                return existing

        record = {
            "id": _new_id("perm"),
            "run_id": run_id,
            "tool_call_id": tool_call_id,
            "wait_cycle_id": wait_cycle_id,
            "interrupt_id": interrupt_id,
            "action_index": max(0, int(action_index)),
            "operation_id": operation_id,
            "tool_name": tool_name,
            "tool_version": tool_version,
            "arguments_hash": arguments_hash,
            "arguments_json": json.dumps(arguments or {}, ensure_ascii=False, default=str),
            "risk": risk,
            "decision_json": None,
            "status": "pending",
            "scope": scope,
            "grant_max_uses": 0,
            "grant_use_count": 0,
            "grant_expires_at": None,
            "created_at": _now(),
            "resolved_at": None,
        }
        record["wait_cycle_id"] = record["wait_cycle_id"] or record["id"]
        record["interrupt_id"] = record["interrupt_id"] or record["id"]
        async with self.run_write_transaction(run_id) as conn:
            await conn.execute(
                "INSERT INTO local_permissions "
                "(id, run_id, tool_call_id, wait_cycle_id, interrupt_id, action_index, "
                "operation_id, tool_name, tool_version, arguments_hash, "
                " arguments_json, risk, decision_json, status, scope, grant_max_uses, "
                " grant_use_count, grant_expires_at, created_at, resolved_at) "
                "VALUES (:id, :run_id, :tool_call_id, :wait_cycle_id, :interrupt_id, "
                ":action_index, :operation_id, :tool_name, :tool_version, "
                "        :arguments_hash, :arguments_json, :risk, :decision_json, :status, :scope, "
                "        :grant_max_uses, :grant_use_count, :grant_expires_at, "
                "        :created_at, :resolved_at)",
                record,
            )
            await conn.execute(
                "INSERT INTO local_wait_candidates "
                "(id, run_id, kind, wait_cycle_id, interrupt_id, position, status, "
                "payload_json, decision_json, created_at, resolved_at) "
                "VALUES (?, ?, 'tool_review', ?, ?, ?, 'pending', ?, NULL, ?, NULL)",
                (
                    record["id"],
                    run_id,
                    record["wait_cycle_id"],
                    record["interrupt_id"],
                    record["action_index"],
                    json.dumps(
                        {
                            "tool_call_id": tool_call_id,
                            "operation_id": operation_id,
                            "tool_name": tool_name,
                            "tool_version": tool_version,
                            "arguments_hash": arguments_hash,
                            "arguments": arguments or {},
                            "risk": risk,
                        },
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    ),
                    record["created_at"],
                ),
            )
        return record

    async def get_permission(self, permission_id: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM local_permissions WHERE id = ?", (permission_id,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def get_permission_for_operation(
        self, *, run_id: str, operation_id: str
    ) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM local_permissions WHERE run_id = ? AND operation_id = ?",
            (run_id, operation_id),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def resolve_permission(
        self,
        permission_id: str,
        *,
        status: str,
        scope: str | None = None,
        decision: dict[str, Any] | None = None,
        event_payload: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        if status not in {"approved", "denied"}:
            raise ValueError("permission status must be approved or denied")
        record = await self.get_permission(permission_id)
        if record is None:
            return None
        current_status = str(record.get("status") or "")
        current_scope = str(record.get("scope") or "once")
        requested_scope = scope or current_scope
        grant_max_uses = 20 if requested_scope == "run" and status == "approved" else 0
        grant_expires_at = (
            (datetime.now(UTC) + timedelta(hours=24)).isoformat() if grant_max_uses else None
        )
        decision_json = json.dumps(
            decision or ({"type": "approve"} if status == "approved" else {"type": "reject"}),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        if current_status != "pending":
            if (
                current_status != status
                or current_scope != requested_scope
                or str(record.get("decision_json") or "") != decision_json
            ):
                raise PermissionDecisionConflictError(
                    "permission was already resolved with a different decision"
                )
            return record
        async with self.run_write_transaction(str(record["run_id"])) as conn:
            run = await (
                await conn.execute(
                    "SELECT status FROM local_runs WHERE id = ?",
                    (record["run_id"],),
                )
            ).fetchone()
            if run is None or run["status"] in {
                "completed",
                "failed",
                "canceled",
                "cleanup_required",
            }:
                raise WaitDecisionConflictError("run is not awaiting a decision")
            cursor = await conn.execute(
                "UPDATE local_permissions SET status = ?, scope = ?, decision_json = ?, "
                "grant_max_uses = ?, grant_expires_at = ?, resolved_at = ? "
                "WHERE id = ? AND status = 'pending'",
                (
                    status,
                    requested_scope,
                    decision_json,
                    grant_max_uses,
                    grant_expires_at,
                    _now(),
                    permission_id,
                ),
            )
            if cursor.rowcount != 1:
                raise PermissionDecisionConflictError("permission was resolved concurrently")
            wait_cursor = await conn.execute(
                "UPDATE local_wait_candidates SET status = 'resolved', "
                "decision_json = ?, resolved_at = ? WHERE id = ? AND status = 'pending'",
                (decision_json, _now(), permission_id),
            )
            if wait_cursor.rowcount != 1:
                raise WaitDecisionConflictError(
                    "permission wait candidate was resolved concurrently"
                )
            if event_payload is not None:
                await self._append_event_uncommitted(
                    conn,
                    str(record["run_id"]),
                    "permission.resolved",
                    payload_json=_encode_payload(event_payload),
                    created_at=_now(),
                )
        return await self.get_permission(permission_id)

    async def consume_run_permission_grant(
        self,
        *,
        run_id: str,
        operation_id: str,
        tool_name: str,
        tool_version: str = "",
        arguments_hash: str,
        risk: str,
    ) -> bool:
        """Atomically consume one bounded exact-argument run grant use.

        A grant never widens to every call with the same tool name. This keeps
        a harmless command/path approval from authorizing a different one.
        """
        async with self.run_write_transaction(run_id) as conn:
            existing = await (
                await conn.execute(
                    "SELECT permission_id FROM local_permission_grant_uses "
                    "WHERE run_id = ? AND operation_id = ?",
                    (run_id, operation_id),
                )
            ).fetchone()
            if existing is not None:
                return True
            grant = await (
                await conn.execute(
                    "SELECT id FROM local_permissions "
                    "WHERE run_id = ? AND tool_name = ? AND tool_version = ? "
                    "AND arguments_hash = ? AND risk = ? "
                    "AND status = 'approved' AND scope = 'run' "
                    "AND grant_use_count < grant_max_uses AND grant_expires_at > ? "
                    "ORDER BY resolved_at DESC LIMIT 1",
                    (run_id, tool_name, tool_version, arguments_hash, risk, _now()),
                )
            ).fetchone()
            if grant is None:
                return False
            permission_id = str(grant[0])
            await conn.execute(
                "INSERT INTO local_permission_grant_uses "
                "(permission_id, run_id, operation_id, created_at) VALUES (?, ?, ?, ?)",
                (permission_id, run_id, operation_id, _now()),
            )
            cursor = await conn.execute(
                "UPDATE local_permissions SET grant_use_count = grant_use_count + 1 "
                "WHERE id = ? AND grant_use_count < grant_max_uses",
                (permission_id,),
            )
            if cursor.rowcount != 1:
                raise PermissionDecisionConflictError("permission grant was exhausted concurrently")
            return True

    async def wait_cycle_resume_payload(
        self,
        *,
        run_id: str,
        wait_cycle_id: str,
    ) -> dict[str, Any] | None:
        """Build LangGraph's interrupt-id keyed resume payload when complete."""
        return await self._wait_cycle_resume_payload_uncommitted(
            self._conn,
            run_id=run_id,
            wait_cycle_id=wait_cycle_id,
        )

    @staticmethod
    async def _wait_cycle_resume_payload_uncommitted(
        conn: aiosqlite.Connection,
        *,
        run_id: str,
        wait_cycle_id: str,
    ) -> dict[str, Any] | None:
        cursor = await conn.execute(
            "SELECT * FROM local_wait_candidates "
            "WHERE run_id = ? AND wait_cycle_id = ? "
            "ORDER BY interrupt_id, position",
            (run_id, wait_cycle_id),
        )
        rows = [dict(row) for row in await cursor.fetchall()]
        if not rows or any(row.get("status") != "resolved" for row in rows):
            return None
        grouped: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            grouped.setdefault(str(row["interrupt_id"]), []).append(row)
        resume: dict[str, Any] = {}
        for interrupt_id, candidates in grouped.items():
            kinds = {str(candidate.get("kind") or "") for candidate in candidates}
            if kinds == {"tool_review"}:
                resume[interrupt_id] = {
                    "decisions": [
                        json.loads(str(candidate.get("decision_json") or "{}"))
                        for candidate in candidates
                    ]
                }
            elif kinds == {"question"} and len(candidates) == 1:
                resume[interrupt_id] = json.loads(str(candidates[0].get("decision_json") or "{}"))
            elif kinds == {"tool_reconciliation"} and len(candidates) == 1:
                resume[interrupt_id] = json.loads(str(candidates[0].get("decision_json") or "{}"))
            elif kinds == {"plan"} and len(candidates) == 1:
                resume[interrupt_id] = json.loads(str(candidates[0].get("decision_json") or "{}"))
            else:
                raise WaitDecisionConflictError(
                    f"unsupported wait candidate group for interrupt {interrupt_id}"
                )
        return resume

    async def latest_resolved_wait_cycle_payload(self, run_id: str) -> dict[str, Any] | None:
        row = await (
            await self._conn.execute(
                "SELECT wait_cycle_id FROM local_wait_candidates WHERE run_id = ? "
                "ORDER BY created_at DESC, id DESC LIMIT 1",
                (run_id,),
            )
        ).fetchone()
        if row is None:
            return None
        return await self.wait_cycle_resume_payload(
            run_id=run_id,
            wait_cycle_id=str(row[0]),
        )

    async def list_permissions_for_run(self, run_id: str) -> list[dict[str, Any]]:
        cursor = await self._conn.execute(
            "SELECT * FROM local_permissions WHERE run_id = ? ORDER BY created_at",
            (run_id,),
        )
        return [
            {**dict(row), "arguments": json.loads(row["arguments_json"] or "{}")}
            for row in await cursor.fetchall()
        ]

    # --- questions (user.ask interrupt record) ---

    async def create_question(
        self,
        *,
        run_id: str,
        tool_call_id: str | None,
        questions: list[dict[str, Any]],
        wait_cycle_id: str | None = None,
        interrupt_id: str | None = None,
    ) -> dict[str, Any]:
        """Record a `user.ask` interrupt.

        `questions` is a list to allow future multi-question interrupts;
        today user.ask emits one. The returned `id` is the `request_id`
        the client posts back via `POST /local/v1/questions/{id}` with
        `{answers}`.
        """
        if interrupt_id:
            existing = await (
                await self._conn.execute(
                    "SELECT * FROM local_questions WHERE run_id = ? AND interrupt_id = ?",
                    (run_id, interrupt_id),
                )
            ).fetchone()
            if existing is not None:
                return dict(existing)
        record = {
            "id": _new_id("q"),
            "run_id": run_id,
            "tool_call_id": tool_call_id,
            "wait_cycle_id": wait_cycle_id,
            "interrupt_id": interrupt_id,
            "questions_json": json.dumps(questions, ensure_ascii=False, default=str),
            "status": "pending",
            "answers_json": None,
            "created_at": _now(),
            "answered_at": None,
        }
        record["wait_cycle_id"] = record["wait_cycle_id"] or record["id"]
        record["interrupt_id"] = record["interrupt_id"] or record["id"]
        async with self.run_write_transaction(run_id) as conn:
            await conn.execute(
                "INSERT INTO local_questions (id, run_id, tool_call_id, wait_cycle_id, "
                " interrupt_id, questions_json, "
                " status, answers_json, created_at, answered_at) "
                "VALUES (:id, :run_id, :tool_call_id, :wait_cycle_id, :interrupt_id, "
                "        :questions_json, :status, "
                "        :answers_json, :created_at, :answered_at)",
                record,
            )
            await conn.execute(
                "INSERT INTO local_wait_candidates "
                "(id, run_id, kind, wait_cycle_id, interrupt_id, position, status, "
                "payload_json, decision_json, created_at, resolved_at) "
                "VALUES (?, ?, 'question', ?, ?, 0, 'pending', ?, NULL, ?, NULL)",
                (
                    record["id"],
                    run_id,
                    record["wait_cycle_id"],
                    record["interrupt_id"],
                    record["questions_json"],
                    record["created_at"],
                ),
            )
        return record

    async def get_question(self, question_id: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM local_questions WHERE id = ?", (question_id,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def answer_question(
        self,
        question_id: str,
        *,
        answers: dict[str, Any],
        event_payload: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        record = await self.get_question(question_id)
        if record is None:
            return None
        answers_json = json.dumps(
            answers,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        if record.get("status") != "pending":
            try:
                existing = json.dumps(
                    json.loads(record.get("answers_json") or "{}"),
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
            except json.JSONDecodeError:
                existing = str(record.get("answers_json") or "")
            if existing != answers_json:
                raise WaitDecisionConflictError(
                    "question was already answered with different content"
                )
            return record
        now = _now()
        async with self.run_write_transaction(str(record["run_id"])) as conn:
            run = await (
                await conn.execute(
                    "SELECT status FROM local_runs WHERE id = ?",
                    (record["run_id"],),
                )
            ).fetchone()
            if run is None or run["status"] in {
                "completed",
                "failed",
                "canceled",
                "cleanup_required",
            }:
                raise WaitDecisionConflictError("run is not awaiting a decision")
            cursor = await conn.execute(
                "UPDATE local_questions SET status = 'answered', answers_json = ?, "
                "answered_at = ? WHERE id = ? AND status = 'pending'",
                (answers_json, now, question_id),
            )
            wait_cursor = await conn.execute(
                "UPDATE local_wait_candidates SET status = 'resolved', "
                "decision_json = ?, resolved_at = ? WHERE id = ? AND status = 'pending'",
                (answers_json, now, question_id),
            )
            if cursor.rowcount != 1 or wait_cursor.rowcount != 1:
                raise WaitDecisionConflictError("question was answered concurrently")
            if event_payload is not None:
                await self._append_event_uncommitted(
                    conn,
                    str(record["run_id"]),
                    "question.answered",
                    payload_json=_encode_payload(event_payload),
                    created_at=now,
                )
        return await self.get_question(question_id)

    async def list_wait_candidates_for_run(self, run_id: str) -> list[dict[str, Any]]:
        rows = await (
            await self._conn.execute(
                "SELECT * FROM local_wait_candidates WHERE run_id = ? ORDER BY created_at, id",
                (run_id,),
            )
        ).fetchall()
        return [dict(row) for row in rows]

    async def get_wait_candidate(self, candidate_id: str) -> dict[str, Any] | None:
        row = await (
            await self._conn.execute(
                "SELECT * FROM local_wait_candidates WHERE id = ?", (candidate_id,)
            )
        ).fetchone()
        return dict(row) if row else None

    async def create_tool_reconciliation(
        self,
        *,
        run_id: str,
        operation_id: str,
        wait_cycle_id: str,
        interrupt_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        existing = await self.get_wait_candidate(operation_id)
        if existing is not None:
            if existing.get("run_id") != run_id or existing.get("kind") != "tool_reconciliation":
                raise WaitDecisionConflictError(
                    "tool reconciliation identity was reused with different content"
                )
            return existing
        record = {
            "id": operation_id,
            "run_id": run_id,
            "kind": "tool_reconciliation",
            "wait_cycle_id": wait_cycle_id,
            "interrupt_id": interrupt_id,
            "position": 0,
            "status": "pending",
            "payload_json": json.dumps(
                payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ),
            "decision_json": None,
            "created_at": _now(),
            "resolved_at": None,
        }
        async with self.run_write_transaction(run_id) as conn:
            await conn.execute(
                "INSERT INTO local_wait_candidates "
                "(id, run_id, kind, wait_cycle_id, interrupt_id, position, status, "
                "payload_json, decision_json, created_at, resolved_at) "
                "VALUES (:id, :run_id, :kind, :wait_cycle_id, :interrupt_id, :position, "
                ":status, :payload_json, :decision_json, :created_at, :resolved_at)",
                record,
            )
        return record

    async def resolve_tool_reconciliation(
        self,
        candidate_id: str,
        *,
        decision: str,
        current_result_json: str | None,
        current_result_hash: str | None,
        prior_result_json: str,
        prior_result_hash: str,
    ) -> dict[str, Any] | None:
        if decision not in {"confirmed_completed", "retry_not_executed", "abort"}:
            raise ValueError(f"invalid tool reconciliation decision: {decision}")
        record = await self.get_wait_candidate(candidate_id)
        if record is None or record.get("kind") != "tool_reconciliation":
            return None
        current_run_id = str(record["run_id"])
        async with self.run_write_transaction(current_run_id) as conn:
            updated, _resolved = await self._resolve_tool_reconciliation_uncommitted(
                conn,
                candidate_id=candidate_id,
                decision=decision,
                current_result_json=current_result_json,
                current_result_hash=current_result_hash,
                prior_result_json=prior_result_json,
                prior_result_hash=prior_result_hash,
            )
            return updated

    @staticmethod
    async def _resolve_tool_reconciliation_uncommitted(
        conn: aiosqlite.Connection,
        *,
        candidate_id: str,
        decision: str,
        current_result_json: str | None,
        current_result_hash: str | None,
        prior_result_json: str,
        prior_result_hash: str,
    ) -> tuple[dict[str, Any], bool]:
        record = await (
            await conn.execute(
                "SELECT * FROM local_wait_candidates WHERE id = ?",
                (candidate_id,),
            )
        ).fetchone()
        if record is None or record["kind"] != "tool_reconciliation":
            raise KeyError(candidate_id)
        decision_json = _encode_payload({"decision": decision})
        if record["status"] != "pending":
            if str(record["decision_json"] or "") != decision_json:
                raise WaitDecisionConflictError(
                    "tool reconciliation was already resolved differently"
                )
            return dict(record), False
        payload = _json_payload(record["payload_json"])
        prior_operation_id = str(payload.get("prior_operation_id") or candidate_id)
        current_run_id = str(record["run_id"])
        current_receipt = await (
            await conn.execute(
                "SELECT * FROM local_tool_receipts WHERE operation_id = ? AND run_id = ?",
                (candidate_id, current_run_id),
            )
        ).fetchone()
        prior_receipt = await (
            await conn.execute(
                "SELECT * FROM local_tool_receipts WHERE operation_id = ?",
                (prior_operation_id,),
            )
        ).fetchone()
        if current_receipt is None or prior_receipt is None:
            raise WaitDecisionConflictError("tool reconciliation receipt is missing")
        prior_run_id = str(prior_receipt["run_id"])
        if prior_run_id != current_run_id:
            ancestor = await (
                await conn.execute(
                    "WITH RECURSIVE lineage(id, owner, depth) AS ("
                    "SELECT parent_run_id, principal_id, 0 FROM local_runs "
                    "WHERE id = ? AND parent_run_id IS NOT NULL UNION ALL "
                    "SELECT parent.parent_run_id, lineage.owner, lineage.depth + 1 "
                    "FROM local_runs AS parent JOIN lineage ON parent.id = lineage.id "
                    "WHERE parent.principal_id = lineage.owner "
                    "AND parent.parent_run_id IS NOT NULL AND lineage.depth < 64"
                    ") SELECT 1 FROM lineage JOIN local_runs AS ancestor "
                    "ON ancestor.id = lineage.id AND ancestor.principal_id = lineage.owner "
                    "WHERE lineage.id = ? LIMIT 1",
                    (current_run_id, prior_run_id),
                )
            ).fetchone()
            if ancestor is None:
                raise WaitDecisionConflictError(
                    "tool reconciliation source is not an owned ancestor"
                )
        now = _now()
        prior_status = "completed" if decision == "confirmed_completed" else "failed"
        prior_cursor = await conn.execute(
            "UPDATE local_tool_receipts SET status = ?, result_json = ?, result_hash = ?, "
            "error_type = ?, completed_at = ?, updated_at = ? "
            "WHERE operation_id = ? AND status = 'outcome_unknown'",
            (
                prior_status,
                prior_result_json,
                prior_result_hash,
                None if prior_status == "completed" else "ReconciledByUser",
                now,
                now,
                prior_operation_id,
            ),
        )
        if prior_cursor.rowcount != 1:
            raise WaitDecisionConflictError(
                "tool reconciliation source is no longer outcome_unknown"
            )
        if prior_operation_id == candidate_id and decision == "retry_not_executed":
            await conn.execute(
                "UPDATE local_tool_receipts SET status = 'prepared', result_json = NULL, "
                "result_hash = NULL, error_type = NULL, completed_at = NULL, updated_at = ? "
                "WHERE operation_id = ?",
                (now, candidate_id),
            )
        elif prior_operation_id != candidate_id and decision != "retry_not_executed":
            current_status = "completed" if decision == "confirmed_completed" else "failed"
            current_cursor = await conn.execute(
                "UPDATE local_tool_receipts SET status = ?, result_json = ?, "
                "result_hash = ?, error_type = ?, completed_at = ?, updated_at = ? "
                "WHERE operation_id = ? AND run_id = ? AND status = 'prepared'",
                (
                    current_status,
                    current_result_json,
                    current_result_hash,
                    None if current_status == "completed" else "ReconciledByUser",
                    now,
                    now,
                    candidate_id,
                    current_run_id,
                ),
            )
            if current_cursor.rowcount != 1:
                raise WaitDecisionConflictError(
                    "current tool reconciliation receipt is no longer prepared"
                )
        cursor = await conn.execute(
            "UPDATE local_wait_candidates SET status = 'resolved', decision_json = ?, "
            "resolved_at = ? WHERE id = ? AND status = 'pending'",
            (decision_json, now, candidate_id),
        )
        if cursor.rowcount != 1:
            raise WaitDecisionConflictError("tool reconciliation was resolved concurrently")
        updated = await (
            await conn.execute(
                "SELECT * FROM local_wait_candidates WHERE id = ?",
                (candidate_id,),
            )
        ).fetchone()
        assert updated is not None
        return dict(updated), True

    # --- artifacts ---

    async def create_artifact(
        self,
        *,
        artifact_id: str | None = None,
        run_id: str,
        kind: str,
        title: str,
        content: str,
        content_type: str = "text/plain",
        tool_call_id: str | None = None,
        tool_name: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        record = {
            "id": artifact_id or _new_id("art"),
            "run_id": run_id,
            "kind": kind,
            "title": title,
            "content": content,
            "content_type": content_type,
            "bytes": len(content.encode("utf-8")),
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "metadata_json": json.dumps(metadata or {}, ensure_ascii=False, default=str),
            "created_at": _now(),
        }
        if record["bytes"] > MAX_ARTIFACT_BYTES:
            raise ArtifactQuotaError("artifact exceeds the per-item byte limit")
        async with self.run_write_transaction(run_id) as conn:
            if artifact_id:
                existing = await (
                    await conn.execute(
                        "SELECT * FROM local_artifacts WHERE id = ? AND run_id = ?",
                        (record["id"], run_id),
                    )
                ).fetchone()
                if existing is not None:
                    return dict(existing)
            owner = await (
                await conn.execute("SELECT principal_id FROM local_runs WHERE id = ?", (run_id,))
            ).fetchone()
            if owner is None:
                raise KeyError(f"unknown run: {run_id}")
            run_bytes = int(
                (
                    await (
                        await conn.execute(
                            "SELECT COALESCE(SUM(bytes), 0) FROM local_artifacts WHERE run_id = ?",
                            (run_id,),
                        )
                    ).fetchone()
                )[0]
            )
            principal_bytes = int(
                (
                    await (
                        await conn.execute(
                            "SELECT COALESCE(SUM(local_artifacts.bytes), 0) "
                            "FROM local_artifacts JOIN local_runs "
                            "ON local_runs.id = local_artifacts.run_id "
                            "WHERE local_runs.principal_id = ?",
                            (owner[0],),
                        )
                    ).fetchone()
                )[0]
            )
            total_bytes = int(
                (
                    await (
                        await conn.execute("SELECT COALESCE(SUM(bytes), 0) FROM local_artifacts")
                    ).fetchone()
                )[0]
            )
            if run_bytes + record["bytes"] > MAX_RUN_ARTIFACT_BYTES:
                raise ArtifactQuotaError("run artifact byte limit exceeded")
            if principal_bytes + record["bytes"] > MAX_PRINCIPAL_ARTIFACT_BYTES:
                raise ArtifactQuotaError("principal artifact byte limit exceeded")
            if total_bytes + record["bytes"] > MAX_TOTAL_ARTIFACT_BYTES:
                raise ArtifactQuotaError("local artifact database byte limit exceeded")
            cursor = await conn.execute(
                f"INSERT {'OR IGNORE ' if artifact_id else ''}INTO local_artifacts "
                "(id, run_id, kind, title, content, "
                " content_type, bytes, tool_call_id, tool_name, metadata_json, created_at) "
                "VALUES (:id, :run_id, :kind, :title, :content, :content_type, :bytes, "
                "        :tool_call_id, :tool_name, :metadata_json, :created_at)",
                record,
            )
            if cursor.rowcount == 0:
                existing = await (
                    await conn.execute(
                        "SELECT * FROM local_artifacts WHERE id = ? AND run_id = ?",
                        (record["id"], run_id),
                    )
                ).fetchone()
                if existing is None:
                    raise ValueError("artifact identity belongs to another run")
                return dict(existing)
        return record

    async def get_artifact(self, artifact_id: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM local_artifacts WHERE id = ?", (artifact_id,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def list_artifacts_for_run(self, run_id: str) -> list[dict[str, Any]]:
        cursor = await self._conn.execute(
            "SELECT * FROM local_artifacts WHERE run_id = ? ORDER BY created_at",
            (run_id,),
        )
        return [
            {**dict(row), "metadata": json.loads(row["metadata_json"] or "{}")}
            for row in await cursor.fetchall()
        ]
