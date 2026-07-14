from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from local_host.config import reset_settings_for_tests
from local_host.runs import RunCoordinator
from local_host.server import create_app
from local_host.store.sqlite import LocalStore
from tests.helpers import run_command


def test_runtime_settings_persist_and_freeze_into_new_runs(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(RunCoordinator, "start", lambda _self: None)
    headers = {"Authorization": "Bearer tok"}

    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok", SHEJANE_FAKE_LLM=True, data_dir=tmp_path
    )
    with TestClient(create_app(settings)) as client:
        response = client.put(
            "/local/v1/settings",
            headers=headers,
            json={
                "max_model_calls": 42,
                "max_tool_retries": 1,
                "input_guard": "block",
                "plan_first": "auto",
            },
        )
        assert response.status_code == 200
        assert response.json()["max_model_calls"] == 42
        assert response.json()["version"] == 1

        replay = client.put(
            "/local/v1/settings",
            headers=headers,
            json={
                "max_model_calls": 42,
                "max_tool_retries": 1,
                "input_guard": "block",
                "plan_first": "auto",
            },
        )
        assert replay.status_code == 200
        assert replay.json()["version"] == 1

        created = client.post(
            "/local/v1/runs",
            headers=headers,
            json=run_command("Use persisted defaults"),
        )
        assert created.status_code == 200
        frozen = json.loads(created.json()["settings_json"])
        assert frozen["max_model_calls"] == 42
        assert frozen["input_guard"] == "block"

    restarted = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok", SHEJANE_FAKE_LLM=True, data_dir=tmp_path
    )
    with TestClient(create_app(restarted)) as client:
        response = client.get("/local/v1/settings", headers=headers)
        assert response.status_code == 200
        assert response.json()["max_model_calls"] == 42
        assert response.json()["plan_first"] == "auto"
        assert response.json()["version"] == 1


@pytest.mark.asyncio
async def test_runtime_settings_store_atomically_merges_concurrent_patches(
    tmp_path: Path,
) -> None:
    database = tmp_path / "runtime.db"
    first = await LocalStore.open(database)
    second = await LocalStore.open(database)
    defaults = {"max_model_calls": 20, "max_tool_retries": 2}
    try:
        await asyncio.gather(
            first.patch_runtime_settings({"max_model_calls": 41}, initial_settings=defaults),
            second.patch_runtime_settings({"max_tool_retries": 4}, initial_settings=defaults),
        )
        stored = await first.get_runtime_settings()
        assert stored is not None
        assert stored["settings"]["max_model_calls"] == 41
        assert stored["settings"]["max_tool_retries"] == 4
        assert stored["version"] == 2
    finally:
        await first.close()
        await second.close()
