"""Database invariants that must hold on every Runtime connection."""

from __future__ import annotations

import sqlite3

import pytest

from local_host.store.sqlite import ArtifactConflictError, LocalStore


@pytest.mark.asyncio
async def test_foreign_keys_are_enforced_on_primary_and_transaction_connections(
    tmp_path,
) -> None:
    store = await LocalStore.open(tmp_path / "local.db")
    try:
        with pytest.raises(sqlite3.IntegrityError):
            await store._conn.execute(
                "INSERT INTO local_events "
                "(id, run_id, seq, event_type, payload_json, created_at) "
                "VALUES ('event_orphan_primary', 'run_missing', 1, 'test', '{}', 'now')"
            )
        await store._conn.rollback()

        with pytest.raises(sqlite3.IntegrityError):
            async with store.run_write_transaction("run_missing") as conn:
                await conn.execute(
                    "INSERT INTO local_events "
                    "(id, run_id, seq, event_type, payload_json, created_at) "
                    "VALUES ('event_orphan_transaction', 'run_missing', 1, 'test', '{}', 'now')"
                )
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_failed_primary_write_does_not_leave_an_open_transaction(tmp_path) -> None:
    store = await LocalStore.open(tmp_path / "local.db")
    try:
        run = await store.create_run(
            principal_id="local:owner",
            goal="test",
            workspace_path=None,
        )
        await store._conn.execute(
            "CREATE TRIGGER reject_runtime_settings "
            "BEFORE INSERT ON local_runtime_settings "
            "BEGIN SELECT RAISE(ABORT, 'settings blocked'); END"
        )
        await store._conn.commit()

        with pytest.raises(sqlite3.IntegrityError, match="settings blocked"):
            await store.patch_runtime_settings({}, initial_settings={})

        assert not store._conn.in_transaction
        event = await store.append_event(run["id"], "test.completed", {})
        assert event["seq"] == 1
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_artifact_id_replay_rejects_changed_content(tmp_path) -> None:
    store = await LocalStore.open(tmp_path / "local.db")
    try:
        run = await store.create_run(
            principal_id="local:owner",
            goal="test",
            workspace_path=None,
        )
        first = await store.create_artifact(
            artifact_id="artifact_stable",
            run_id=run["id"],
            kind="result",
            title="Result",
            content="original",
            metadata={"source": "tool"},
        )
        replay = await store.create_artifact(
            artifact_id="artifact_stable",
            run_id=run["id"],
            kind="result",
            title="Result",
            content="original",
            metadata={"source": "tool"},
        )
        assert replay == first

        with pytest.raises(ArtifactConflictError):
            await store.create_artifact(
                artifact_id="artifact_stable",
                run_id=run["id"],
                kind="result",
                title="Result",
                content="changed",
                metadata={"source": "tool"},
            )
        assert (await store.get_artifact("artifact_stable"))["content"] == "original"
    finally:
        await store.close()
