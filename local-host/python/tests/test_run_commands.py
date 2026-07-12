from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest

from local_host.auth import LOCAL_OWNER_PRINCIPAL_ID
from local_host.store.sqlite import (
    CommandConflictError,
    LocalStore,
    ParentRunAdmissionError,
    ThreadAdmissionError,
)


async def _accept(store: LocalStore, command_id: str, goal: str = "inspect"):
    return await store.accept_run_command(
        principal_id=LOCAL_OWNER_PRINCIPAL_ID,
        command_id=command_id,
        client_message_id="msg_client_1",
        command_payload={"type": "run.start", "goal": goal, "model": "auto"},
        goal=goal,
        workspace_path=None,
        mode="auto",
    )


async def test_concurrent_same_command_creates_one_run(tmp_path: Path) -> None:
    store = await LocalStore.open(tmp_path / "local.db")
    try:
        results = await asyncio.gather(*(_accept(store, "cmd_same") for _ in range(8)))

        assert len({run["id"] for run, _created in results}) == 1
        assert sum(created for _run, created in results) == 1
        assert len(await store.list_runs(principal_id=LOCAL_OWNER_PRINCIPAL_ID)) == 1
    finally:
        await store.close()


async def test_command_replay_survives_restart_and_conflicting_content_is_rejected(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "local.db"
    store = await LocalStore.open(db_path)
    first, created = await _accept(store, "cmd_durable")
    assert created is True
    await store.close()

    reopened = await LocalStore.open(db_path)
    try:
        replay, replay_created = await _accept(reopened, "cmd_durable")
        assert replay_created is False
        assert replay["id"] == first["id"]
        assert (await reopened.get_run(first["id"]))["command_id"] == "cmd_durable"

        with pytest.raises(CommandConflictError):
            await _accept(reopened, "cmd_durable", goal="different")
    finally:
        await reopened.close()


async def test_same_command_id_is_independent_for_each_principal(tmp_path: Path) -> None:
    store = await LocalStore.open(tmp_path / "local.db")
    try:
        first, first_created = await store.accept_run_command(
            principal_id="user:one",
            command_id="cmd_shared",
            client_message_id="msg_one",
            command_payload={"type": "run.start", "goal": "one"},
            goal="one",
            workspace_path=None,
            mode="auto",
        )
        second, second_created = await store.accept_run_command(
            principal_id="user:two",
            command_id="cmd_shared",
            client_message_id="msg_two",
            command_payload={"type": "run.start", "goal": "two"},
            goal="two",
            workspace_path=None,
            mode="auto",
        )

        assert first_created and second_created
        assert first["id"] != second["id"]
        assert first["principal_id"] == "user:one"
        assert second["principal_id"] == "user:two"
    finally:
        await store.close()


async def test_client_thread_ids_are_scoped_for_remote_principals(tmp_path: Path) -> None:
    store = await LocalStore.open(tmp_path / "local.db")
    try:
        accepted = []
        for principal in ("user:one", "user:two"):
            run, _created = await store.accept_run_command(
                principal_id=principal,
                command_id="cmd_same_logical_thread",
                client_message_id=f"msg_{principal}",
                assistant_message_id="assistant-shared",
                thread_id="conversation-shared",
                command_payload={"type": "run.start", "principal": principal},
                goal="isolated",
                workspace_path=None,
                mode="auto",
            )
            accepted.append(run)
        assert accepted[0]["thread_id"] != accepted[1]["thread_id"]
        assert accepted[0]["assistant_item_id"] != accepted[1]["assistant_item_id"]
        assert accepted[0]["thread_id"].startswith("pt_")
        assert accepted[1]["thread_id"].startswith("pt_")
        local, _created = await store.accept_run_command(
            principal_id=LOCAL_OWNER_PRINCIPAL_ID,
            command_id="cmd_local_remote_shaped_id",
            client_message_id="msg_local_remote_shaped_id",
            thread_id=str(accepted[0]["thread_id"]),
            command_payload={"type": "run.start", "principal": "local"},
            goal="isolated local",
            workspace_path=None,
            mode="auto",
        )
        assert local["thread_id"] != accepted[0]["thread_id"]
    finally:
        await store.close()


async def test_unsettled_parent_cannot_start_a_retry_child(tmp_path: Path) -> None:
    store = await LocalStore.open(tmp_path / "local.db")
    try:
        parent, _created = await _accept(store, "cmd_parent")
        await store.update_run_status(parent["id"], "cleanup_required")

        with pytest.raises(
            ParentRunAdmissionError,
            match="has not reached a safely settled state",
        ):
            await store.accept_run_command(
                principal_id=LOCAL_OWNER_PRINCIPAL_ID,
                command_id="cmd_retry_child",
                client_message_id="msg_retry_child",
                command_payload={"type": "run.start", "goal": "retry", "model": "auto"},
                goal="retry",
                workspace_path=None,
                mode="auto",
                parent_run_id=parent["id"],
                metadata={"intent": "retry"},
            )
    finally:
        await store.close()


async def test_thread_rejects_a_second_unsettled_turn(tmp_path: Path) -> None:
    store = await LocalStore.open(tmp_path / "local.db")
    try:
        await store.accept_run_command(
            principal_id=LOCAL_OWNER_PRINCIPAL_ID,
            command_id="cmd_thread_first",
            client_message_id="msg_thread_first",
            thread_id="thread_serial",
            command_payload={"type": "run.start", "goal": "first"},
            goal="first",
            workspace_path=None,
            mode="auto",
        )
        with pytest.raises(ThreadAdmissionError, match="unsettled run"):
            await store.accept_run_command(
                principal_id=LOCAL_OWNER_PRINCIPAL_ID,
                command_id="cmd_thread_second",
                client_message_id="msg_thread_second",
                thread_id="thread_serial",
                command_payload={"type": "run.start", "goal": "second"},
                goal="second",
                workspace_path=None,
                mode="auto",
            )
    finally:
        await store.close()


async def test_legacy_commands_migrate_to_the_local_owner(tmp_path: Path) -> None:
    db_path = tmp_path / "legacy.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        CREATE TABLE local_runs (
            id TEXT PRIMARY KEY, goal TEXT NOT NULL, workspace_path TEXT,
            status TEXT NOT NULL, history_json TEXT NOT NULL DEFAULT '[]',
            parent_run_id TEXT, settings_json TEXT NOT NULL DEFAULT '{}',
            metadata_json TEXT NOT NULL DEFAULT '{}', mode TEXT NOT NULL DEFAULT 'fast',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
        );
        CREATE TABLE local_commands (
            id TEXT PRIMARY KEY, command_type TEXT NOT NULL,
            client_message_id TEXT NOT NULL, payload_json TEXT NOT NULL,
            run_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
        );
        INSERT INTO local_runs
            (id, goal, status, created_at, updated_at)
            VALUES ('run_legacy', 'legacy', 'queued', '2026-01-01', '2026-01-01');
        INSERT INTO local_commands
            (id, command_type, client_message_id, payload_json, run_id, created_at)
            VALUES ('cmd_legacy', 'run.start', 'msg_legacy', '{}', 'run_legacy', '2026-01-01');
        """
    )
    conn.commit()
    conn.close()

    store = await LocalStore.open(db_path)
    try:
        run = await store.get_run("run_legacy")
        command = await store._conn.execute_fetchall(
            "SELECT principal_id FROM local_commands WHERE id = 'cmd_legacy'"
        )

        assert run is not None
        assert run["principal_id"] == LOCAL_OWNER_PRINCIPAL_ID
        assert command[0][0] == LOCAL_OWNER_PRINCIPAL_ID
    finally:
        await store.close()


async def test_workspaces_are_scoped_by_owner(tmp_path: Path) -> None:
    store = await LocalStore.open(tmp_path / "local.db")
    try:
        first = await store.create_workspace(
            principal_id="user:one",
            path=str(tmp_path),
            label="one",
        )
        second = await store.create_workspace(
            principal_id="user:two",
            path=str(tmp_path),
            label="two",
        )

        assert first["id"] != second["id"]
        assert [item["id"] for item in await store.list_workspaces(principal_id="user:one")] == [
            first["id"]
        ]
        assert (
            await store.delete_workspace(principal_id="user:one", workspace_id=second["id"])
            is False
        )
        assert await store.workspace_by_path(principal_id="user:two", path=str(tmp_path)) == second
    finally:
        await store.close()


async def test_legacy_workspaces_migrate_to_the_local_owner(tmp_path: Path) -> None:
    db_path = tmp_path / "legacy-workspace.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        CREATE TABLE local_workspaces (
            id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
            created_at TEXT NOT NULL, last_used_at TEXT NOT NULL
        );
        INSERT INTO local_workspaces
            (id, path, label, created_at, last_used_at)
            VALUES ('ws_legacy', '/legacy', 'legacy', '2026-01-01', '2026-01-01');
        """
    )
    conn.commit()
    conn.close()

    store = await LocalStore.open(db_path)
    try:
        workspaces = await store.list_workspaces(principal_id=LOCAL_OWNER_PRINCIPAL_ID)
        assert workspaces[0]["id"] == "ws_legacy"
        assert workspaces[0]["principal_id"] == LOCAL_OWNER_PRINCIPAL_ID
    finally:
        await store.close()
