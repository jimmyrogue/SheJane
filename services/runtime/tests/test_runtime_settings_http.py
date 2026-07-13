from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from local_host.config import reset_settings_for_tests
from local_host.runs import RunCoordinator
from local_host.server import create_app
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
