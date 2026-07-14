"""Database invariants that must hold on every Runtime connection."""

from __future__ import annotations

import sqlite3

import pytest

from local_host.store.sqlite import LocalStore


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
