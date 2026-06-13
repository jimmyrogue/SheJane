"""Scheduled local runs.

These tests lock the minimal P2 local scheduler contract:

- schedules are persisted in SQLite and due rows are claimed once;
- the dispatcher creates a normal local run through RunCoordinator and drains
  its stream so background runs cannot fill the live queue;
- HTTP routes expose create/list/cancel/notified for the Electron renderer.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from local_host.config import reset_settings_for_tests
from local_host.scheduler import ScheduledRunDispatcher
from local_host.server import create_app
from local_host.store.sqlite import LocalStore

HEADERS = {"Authorization": "Bearer tok"}


class FakeCoordinator:
    def __init__(self, store: LocalStore) -> None:
        self.store = store
        self.started: list[dict[str, Any]] = []

    async def start_run(self, **kwargs: Any) -> dict[str, Any]:
        self.started.append(kwargs)
        run = await self.store.create_run(
            goal=kwargs["goal"],
            workspace_path=kwargs.get("workspace_path"),
            parent_run_id=None,
            settings=kwargs.get("settings"),
            metadata=kwargs.get("metadata"),
            mode=kwargs.get("mode", "auto"),
        )
        await self.store.append_event(run["id"], "run.completed", {"final_text": "scheduled done"})
        await self.store.update_run_status(run["id"], "completed")
        return run

    async def stream(self, _run_id: str):
        if False:
            yield {}


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-schedules-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp,
    )
    app = create_app(settings)
    with TestClient(app) as c:
        yield c


async def test_store_claims_due_schedules_once(tmp_path: Path) -> None:
    store = await LocalStore.open(tmp_path / "local-host.db")
    try:
        now = datetime.now(UTC)
        due = await store.create_scheduled_run(
            goal="整理日报",
            run_at=(now - timedelta(seconds=5)).isoformat(),
            workspace_path="/work",
            model="auto",
            history=[{"role": "user", "content": "昨天做了什么"}],
            settings={"memory": "on"},
            metadata={"source": "test"},
        )
        future = await store.create_scheduled_run(
            goal="明天再跑",
            run_at=(now + timedelta(hours=1)).isoformat(),
        )

        claimed = await store.claim_due_scheduled_runs(now=now.isoformat())
        assert [row["id"] for row in claimed] == [due["id"]]
        assert claimed[0]["status"] == "running"
        assert json.loads(claimed[0]["history_json"]) == [
            {"role": "user", "content": "昨天做了什么"}
        ]

        assert await store.claim_due_scheduled_runs(now=now.isoformat()) == []
        assert (await store.get_scheduled_run(future["id"]))["status"] == "scheduled"
    finally:
        await store.close()


async def test_dispatcher_starts_due_schedule_and_marks_completed(tmp_path: Path) -> None:
    store = await LocalStore.open(tmp_path / "local-host.db")
    try:
        now = datetime.now(UTC)
        schedule = await store.create_scheduled_run(
            goal="跑一次本地检查",
            run_at=(now - timedelta(seconds=1)).isoformat(),
            workspace_path="/repo",
            model="auto",
            settings={"skills": "on"},
            metadata={"kind": "nightly"},
        )
        coordinator = FakeCoordinator(store)
        dispatcher = ScheduledRunDispatcher(store=store, coordinator=coordinator, poll_interval=60)

        await dispatcher.tick(now=now)

        updated = await store.get_scheduled_run(schedule["id"])
        assert updated["status"] == "completed"
        assert updated["run_id"].startswith("run_")
        assert updated["result_text"] == "scheduled done"
        assert coordinator.started == [
            {
                "goal": "跑一次本地检查",
                "workspace_path": "/repo",
                "mode": "auto",
                "history": [],
                "settings": {"skills": "on"},
                "metadata": {
                    "kind": "nightly",
                    "intent": "scheduled_run",
                    "scheduled_run_id": schedule["id"],
                },
            }
        ]
    finally:
        await store.close()


def test_schedule_http_create_list_cancel_and_mark_notified(client: TestClient) -> None:
    future = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    created = client.post(
        "/local/v1/schedules",
        headers=HEADERS,
        json={
            "goal": "稍后总结项目",
            "run_at": future,
            "workspace_path": "/repo",
            "model": "auto",
            "history": [{"role": "user", "content": "项目背景"}],
            "settings": {"memory": "on"},
        },
    )
    assert created.status_code == 200
    schedule = created.json()
    assert schedule["id"].startswith("sched_")
    assert schedule["status"] == "scheduled"
    assert schedule["goal"] == "稍后总结项目"

    listed = client.get("/local/v1/schedules", headers=HEADERS)
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["schedules"]] == [schedule["id"]]

    store = client.app.state.store

    async def finish_schedule() -> None:
        run = await store.create_run(goal="done", workspace_path=None)
        await store.mark_scheduled_run_started(schedule["id"], run["id"])
        await store.complete_scheduled_run(
            schedule["id"],
            status="completed",
            result_text="计划任务完成",
        )

    asyncio.run(finish_schedule())
    pending = client.get("/local/v1/schedules?notify_pending=true", headers=HEADERS)
    assert pending.status_code == 200
    assert pending.json()["schedules"][0]["result_text"] == "计划任务完成"

    marked = client.post(f"/local/v1/schedules/{schedule['id']}/notified", headers=HEADERS)
    assert marked.status_code == 200
    assert marked.json()["notified_at"]
    assert client.get("/local/v1/schedules?notify_pending=true", headers=HEADERS).json() == {
        "schedules": []
    }

    other = client.post(
        "/local/v1/schedules",
        headers=HEADERS,
        json={"goal": "取消这个", "run_at": future},
    ).json()
    canceled = client.delete(f"/local/v1/schedules/{other['id']}", headers=HEADERS)
    assert canceled.status_code == 200
    assert canceled.json()["status"] == "canceled"
