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
- `local_lark_*`      — local-only Lark connector metadata, sources, messages, todos
"""

from __future__ import annotations

import json
import uuid
from contextlib import suppress
from datetime import UTC, datetime, timedelta
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

CREATE TABLE IF NOT EXISTS local_lark_connections (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'lark',
    status TEXT NOT NULL DEFAULT 'disconnected',
    tenant_label TEXT NOT NULL DEFAULT '',
    account_label TEXT NOT NULL DEFAULT '',
    auth_mode TEXT NOT NULL DEFAULT 'lark_cli',
    cloud_extraction_enabled INTEGER NOT NULL DEFAULT 1,
    data_retention_days INTEGER NOT NULL DEFAULT 7,
    auto_sync_enabled INTEGER NOT NULL DEFAULT 0,
    auto_sync_interval_minutes INTEGER NOT NULL DEFAULT 5,
    last_checked_at TEXT,
    last_auto_synced_at TEXT,
    last_error_code TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(provider)
);

CREATE TABLE IF NOT EXISTS local_lark_sources (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    provider_source_id_hash TEXT NOT NULL,
    source_type TEXT NOT NULL,
    display_label TEXT NOT NULL DEFAULT '',
    sync_enabled INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT,
    last_message_time TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (connection_id) REFERENCES local_lark_connections(id),
    UNIQUE(connection_id, provider_source_id_hash)
);
CREATE INDEX IF NOT EXISTS idx_local_lark_sources_connection
    ON local_lark_sources(connection_id, sync_enabled, updated_at);

CREATE TABLE IF NOT EXISTS local_lark_messages (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    provider_message_id_hash TEXT NOT NULL,
    sender_hash TEXT NOT NULL DEFAULT '',
    message_type TEXT NOT NULL DEFAULT 'text',
    text TEXT NOT NULL DEFAULT '',
    redacted_text TEXT NOT NULL DEFAULT '',
    created_at_lark TEXT,
    received_at TEXT NOT NULL,
    raw_json_path TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (connection_id) REFERENCES local_lark_connections(id),
    FOREIGN KEY (source_id) REFERENCES local_lark_sources(id),
    UNIQUE(connection_id, provider_message_id_hash)
);
CREATE INDEX IF NOT EXISTS idx_local_lark_messages_source_time
    ON local_lark_messages(source_id, created_at_lark);

CREATE TABLE IF NOT EXISTS local_todo_items (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'lark',
    source_id TEXT,
    source_message_ids TEXT NOT NULL DEFAULT '[]',
    priority TEXT NOT NULL DEFAULT 'today',
    status TEXT NOT NULL DEFAULT 'open',
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    suggested_action TEXT NOT NULL DEFAULT 'none',
    due_at TEXT,
    confidence REAL NOT NULL DEFAULT 0,
    extraction_provider TEXT NOT NULL DEFAULT 'rules',
    evidence_preview TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (source_id) REFERENCES local_lark_sources(id)
);
CREATE INDEX IF NOT EXISTS idx_local_todo_items_provider_status_priority
    ON local_todo_items(provider, status, priority, updated_at);
"""


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _clamp_lark_retention_days(value: int | None) -> int:
    if value is None:
        return 7
    return max(1, min(30, int(value)))


def _clamp_lark_auto_sync_interval_minutes(value: int | None) -> int:
    if value is None:
        return 5
    return max(1, min(60, int(value)))


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


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


def _decode_lark_connection(record: dict[str, Any]) -> dict[str, Any]:
    return {
        **record,
        "cloud_extraction_enabled": bool(record.get("cloud_extraction_enabled")),
        "data_retention_days": _clamp_lark_retention_days(
            int(record.get("data_retention_days") or 7)
        ),
        "auto_sync_enabled": bool(record.get("auto_sync_enabled")),
        "auto_sync_interval_minutes": _clamp_lark_auto_sync_interval_minutes(
            int(record.get("auto_sync_interval_minutes") or 5)
        ),
    }


def _decode_lark_source(record: dict[str, Any]) -> dict[str, Any]:
    return {
        **record,
        "sync_enabled": bool(record.get("sync_enabled")),
    }


def _decode_todo_item(record: dict[str, Any]) -> dict[str, Any]:
    try:
        message_ids = json.loads(str(record.get("source_message_ids") or "[]"))
    except json.JSONDecodeError:
        message_ids = []
    return {
        **record,
        "source_message_ids": message_ids if isinstance(message_ids, list) else [],
        "confidence": float(record.get("confidence") or 0),
    }


