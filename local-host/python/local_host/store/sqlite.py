"""SQLite-backed local store. Async via aiosqlite.

Schema mirrors the Node daemon's tables conceptually but is intentionally
slimmer: anything LangGraph owns (message history, graph checkpoints) lives
in `agent.db` via AsyncSqliteSaver, not here.

Tables in this file:
- `local_workspaces`  — authorized filesystem roots
- `local_runs`        — run metadata (status, goal, parent, settings)
- `local_events`      — append-only event log (one row per emit)
- `local_permissions` — pending / resolved permission requests
- `local_questions`   — pending / answered user questions
- `local_artifacts`   — tool-produced artifacts (file content, snapshots)
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

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
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


class LocalStore:
    """Thin async wrapper over aiosqlite. Connection-per-store."""

    def __init__(self, db_path: Path, conn: aiosqlite.Connection) -> None:
        self.db_path = db_path
        self._conn = conn

    @classmethod
    async def open(cls, db_path: Path) -> LocalStore:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = await aiosqlite.connect(str(db_path))
        conn.row_factory = aiosqlite.Row
        await conn.executescript(SCHEMA)
        await conn.commit()
        return cls(db_path, conn)

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
            row = await (await self._conn.execute(
                "SELECT * FROM local_workspaces WHERE path = ?", (path,)
            )).fetchone()
            assert row is not None
            return dict(row)
        return ws

    async def list_workspaces(self) -> list[dict[str, Any]]:
        cursor = await self._conn.execute(
            "SELECT * FROM local_workspaces ORDER BY last_used_at DESC"
        )
        return [dict(row) for row in await cursor.fetchall()]

    async def workspace_by_path(self, path: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM local_workspaces WHERE path = ?", (path,)
        )
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
    ) -> dict[str, Any]:
        run = {
            "id": _new_id("run"),
            "goal": goal,
            "workspace_path": workspace_path,
            "status": "queued",
            "history_json": "[]",
            "parent_run_id": parent_run_id,
            "settings_json": json.dumps(settings or {}, ensure_ascii=False),
            "created_at": _now(),
            "updated_at": _now(),
            "completed_at": None,
        }
        await self._conn.execute(
            "INSERT INTO local_runs "
            "(id, goal, workspace_path, status, history_json, parent_run_id, "
            " settings_json, created_at, updated_at, completed_at) "
            "VALUES (:id, :goal, :workspace_path, :status, :history_json, "
            "        :parent_run_id, :settings_json, :created_at, "
            "        :updated_at, :completed_at)",
            run,
        )
        await self._conn.commit()
        return run

    async def get_run(self, run_id: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM local_runs WHERE id = ?", (run_id,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None

    async def update_run_status(
        self, run_id: str, status: str, *, completed_at: str | None = None
    ) -> None:
        await self._conn.execute(
            "UPDATE local_runs SET status = ?, updated_at = ?, completed_at = ? "
            "WHERE id = ?",
            (status, _now(), completed_at, run_id),
        )
        await self._conn.commit()

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
