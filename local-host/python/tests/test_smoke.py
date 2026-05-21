"""Phase 2' smoke: server boots, auth gates, trivial tools registered."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from local_host.config import reset_settings_for_tests
from local_host.server import create_app


@pytest.fixture
def client() -> TestClient:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-test-"))
    os.environ["JIANDANLY_LOCAL_HOST_TOKEN"] = "test-pairing-token"
    settings = reset_settings_for_tests(
        JIANDANLY_LOCAL_HOST_ADDR="127.0.0.1",
        JIANDANLY_LOCAL_HOST_PORT=17371,
        JIANDANLY_LOCAL_HOST_TOKEN="test-pairing-token",
        data_dir=tmp,
    )
    app = create_app(settings)
    # `with` triggers FastAPI's lifespan so `app.state.store` is populated.
    with TestClient(app) as c:
        yield c


def test_health_no_auth(client: TestClient) -> None:
    r = client.get("/v1/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["pairing_configured"] is True


def test_tools_requires_auth(client: TestClient) -> None:
    r = client.get("/v1/tools")
    assert r.status_code == 401


def test_tools_lists_trivial_tools(client: TestClient) -> None:
    r = client.get("/v1/tools", headers={"Authorization": "Bearer test-pairing-token"})
    assert r.status_code == 200
    names = {t["name"] for t in r.json()["tools"]}
    expected = {
        "time.now",
        "environment.observe",
        "open.url",
        "open.file",
        "clipboard.read",
        "clipboard.write",
    }
    assert expected.issubset(names), f"missing: {expected - names}"


def test_workspaces_crud(client: TestClient) -> None:
    headers = {"Authorization": "Bearer test-pairing-token"}

    # initially empty
    r = client.get("/v1/workspaces", headers=headers)
    assert r.status_code == 200
    assert r.json()["workspaces"] == []

    # create
    r = client.post(
        "/v1/workspaces",
        headers=headers,
        json={"path": "/tmp/some-workspace", "label": "Test WS"},
    )
    assert r.status_code == 200
    ws = r.json()["workspace"]
    assert ws["path"] == "/tmp/some-workspace"
    assert ws["label"] == "Test WS"

    # list now has one
    r = client.get("/v1/workspaces", headers=headers)
    assert len(r.json()["workspaces"]) == 1

    # delete
    r = client.delete(f"/v1/workspaces/{ws['id']}", headers=headers)
    assert r.status_code == 200
    assert r.json()["deleted"] is True

    r = client.get("/v1/workspaces", headers=headers)
    assert r.json()["workspaces"] == []


def test_alternate_token_header(client: TestClient) -> None:
    r = client.get(
        "/v1/tools",
        headers={"X-Jiandanly-Local-Token": "test-pairing-token"},
    )
    assert r.status_code == 200


def test_wrong_token_rejected(client: TestClient) -> None:
    r = client.get(
        "/v1/tools",
        headers={"Authorization": "Bearer wrong-token"},
    )
    assert r.status_code == 401


def test_trivial_tool_callable_directly() -> None:
    """Sanity: tools are real BaseTool instances with usable schema."""
    from local_host.tools.trivial import time_now, clipboard_read

    out = time_now.invoke({"timezone": "UTC"})
    assert "iso" in out
    assert out["timezone"] == "UTC"

    # clipboard.read should at minimum return ok or error structure
    out = clipboard_read.invoke({})
    assert "ok" in out
