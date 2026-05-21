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


def test_tools_listing_includes_workspace_open(client: TestClient) -> None:
    r = client.get(
        "/v1/tools",
        headers={"Authorization": "Bearer test-pairing-token"},
    )
    names = {t["name"] for t in r.json()["tools"]}
    assert "workspace.open" in names


def test_workspace_open_tool_authorizes_directory(tmp_path: Path) -> None:
    """workspace.open should write a record to the store and return its id."""
    import asyncio
    from local_host.store.sqlite import LocalStore
    from local_host.tools.workspace import make_workspace_open_tool

    async def run() -> dict[str, str]:
        store = await LocalStore.open(tmp_path / "store.db")
        tool = make_workspace_open_tool(store)
        try:
            return await tool.ainvoke({"path": str(tmp_path), "label": "test"})
        finally:
            await store.close()

    result = asyncio.run(run())
    assert result["ok"] == "true"
    assert result["path"] == str(tmp_path)
    assert result["workspace_id"].startswith("ws_")


def test_workspace_open_rejects_missing_directory(tmp_path: Path) -> None:
    import asyncio
    from local_host.store.sqlite import LocalStore
    from local_host.tools.workspace import make_workspace_open_tool

    async def run() -> dict[str, str]:
        store = await LocalStore.open(tmp_path / "store.db")
        tool = make_workspace_open_tool(store)
        try:
            return await tool.ainvoke({"path": str(tmp_path / "does-not-exist")})
        finally:
            await store.close()

    result = asyncio.run(run())
    assert result["ok"] == "false"
    assert "not an accessible directory" in result["error"]


def test_fs_toolkit_returns_official_tools(tmp_path: Path) -> None:
    """make_fs_toolkit should return LangChain FileManagementToolkit tools."""
    from local_host.tools.workspace import make_fs_toolkit

    tools = make_fs_toolkit(str(tmp_path))
    names = {t.name for t in tools}
    assert names == {"read_file", "write_file", "list_directory"}


def test_fs_toolkit_disabled_without_workspace() -> None:
    from local_host.tools.workspace import make_fs_toolkit

    assert make_fs_toolkit(None) == []
    assert make_fs_toolkit("") == []
