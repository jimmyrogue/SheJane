"""Daemon restart recovery (P0): the RunCoordinator keeps per-run orchestration
state in memory, so a SIGKILL restart (routine via `make dev-electron`) used to
strand in-flight runs as `running` forever and silently downgrade HITL resumes
to the fast tier in a no-workspace sandbox. These tests lock the fix:

  - recover_orphans(): queued/running → failed, waiting_permission → kept.
  - _hydrate_run_state(): rebuild goal/workspace/mode/settings/grants from the
    DB so a resume after restart isn't degraded.
  - resolved tier (fast|deep) is persisted, not the requested mode.
"""

from __future__ import annotations

from pathlib import Path

from local_host.runs import RunCoordinator
from local_host.store.sqlite import LocalStore


async def _open_store(tmp_path: Path) -> LocalStore:
    return await LocalStore.open(tmp_path / "agent.db")


def _coordinator(store: LocalStore) -> RunCoordinator:
    # recover_orphans / _hydrate_run_state only touch the store, so a None
    # checkpointer/agent_store is fine for these unit tests.
    return RunCoordinator(store=store, checkpointer=None, agent_store=None)  # type: ignore[arg-type]


async def test_recover_orphans_fails_dead_runs_and_keeps_waiting(tmp_path: Path) -> None:
    store = await _open_store(tmp_path)
    try:
        running = await store.create_run(goal="g1", workspace_path="/ws", mode="deep")
        await store.update_run_status(running["id"], "running")
        queued = await store.create_run(goal="g2", workspace_path=None, mode="fast")
        # queued: create_run leaves status='queued'
        waiting = await store.create_run(goal="g3", workspace_path="/ws3", mode="deep")
        await store.update_run_status(waiting["id"], "waiting_permission")
        done = await store.create_run(goal="g4", workspace_path=None, mode="fast")
        await store.update_run_status(done["id"], "completed")

        # New coordinator = fresh process after a restart.
        await _coordinator(store).recover_orphans()

        assert (await store.get_run(running["id"]))["status"] == "failed"
        assert (await store.get_run(queued["id"]))["status"] == "failed"
        # Paused-at-interrupt run stays resumable.
        assert (await store.get_run(waiting["id"]))["status"] == "waiting_permission"
        # Terminal runs are untouched.
        assert (await store.get_run(done["id"]))["status"] == "completed"
    finally:
        await store.close()


async def test_hydrate_run_state_rebuilds_caches_from_db(tmp_path: Path) -> None:
    store = await _open_store(tmp_path)
    try:
        run = await store.create_run(
            goal="重构登录流程",
            workspace_path="/proj",
            settings={"memory": "off"},
            mode="deep",
        )
        rid = run["id"]
        await store.update_run_status(rid, "waiting_permission")
        # A scope=run grant approved before the restart.
        perm = await store.create_permission(
            run_id=rid, tool_call_id="c1", tool_name="fs.write", arguments={"path": "x"}
        )
        await store.resolve_permission(perm["id"], status="approved", scope="run")

        # Fresh coordinator with empty caches (post-restart).
        coord = _coordinator(store)
        assert await coord._hydrate_run_state(rid) is True

        assert coord._goals[rid] == "重构登录流程"
        assert coord._workspaces[rid] == "/proj"
        assert coord._modes[rid] == "deep"  # tier preserved, not downgraded to fast
        assert coord._settings_overrides[rid] == {"memory": "off"}
        assert coord._run_grants[rid] == {"fs.write"}

        # Idempotent: a second call is a no-op and still True.
        assert await coord._hydrate_run_state(rid) is True
        # Unknown run id → False (resume_run refuses).
        assert await coord._hydrate_run_state("run_missing") is False
    finally:
        await store.close()


async def test_create_run_persists_mode_and_update_run_mode(tmp_path: Path) -> None:
    store = await _open_store(tmp_path)
    try:
        run = await store.create_run(goal="g", workspace_path=None, mode="deep")
        assert (await store.get_run(run["id"]))["mode"] == "deep"
        # Resolved-tier write-back (e.g. auto → deep).
        await store.update_run_mode(run["id"], "fast")
        assert (await store.get_run(run["id"]))["mode"] == "fast"
    finally:
        await store.close()


async def test_ensure_columns_adds_mode_to_legacy_db(tmp_path: Path) -> None:
    # Simulate a DB created before the `mode` column existed, then reopen and
    # confirm the additive migration backfilled it with the 'fast' default.
    import aiosqlite

    db_path = tmp_path / "legacy.db"
    conn = await aiosqlite.connect(str(db_path))
    await conn.execute(
        "CREATE TABLE local_runs (id TEXT PRIMARY KEY, goal TEXT NOT NULL, "
        "workspace_path TEXT, status TEXT NOT NULL, history_json TEXT NOT NULL "
        "DEFAULT '[]', parent_run_id TEXT, settings_json TEXT NOT NULL DEFAULT "
        "'{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT)"
    )
    await conn.execute(
        "INSERT INTO local_runs (id, goal, status, created_at, updated_at) "
        "VALUES ('run_legacy', 'old goal', 'waiting_permission', 'now', 'now')"
    )
    await conn.commit()
    await conn.close()

    store = await LocalStore.open(db_path)
    try:
        legacy = await store.get_run("run_legacy")
        assert legacy is not None
        assert legacy["mode"] == "fast"  # backfilled by _ensure_columns
    finally:
        await store.close()