def _decode_lark_message(record: dict[str, Any]) -> dict[str, Any]:
    return dict(record)


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
        await cls._ensure_columns(conn)
        await conn.commit()
        return cls(db_path, conn)

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
        cursor = await conn.execute("PRAGMA table_info(local_lark_connections)")
        lark_columns = {row[1] for row in await cursor.fetchall()}
        if "data_retention_days" not in lark_columns:
            await conn.execute(
                "ALTER TABLE local_lark_connections "
                "ADD COLUMN data_retention_days INTEGER NOT NULL DEFAULT 7"
            )
        if "auto_sync_enabled" not in lark_columns:
            await conn.execute(
                "ALTER TABLE local_lark_connections "
                "ADD COLUMN auto_sync_enabled INTEGER NOT NULL DEFAULT 0"
            )
        if "auto_sync_interval_minutes" not in lark_columns:
            await conn.execute(
                "ALTER TABLE local_lark_connections "
                "ADD COLUMN auto_sync_interval_minutes INTEGER NOT NULL DEFAULT 5"
            )
        if "last_auto_synced_at" not in lark_columns:
            await conn.execute(
                "ALTER TABLE local_lark_connections ADD COLUMN last_auto_synced_at TEXT"
            )

    async def close(self) -> None:
        await self._conn.close()

    # --- lark connector ---

    async def ensure_lark_connection(self) -> dict[str, Any]:
        cursor = await self._conn.execute(
            "SELECT * FROM local_lark_connections WHERE provider = ?", ("lark",)
        )
        row = await cursor.fetchone()
        if row is not None:
            return _decode_lark_connection(dict(row))

        now = _now()
        record = {
            "id": _new_id("lark_conn"),
            "provider": "lark",
            "status": "disconnected",
            "tenant_label": "",
            "account_label": "",
            "auth_mode": "lark_cli",
            "cloud_extraction_enabled": 1,
            "data_retention_days": 7,
            "auto_sync_enabled": 0,
            "auto_sync_interval_minutes": 5,
            "last_checked_at": None,
            "last_auto_synced_at": None,
            "last_error_code": "",
            "created_at": now,
            "updated_at": now,
        }
        try:
            await self._conn.execute(
                "INSERT INTO local_lark_connections (id, provider, status, tenant_label, "
                "account_label, auth_mode, cloud_extraction_enabled, data_retention_days, "
                "auto_sync_enabled, auto_sync_interval_minutes, last_checked_at, "
                "last_auto_synced_at, last_error_code, created_at, updated_at) VALUES "
                "(:id, :provider, :status, :tenant_label, :account_label, :auth_mode, "
                ":cloud_extraction_enabled, :data_retention_days, :auto_sync_enabled, "
                ":auto_sync_interval_minutes, :last_checked_at, :last_auto_synced_at, "
                ":last_error_code, :created_at, :updated_at)",
                record,
            )
            await self._conn.commit()
        except aiosqlite.IntegrityError:
            cursor = await self._conn.execute(
                "SELECT * FROM local_lark_connections WHERE provider = ?", ("lark",)
            )
            row = await cursor.fetchone()
            if row is not None:
                return _decode_lark_connection(dict(row))
            raise
        return _decode_lark_connection(record)

    async def update_lark_connection(
        self,
        *,
        status: str | None = None,
        tenant_label: str | None = None,
        account_label: str | None = None,
        cloud_extraction_enabled: bool | None = None,
        data_retention_days: int | None = None,
        auto_sync_enabled: bool | None = None,
        auto_sync_interval_minutes: int | None = None,
        last_checked_at: str | None = None,
        last_auto_synced_at: str | None = None,
        last_error_code: str | None = None,
    ) -> dict[str, Any]:
        connection = await self.ensure_lark_connection()
        values: dict[str, Any] = {"id": connection["id"], "updated_at": _now()}
        assignments = ["updated_at = :updated_at"]
        if status is not None:
            values["status"] = status
            assignments.append("status = :status")
        if tenant_label is not None:
            values["tenant_label"] = tenant_label
            assignments.append("tenant_label = :tenant_label")
        if account_label is not None:
            values["account_label"] = account_label
            assignments.append("account_label = :account_label")
        if cloud_extraction_enabled is not None:
            values["cloud_extraction_enabled"] = int(cloud_extraction_enabled)
            assignments.append("cloud_extraction_enabled = :cloud_extraction_enabled")
        if data_retention_days is not None:
            values["data_retention_days"] = _clamp_lark_retention_days(data_retention_days)
            assignments.append("data_retention_days = :data_retention_days")
        if auto_sync_enabled is not None:
            values["auto_sync_enabled"] = int(auto_sync_enabled)
            assignments.append("auto_sync_enabled = :auto_sync_enabled")
        if auto_sync_interval_minutes is not None:
            values["auto_sync_interval_minutes"] = _clamp_lark_auto_sync_interval_minutes(
                auto_sync_interval_minutes
            )
            assignments.append("auto_sync_interval_minutes = :auto_sync_interval_minutes")
        if last_checked_at is not None:
            values["last_checked_at"] = last_checked_at
            assignments.append("last_checked_at = :last_checked_at")
        if last_auto_synced_at is not None:
            values["last_auto_synced_at"] = last_auto_synced_at
            assignments.append("last_auto_synced_at = :last_auto_synced_at")
        if last_error_code is not None:
            values["last_error_code"] = last_error_code
            assignments.append("last_error_code = :last_error_code")
        await self._conn.execute(
            f"UPDATE local_lark_connections SET {', '.join(assignments)} WHERE id = :id",
            values,
        )
        await self._conn.commit()
        updated = await self.ensure_lark_connection()
        return updated

    async def list_lark_sources(self) -> list[dict[str, Any]]:
        connection = await self.ensure_lark_connection()
        cursor = await self._conn.execute(
            "SELECT * FROM local_lark_sources WHERE connection_id = ? "
            "ORDER BY sync_enabled DESC, display_label COLLATE NOCASE ASC, updated_at DESC",
            (connection["id"],),
        )
        return [_decode_lark_source(dict(row)) for row in await cursor.fetchall()]

    async def get_lark_source(self, source_id: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM local_lark_sources WHERE id = ?", (source_id,)
        )
        row = await cursor.fetchone()
        return _decode_lark_source(dict(row)) if row else None

    async def upsert_lark_source(
        self,
        *,
        provider_source_id_hash: str,
        source_type: str,
        display_label: str = "",
        sync_enabled: bool | None = False,
    ) -> dict[str, Any]:
        connection = await self.ensure_lark_connection()
        cursor = await self._conn.execute(
            "SELECT * FROM local_lark_sources WHERE connection_id = ? "
            "AND provider_source_id_hash = ?",
            (connection["id"], provider_source_id_hash),
        )
        row = await cursor.fetchone()
        now = _now()
        if row is not None:
            assignments = ["source_type = ?", "display_label = ?"]
            params: list[Any] = [source_type, display_label]
            if sync_enabled is not None:
                assignments.append("sync_enabled = ?")
                params.append(int(sync_enabled))
            assignments.append("updated_at = ?")
            params.extend([now, row["id"]])
            await self._conn.execute(
                f"UPDATE local_lark_sources SET {', '.join(assignments)} WHERE id = ?",
                tuple(params),
            )
            await self._conn.commit()
            updated = await self.get_lark_source(str(row["id"]))
            assert updated is not None
            return updated

        record = {
            "id": _new_id("lark_src"),
            "connection_id": connection["id"],
            "provider_source_id_hash": provider_source_id_hash,
            "source_type": source_type,
            "display_label": display_label,
            "sync_enabled": int(bool(sync_enabled)),
            "last_synced_at": None,
            "last_message_time": None,
            "created_at": now,
            "updated_at": now,
        }
        await self._conn.execute(
            "INSERT INTO local_lark_sources (id, connection_id, provider_source_id_hash, "
            "source_type, display_label, sync_enabled, last_synced_at, last_message_time, "
            "created_at, updated_at) VALUES (:id, :connection_id, :provider_source_id_hash, "
            ":source_type, :display_label, :sync_enabled, :last_synced_at, "
            ":last_message_time, :created_at, :updated_at)",
            record,
        )
        await self._conn.commit()
        return _decode_lark_source(record)

    async def update_lark_source(
        self,
        source_id: str,
        *,
        display_label: str | None = None,
        sync_enabled: bool | None = None,
    ) -> dict[str, Any] | None:
        existing = await self.get_lark_source(source_id)
        if existing is None:
            return None
        values: dict[str, Any] = {"id": source_id, "updated_at": _now()}
        assignments = ["updated_at = :updated_at"]
        if display_label is not None:
            values["display_label"] = display_label
            assignments.append("display_label = :display_label")
        if sync_enabled is not None:
            values["sync_enabled"] = int(sync_enabled)
            assignments.append("sync_enabled = :sync_enabled")
        await self._conn.execute(
            f"UPDATE local_lark_sources SET {', '.join(assignments)} WHERE id = :id",
            values,
        )
        await self._conn.commit()
        return await self.get_lark_source(source_id)

    async def create_lark_message(
        self,
        *,
        source_id: str,
        provider_message_id_hash: str,
        sender_hash: str = "",
        message_type: str = "text",
        text: str = "",
        redacted_text: str = "",
        created_at_lark: str | None = None,
        raw_json_path: str = "",
    ) -> dict[str, Any]:
        source = await self.get_lark_source(source_id)
        if source is None:
            raise ValueError("lark source not found")
        now = _now()
        record = {
            "id": _new_id("lark_msg"),
            "connection_id": source["connection_id"],
            "source_id": source_id,
            "provider_message_id_hash": provider_message_id_hash,
            "sender_hash": sender_hash,
            "message_type": message_type,
            "text": text,
            "redacted_text": redacted_text,
            "created_at_lark": created_at_lark,
            "received_at": now,
            "raw_json_path": raw_json_path,
        }
        try:
            await self._conn.execute(
                "INSERT INTO local_lark_messages (id, connection_id, source_id, "
                "provider_message_id_hash, sender_hash, message_type, text, redacted_text, "
                "created_at_lark, received_at, raw_json_path) VALUES (:id, :connection_id, "
                ":source_id, :provider_message_id_hash, :sender_hash, :message_type, :text, "
                ":redacted_text, :created_at_lark, :received_at, :raw_json_path)",
                record,
            )
            await self._conn.commit()
        except aiosqlite.IntegrityError:
            cursor = await self._conn.execute(
                "SELECT * FROM local_lark_messages WHERE connection_id = ? "
                "AND provider_message_id_hash = ?",
                (source["connection_id"], provider_message_id_hash),
            )
            row = await cursor.fetchone()
            assert row is not None
            return _decode_lark_message(dict(row))
        return _decode_lark_message(record)

    async def list_lark_messages_for_sync(self, *, limit: int = 100) -> list[dict[str, Any]]:
        cursor = await self._conn.execute(
            "SELECT m.*, s.source_type, s.display_label, s.sync_enabled "
            "FROM local_lark_messages m "
            "JOIN local_lark_sources s ON s.id = m.source_id "
            "WHERE s.sync_enabled = 1 "
            "ORDER BY COALESCE(m.created_at_lark, m.received_at) DESC "
            "LIMIT ?",
            (limit,),
        )
        return [_decode_lark_message(dict(row)) for row in await cursor.fetchall()]

    async def clear_lark_cache(self) -> dict[str, int]:
        deleted_todos = await self._count_rows("local_todo_items", "provider = ?", ("lark",))
        deleted_messages = await self._count_rows("local_lark_messages")
        deleted_sources = await self._count_rows("local_lark_sources")
        raw_artifact_paths = await self._lark_raw_artifact_paths()
        await self._conn.execute("DELETE FROM local_todo_items WHERE provider = ?", ("lark",))
        await self._conn.execute("DELETE FROM local_lark_messages")
        await self._conn.execute("DELETE FROM local_lark_sources")
        await self._conn.commit()
        self._delete_lark_raw_artifacts(raw_artifact_paths)
        return {
            "deleted_sources": deleted_sources,
            "deleted_messages": deleted_messages,
            "deleted_todos": deleted_todos,
        }

    async def prune_lark_messages(
        self,
        *,
        retention_days: int | None = None,
        now: datetime | None = None,
    ) -> int:
        connection = await self.ensure_lark_connection()
        days = _clamp_lark_retention_days(
            retention_days
            if retention_days is not None
            else int(connection.get("data_retention_days") or 7)
        )
        cutoff = (now or datetime.now(UTC)).astimezone(UTC) - timedelta(days=days)
        cursor = await self._conn.execute(
            "SELECT id, created_at_lark, received_at, raw_json_path FROM local_lark_messages"
        )
        stale_ids: list[str] = []
        raw_artifact_paths: list[str] = []
        for row in await cursor.fetchall():
            record = dict(row)
            timestamp = _parse_iso_datetime(
                str(record.get("created_at_lark") or record.get("received_at") or "")
            )
            if timestamp is None or timestamp >= cutoff:
                continue
            stale_ids.append(str(record["id"]))
            raw_json_path = str(record.get("raw_json_path") or "")
            if raw_json_path:
                raw_artifact_paths.append(raw_json_path)
        if not stale_ids:
            return 0
        await self._conn.executemany(
            "DELETE FROM local_lark_messages WHERE id = ?",
            [(message_id,) for message_id in stale_ids],
        )
        await self._conn.commit()
        self._delete_lark_raw_artifacts(raw_artifact_paths)
        return len(stale_ids)

    async def _lark_raw_artifact_paths(self) -> list[str]:
        cursor = await self._conn.execute(
            "SELECT raw_json_path FROM local_lark_messages WHERE raw_json_path <> ''"
        )
        return [str(row[0]) for row in await cursor.fetchall() if row[0]]

    def _delete_lark_raw_artifacts(self, raw_artifact_paths: list[str]) -> None:
        data_root = self.db_path.parent.resolve()
        for raw_path in raw_artifact_paths:
            with suppress(OSError, RuntimeError):
                path = Path(raw_path).expanduser().resolve()
                if not path.is_relative_to(data_root) or not path.is_file():
                    continue
                path.unlink()

    async def _count_rows(
        self,
        table: str,
        where: str = "",
        params: tuple[Any, ...] = (),
    ) -> int:
        query = f"SELECT COUNT(*) FROM {table}"
        if where:
            query += f" WHERE {where}"
        cursor = await self._conn.execute(query, params)
        row = await cursor.fetchone()
        return int(row[0]) if row else 0

    async def todo_for_source_message_id(self, message_id: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute(
            "SELECT * FROM local_todo_items WHERE provider = ?",
            ("lark",),
        )
        for row in await cursor.fetchall():
            todo = _decode_todo_item(dict(row))
            if message_id in todo.get("source_message_ids", []):
                return todo
        return None

    async def create_todo_item(
        self,
        *,
        title: str,
        source_id: str | None = None,
        source_message_ids: list[str] | None = None,
        priority: str = "today",
        status: str = "open",
        summary: str = "",
        suggested_action: str = "none",
        due_at: str | None = None,
        confidence: float = 0,
        extraction_provider: str = "rules",
        evidence_preview: str = "",
    ) -> dict[str, Any]:
        now = _now()
        record = {
            "id": _new_id("todo"),
            "provider": "lark",
            "source_id": source_id,
            "source_message_ids": json.dumps(source_message_ids or [], ensure_ascii=False),
            "priority": priority,
            "status": status,
            "title": title,
            "summary": summary,
            "suggested_action": suggested_action,
            "due_at": due_at,
            "confidence": confidence,
            "extraction_provider": extraction_provider,
            "evidence_preview": evidence_preview,
            "created_at": now,
            "updated_at": now,
        }
        await self._conn.execute(
            "INSERT INTO local_todo_items (id, provider, source_id, source_message_ids, "
            "priority, status, title, summary, suggested_action, due_at, confidence, "
            "extraction_provider, evidence_preview, created_at, updated_at) VALUES "
            "(:id, :provider, :source_id, :source_message_ids, :priority, :status, "
            ":title, :summary, :suggested_action, :due_at, :confidence, "
            ":extraction_provider, :evidence_preview, :created_at, :updated_at)",
            record,
        )
        await self._conn.commit()
        return _decode_todo_item(record)

    async def get_todo_item(self, todo_id: str) -> dict[str, Any] | None:
        cursor = await self._conn.execute("SELECT * FROM local_todo_items WHERE id = ?", (todo_id,))
        row = await cursor.fetchone()
        return _decode_todo_item(dict(row)) if row else None

    async def list_todo_items(self, *, provider: str = "lark") -> list[dict[str, Any]]:
        cursor = await self._conn.execute(
            "SELECT * FROM local_todo_items WHERE provider = ? ORDER BY "
            "CASE priority WHEN 'now' THEN 0 WHEN 'today' THEN 1 "
            "WHEN 'later' THEN 2 ELSE 3 END, updated_at DESC",
            (provider,),
        )
        return [_decode_todo_item(dict(row)) for row in await cursor.fetchall()]

    async def update_todo_item(
        self,
        todo_id: str,
        *,
        priority: str | None = None,
        status: str | None = None,
        due_at: str | None = None,
    ) -> dict[str, Any] | None:
        existing = await self.get_todo_item(todo_id)
        if existing is None:
            return None
        values: dict[str, Any] = {"id": todo_id, "updated_at": _now()}
        assignments = ["updated_at = :updated_at"]
        if priority is not None:
            values["priority"] = priority
            assignments.append("priority = :priority")
        if status is not None:
            values["status"] = status
            assignments.append("status = :status")
        if due_at is not None:
            values["due_at"] = due_at
            assignments.append("due_at = :due_at")
        await self._conn.execute(
            f"UPDATE local_todo_items SET {', '.join(assignments)} WHERE id = :id",
            values,
        )
        await self._conn.commit()
        return await self.get_todo_item(todo_id)

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
