"""SQLite-backed local store. Async via aiosqlite.

Schema mirrors the Node daemon's tables conceptually but is intentionally
slimmer: anything LangGraph owns (message history, graph checkpoints) lives
in `agent.db` via AsyncSqliteSaver, not here.

Tables in this file:
- `local_workspaces`  — authorized filesystem roots
- `local_runs`        — run metadata (status, goal, parent, settings, metadata)
- `local_events`      — append-only event log (one row per emit)
- `local_permissions` — pending / resolved permission requests
- `local_questions`   — pending / answered user questions
- `local_artifacts`   — tool-produced artifacts (file content, snapshots)
- `local_steering`    — user instructions queued into an active run
- `local_plan_approvals` — pending / resolved plan-mode approvals
- `local_scheduled_runs` — local-only delayed run requests
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import aiosqlite

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS local_workspaces (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_runs (
    id TEXT PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS local_scheduled_runs (
    id TEXT PRIMARY KEY,
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
    tool_name TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    status TEXT NOT NULL,                -- pending | approved | denied
    scope TEXT NOT NULL DEFAULT 'once',  -- once | run
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY (run_id) REFERENCES local_runs(id)
);

CREATE TABLE IF NOT EXISTS local_questions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    tool_call_id TEXT,
    questions_json TEXT NOT NULL,
    status TEXT NOT NULL,                -- pending | answered
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
    todos_json TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | modified | rejected
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

    def __init__(self, conn: aiosqlite.Connection) -> None:
        self._conn = conn

    @classmethod
    async def open(cls, db_path: Path) -> LocalStore:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = await aiosqlite.connect(str(db_path))
        conn.row_factory = aiosqlite.Row
        await conn.executescript(SCHEMA)
        await cls._ensure_columns(conn)
        await conn.commit()
        return cls(conn)

    @staticmethod
    async def _ensure_columns(conn: aiosqlite.Connection) -> None:
        """Additive migrations for DBs created before a column existed.
        `CREATE TABLE IF NOT EXISTS` never alters an existing table, so a new
        column has to be added explicitly. SQLite ADD COLUMN is cheap + safe."""
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
        # Lark integration was removed; delete its local-only cache and todo data.
        for table in (
            "local_todo_items",
            "local_lark_messages",
            "local_lark_sources",
            "local_lark_connections",
        ):
            await conn.execute(f"DROP TABLE IF EXISTS {table}")

    async def close(self) -> None:
        await self._conn.close()

    # --- workspaces ---

    async def create_workspace(self, *, path: str, label: str) -> dict[str, Any]:
        ws = {
            "id": _new_id("ws"),
            "path": path,
            "label": label,
            "created_at": _now(),
            "last_used_at": _now(),
        }
        try:
            await self._conn.execute(
                "INSERT INTO local_workspaces (id, path, label, created_at, last_used_at) "
                "VALUES (:id, :path, :label, :created_at, :last_used_at)",
                ws,
            )
            await self._conn.commit()
        except aiosqlite.IntegrityError:
            # path already registered — return the existing record
            row = await (
                await self._conn.execute("SELECT * FROM local_workspaces WHERE path = ?", (path,))
            ).fetchone()
            assert row is not None
            return dict(row)
        return ws

    async def list_workspaces(self) -> list[dict[str, Any]]:
        cursor = await self._conn.execute(
            "SELECT * FROM local_workspaces ORDER BY last_used_at DESC"
        )
        return [dict(row) for row in await cursor.fetchall()]

    async def workspace_by_path(self, path: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute("SELECT * FROM local_workspaces WHERE path = ?", (path,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def delete_workspace(self, workspace_id: str) -> bool:
        cursor = await self._conn.execute(
            "DELETE FROM local_workspaces WHERE id = ?", (workspace_id,)
        )
        await self._conn.commit()
        return cursor.rowcount > 0

    async def touch_workspace(self, workspace_id: str) -> None:
        await self._conn.execute(
            "UPDATE local_workspaces SET last_used_at = ? WHERE id = ?",
            (_now(), workspace_id),
        )
        await self._conn.commit()

    # --- runs ---

    async def create_run(
        self,
        *,
        goal: str,
        workspace_path: str | None,
        parent_run_id: str | None = None,
        settings: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        mode: str = "fast",
    ) -> dict[str, Any]:
        run = {
            "id": _new_id("run"),
            "goal": goal,
            "workspace_path": workspace_path,
            "status": "queued",
            "history_json": "[]",
            "parent_run_id": parent_run_id,
            "settings_json": json.dumps(settings or {}, ensure_ascii=False),
            "metadata_json": json.dumps(metadata or {}, ensure_ascii=False, default=str),
            "mode": mode,
            "created_at": _now(),
            "updated_at": _now(),
            "completed_at": None,
        }
        await self._conn.execute(
            "INSERT INTO local_runs "
            "(id, goal, workspace_path, status, history_json, parent_run_id, "
            " settings_json, metadata_json, mode, created_at, updated_at, completed_at) "
            "VALUES (:id, :goal, :workspace_path, :status, :history_json, "
            "        :parent_run_id, :settings_json, :metadata_json, :mode, :created_at, "
            "        :updated_at, :completed_at)",
            run,
        )
        await self._conn.commit()
        return run

    async def update_run_mode(self, run_id: str, mode: str) -> None:
        """Persist the RESOLVED tier (fast|deep) once classification settles,
        so a resume after restart continues at the right tier."""
        await self._conn.execute(
            "UPDATE local_runs SET mode = ?, updated_at = ? WHERE id = ?",
            (mode, _now(), run_id),
        )
        await self._conn.commit()

    async def list_active_runs(self) -> list[dict[str, Any]]:
        """Runs not in a terminal state — used at boot to recover orphans left
        behind by a daemon restart (queued/running are dead and must be failed;
        waiting_permission/waiting_input are resumable from the checkpointer)."""
        cursor = await self._conn.execute(
            "SELECT * FROM local_runs WHERE status IN "
            "('queued', 'running', 'waiting_permission', 'waiting_input')"
        )
        return [dict(row) for row in await cursor.fetchall()]

    async def grants_for_run(self, run_id: str) -> list[str]:
        """Tool names approved with scope='run' for this run — lets the
        auto-approve loop rehydrate scope=run grants after a restart."""
        cursor = await self._conn.execute(
            "SELECT DISTINCT tool_name FROM local_permissions "
            "WHERE run_id = ? AND scope = 'run' AND status = 'approved'",
            (run_id,),
        )
        return [row[0] for row in await cursor.fetchall()]

    async def get_run(self, run_id: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute("SELECT * FROM local_runs WHERE id = ?", (run_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def list_runs(self, *, limit: int = 50) -> list[dict[str, Any]]:
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
            SELECT r.id, r.goal, r.status, r.workspace_path,
                   r.created_at, r.updated_at, r.completed_at,
                   r.metadata_json,
                   (SELECT COUNT(*) FROM local_events e
                      WHERE e.run_id = r.id) AS events_count
              FROM local_runs r
             ORDER BY datetime(r.updated_at) DESC, r.id DESC
             LIMIT ?
            """,
            (limit,),
        )
        return [dict(row) for row in await cursor.fetchall()]

    async def update_run_status(
        self, run_id: str, status: str, *, completed_at: str | None = None
    ) -> None:
        await self._conn.execute(
            "UPDATE local_runs SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?",
            (status, _now(), completed_at, run_id),
        )
        await self._conn.commit()

    # --- scheduled runs ---

    async def create_scheduled_run(
        self,
        *,
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
        await self._conn.execute(
            "INSERT INTO local_scheduled_runs "
            "(id, goal, workspace_path, model, history_json, settings_json, metadata_json, "
            " run_at, status, run_id, result_text, error_message, created_at, updated_at, "
            " completed_at, notified_at) "
            "VALUES (:id, :goal, :workspace_path, :model, :history_json, :settings_json, "
            "        :metadata_json, :run_at, :status, :run_id, :result_text, :error_message, "
            "        :created_at, :updated_at, :completed_at, :notified_at)",
            record,
        )
        await self._conn.commit()
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

    async def cancel_scheduled_run(self, schedule_id: str) -> dict[str, Any] | None:
        existing = await self.get_scheduled_run(schedule_id)
        if existing is None:
            return None
        if existing["status"] != "scheduled":
            return existing
        canceled_at = _now()
        await self._conn.execute(
            "UPDATE local_scheduled_runs "
            "SET status = 'canceled', completed_at = ?, updated_at = ? WHERE id = ?",
            (canceled_at, canceled_at, schedule_id),
        )
        await self._conn.commit()
        return await self.get_scheduled_run(schedule_id)

    async def mark_scheduled_run_notified(self, schedule_id: str) -> dict[str, Any] | None:
        await self._conn.execute(
            "UPDATE local_scheduled_runs SET notified_at = ?, updated_at = ? WHERE id = ?",
            (_now(), _now(), schedule_id),
        )
        await self._conn.commit()
        return await self.get_scheduled_run(schedule_id)

    # --- events ---

    async def append_event(
        self,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        cursor = await self._conn.execute(
            "SELECT COALESCE(MAX(seq), 0) FROM local_events WHERE run_id = ?", (run_id,)
        )
        row = await cursor.fetchone()
        next_seq = (row[0] if row else 0) + 1
        event = {
            "id": _new_id("evt"),
            "run_id": run_id,
            "seq": next_seq,
            "event_type": event_type,
            "payload_json": json.dumps(payload, ensure_ascii=False, default=str),
            "created_at": _now(),
        }
        await self._conn.execute(
            "INSERT INTO local_events (id, run_id, seq, event_type, payload_json, created_at) "
            "VALUES (:id, :run_id, :seq, :event_type, :payload_json, :created_at)",
            event,
        )
        await self._conn.commit()
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
        cursor = await self._conn.execute(
            "SELECT * FROM local_steering "
            "WHERE run_id = ? AND status = 'pending' "
            "ORDER BY created_at, id",
            (run_id,),
        )
        rows = [dict(row) for row in await cursor.fetchall()]
        if not rows:
            return []
        injected_at = _now()
        await self._conn.executemany(
            "UPDATE local_steering SET status = 'injected', injected_at = ? "
            "WHERE id = ? AND status = 'pending'",
            [(injected_at, row["id"]) for row in rows],
        )
        await self._conn.commit()
        return [{**row, "status": "injected", "injected_at": injected_at} for row in rows]

    # --- plan approvals ---

    async def create_plan_approval(
        self,
        *,
        run_id: str,
        tool_call_id: str,
        todos: list[dict[str, Any]],
        summary: str = "",
    ) -> dict[str, Any]:
        record = {
            "id": _new_id("plan"),
            "run_id": run_id,
            "tool_call_id": tool_call_id,
            "todos_json": json.dumps(todos, ensure_ascii=False, default=str),
            "summary": summary,
            "status": "pending",
            "instructions": None,
            "created_at": _now(),
            "resolved_at": None,
        }
        try:
            await self._conn.execute(
                "INSERT INTO local_plan_approvals "
                "(id, run_id, tool_call_id, todos_json, summary, status, instructions, created_at, resolved_at) "
                "VALUES (:id, :run_id, :tool_call_id, :todos_json, :summary, :status, :instructions, :created_at, :resolved_at)",
                record,
            )
            await self._conn.commit()
        except aiosqlite.IntegrityError:
            existing = await self.get_plan_approval_by_tool_call(
                run_id=run_id,
                tool_call_id=tool_call_id,
            )
            assert existing is not None
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

    async def resolve_plan_approval(
        self,
        approval_id: str,
        *,
        status: str,
        instructions: str | None = None,
    ) -> dict[str, Any] | None:
        await self._conn.execute(
            "UPDATE local_plan_approvals SET status = ?, instructions = ?, resolved_at = ? WHERE id = ?",
            (status, instructions, _now(), approval_id),
        )
        await self._conn.commit()
        return await self.get_plan_approval(approval_id)

    # --- permissions (HumanInTheLoop pause record) ---

    async def create_permission(
        self,
        *,
        run_id: str,
        tool_call_id: str,
        tool_name: str,
        arguments: dict[str, Any],
        scope: str = "once",
    ) -> dict[str, Any]:
        """Record a tool-approval request raised by `HumanInTheLoopMiddleware`.

        The returned `id` is what gets surfaced to the renderer as the
        `request_id` in the `permission.required` SSE event, and what
        the client posts back to `POST /local/v1/permissions/{id}` to
        approve or deny. Without this row, the client cannot look up
        which paused run to resume.
        """
        record = {
            "id": _new_id("perm"),
            "run_id": run_id,
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "arguments_json": json.dumps(arguments or {}, ensure_ascii=False, default=str),
            "status": "pending",
            "scope": scope,
            "created_at": _now(),
            "resolved_at": None,
        }
        await self._conn.execute(
            "INSERT INTO local_permissions (id, run_id, tool_call_id, tool_name, "
            " arguments_json, status, scope, created_at, resolved_at) "
            "VALUES (:id, :run_id, :tool_call_id, :tool_name, :arguments_json, "
            "        :status, :scope, :created_at, :resolved_at)",
            record,
        )
        await self._conn.commit()
        return record

    async def get_permission(self, permission_id: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM local_permissions WHERE id = ?", (permission_id,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def resolve_permission(
        self,
        permission_id: str,
        *,
        status: str,
        scope: str | None = None,
    ) -> dict[str, Any] | None:
        if scope:
            await self._conn.execute(
                "UPDATE local_permissions SET status = ?, scope = ?, resolved_at = ? WHERE id = ?",
                (status, scope, _now(), permission_id),
            )
        else:
            await self._conn.execute(
                "UPDATE local_permissions SET status = ?, resolved_at = ? WHERE id = ?",
                (status, _now(), permission_id),
            )
        await self._conn.commit()
        return await self.get_permission(permission_id)

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
    ) -> dict[str, Any]:
        """Record a `user.ask` interrupt.

        `questions` is a list to allow future multi-question interrupts;
        today user.ask emits one. The returned `id` is the `request_id`
        the client posts back via `POST /local/v1/questions/{id}` with
        `{answers}`.
        """
        record = {
            "id": _new_id("q"),
            "run_id": run_id,
            "tool_call_id": tool_call_id,
            "questions_json": json.dumps(questions, ensure_ascii=False, default=str),
            "status": "pending",
            "answers_json": None,
            "created_at": _now(),
            "answered_at": None,
        }
        await self._conn.execute(
            "INSERT INTO local_questions (id, run_id, tool_call_id, questions_json, "
            " status, answers_json, created_at, answered_at) "
            "VALUES (:id, :run_id, :tool_call_id, :questions_json, :status, "
            "        :answers_json, :created_at, :answered_at)",
            record,
        )
        await self._conn.commit()
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
    ) -> dict[str, Any] | None:
        await self._conn.execute(
            "UPDATE local_questions SET status = ?, answers_json = ?, answered_at = ? WHERE id = ?",
            (
                "answered",
                json.dumps(answers, ensure_ascii=False, default=str),
                _now(),
                question_id,
            ),
        )
        await self._conn.commit()
        return await self.get_question(question_id)

    # --- artifacts ---

    async def create_artifact(
        self,
        *,
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
            "id": _new_id("art"),
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
        await self._conn.execute(
            "INSERT INTO local_artifacts (id, run_id, kind, title, content, "
            " content_type, bytes, tool_call_id, tool_name, metadata_json, created_at) "
            "VALUES (:id, :run_id, :kind, :title, :content, :content_type, :bytes, "
            "        :tool_call_id, :tool_name, :metadata_json, :created_at)",
            record,
        )
        await self._conn.commit()
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
