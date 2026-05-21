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
    r = client.get("/local/v1/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["pairing_configured"] is True


def test_tools_requires_auth(client: TestClient) -> None:
    r = client.get("/local/v1/tools")
    assert r.status_code == 401


def test_tools_lists_trivial_tools(client: TestClient) -> None:
    r = client.get("/local/v1/tools", headers={"Authorization": "Bearer test-pairing-token"})
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
    r = client.get("/local/v1/workspaces", headers=headers)
    assert r.status_code == 200
    assert r.json()["workspaces"] == []

    # create
    r = client.post(
        "/local/v1/workspaces",
        headers=headers,
        json={"path": "/tmp/some-workspace", "label": "Test WS"},
    )
    assert r.status_code == 200
    ws = r.json()["workspace"]
    assert ws["path"] == "/tmp/some-workspace"
    assert ws["label"] == "Test WS"

    # list now has one
    r = client.get("/local/v1/workspaces", headers=headers)
    assert len(r.json()["workspaces"]) == 1

    # delete
    r = client.delete(f"/local/v1/workspaces/{ws['id']}", headers=headers)
    assert r.status_code == 200
    assert r.json()["deleted"] is True

    r = client.get("/local/v1/workspaces", headers=headers)
    assert r.json()["workspaces"] == []


def test_alternate_token_header(client: TestClient) -> None:
    r = client.get(
        "/local/v1/tools",
        headers={"X-Jiandanly-Local-Token": "test-pairing-token"},
    )
    assert r.status_code == 200


def test_wrong_token_rejected(client: TestClient) -> None:
    r = client.get(
        "/local/v1/tools",
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
        "/local/v1/tools",
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


# (FileManagementToolkit removed in step 4/6 — deepagents FilesystemMiddleware
#  provides ls / read_file / write_file / edit_file / glob / grep when
#  create_deep_agent is given a backend.)


# --- web tools ---


def test_web_fetch_rejects_non_http_scheme() -> None:
    import asyncio

    from local_host.tools.web import web_fetch

    out = asyncio.run(web_fetch.ainvoke({"url": "file:///etc/passwd"}))
    assert out["ok"] == "false"
    assert "scheme" in out["error"]


def test_web_fetch_rejects_loopback_ssrf() -> None:
    """SSRF guard: localhost should be refused even via DNS-resolved hostname."""
    import asyncio

    from local_host.tools.web import web_fetch

    out = asyncio.run(web_fetch.ainvoke({"url": "http://localhost:8080/admin"}))
    assert out["ok"] == "false"
    assert "private" in out["error"] or "loopback" in out["error"]


def test_web_fetch_rejects_invalid_method() -> None:
    import asyncio

    from local_host.tools.web import web_fetch

    out = asyncio.run(web_fetch.ainvoke({"url": "https://example.com", "method": "DELETE"}))
    assert out["ok"] == "false"
    assert "method" in out["error"]


def test_tavily_disabled_when_key_absent(monkeypatch: Any) -> None:
    from local_host.tools.web import make_tavily_search

    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    assert make_tavily_search() is None


# --- task.verify ---


def test_task_verify_file_exists(tmp_path: Path) -> None:
    import asyncio

    from local_host.tools.verify import task_verify

    target = tmp_path / "a.txt"
    target.write_text("hello", encoding="utf-8")
    out = asyncio.run(task_verify.ainvoke(
        {"checks": [{"kind": "file_exists", "path": str(target)}]}
    ))
    assert out["ok"] == "true"
    assert out["results"][0]["ok"] is True


def test_task_verify_mixed_pass_fail(tmp_path: Path) -> None:
    import asyncio

    from local_host.tools.verify import task_verify

    out = asyncio.run(task_verify.ainvoke({
        "checks": [
            {"kind": "file_exists", "path": str(tmp_path / "missing")},
            {"kind": "shell_exit_code", "command": "true", "expected": 0},
            {"kind": "unknown_kind"},
        ]
    }))
    assert out["ok"] == "false"
    assert out["pass_count"] == "1"
    assert out["fail_count"] == "2"


def test_task_verify_empty_checks_rejected() -> None:
    import asyncio

    from local_host.tools.verify import task_verify

    out = asyncio.run(task_verify.ainvoke({"checks": []}))
    assert out["ok"] == "false"


# --- skills catalog (HTTP layer only — agent-facing loading is now ---
# --- handled by deepagents.SkillsMiddleware) ---


def test_skill_catalog_lists_md_files(monkeypatch: Any, tmp_path: Path) -> None:
    monkeypatch.setenv("JIANDANLY_LOCAL_SKILLS_PATH", str(tmp_path))
    (tmp_path / "alpha.md").write_text(
        "---\ntitle: Alpha\ndescription: A short demo\n---\nbody",
        encoding="utf-8",
    )
    (tmp_path / "beta.md").write_text("# Beta", encoding="utf-8")

    from local_host.server import _list_skill_files

    skills = _list_skill_files()
    names = {s["name"] for s in skills}
    assert names == {"alpha", "beta"}
    alpha = next(s for s in skills if s["name"] == "alpha")
    assert alpha["title"] == "Alpha"
    assert alpha["description"] == "A short demo"


def test_skill_catalog_returns_empty_when_dir_missing(
    monkeypatch: Any, tmp_path: Path
) -> None:
    monkeypatch.setenv(
        "JIANDANLY_LOCAL_SKILLS_PATH", str(tmp_path / "nope")
    )
    from local_host.server import _list_skill_files

    assert _list_skill_files() == []


# --- image tools (missing-key path only; live API not exercised) ---


def test_image_generate_without_key(monkeypatch: Any) -> None:
    import asyncio

    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    from local_host.tools.image import image_generate

    out = asyncio.run(image_generate.ainvoke({"prompt": "a cat"}))
    assert out["ok"] == "false"
    assert "OPENAI_API_KEY" in out["error"]


def test_image_edit_rejects_missing_source(tmp_path: Path) -> None:
    import asyncio

    from local_host.tools.image import image_edit

    out = asyncio.run(
        image_edit.ainvoke(
            {"image_path": str(tmp_path / "nope.png"), "prompt": "modify"}
        )
    )
    assert out["ok"] == "false"
    assert "not found" in out["error"]


# --- MCP wiring ---


def test_mcp_empty_config_returns_empty_list(monkeypatch: Any, tmp_path: Path) -> None:
    import asyncio

    from local_host.tools.mcp import build_mcp_tools

    monkeypatch.delenv("JIANDANLY_LOCAL_MCP_SERVERS", raising=False)
    tools = asyncio.run(build_mcp_tools(tmp_path))
    assert tools == []


def test_mcp_malformed_json_ignored(monkeypatch: Any, tmp_path: Path) -> None:
    import asyncio

    from local_host.tools.mcp import build_mcp_tools

    monkeypatch.setenv("JIANDANLY_LOCAL_MCP_SERVERS", "{ not valid json")
    tools = asyncio.run(build_mcp_tools(tmp_path))
    assert tools == []


def test_mcp_config_file_loaded(monkeypatch: Any, tmp_path: Path) -> None:
    """When the env var is empty but mcp-servers.json exists, it's read."""
    import asyncio

    from local_host.tools.mcp import _load_mcp_config

    monkeypatch.delenv("JIANDANLY_LOCAL_MCP_SERVERS", raising=False)
    (tmp_path / "mcp-servers.json").write_text(
        '{"demo": {"command": "python", "args": ["x.py"], "transport": "stdio"}}',
        encoding="utf-8",
    )
    config = _load_mcp_config(tmp_path)
    assert "demo" in config
    assert config["demo"]["transport"] == "stdio"


# --- browser-use integration ---


def test_browser_tool_stub_without_llm() -> None:
    """make_browser_tool(llm=None) returns a tool that reports unavailable."""
    import asyncio

    from local_host.tools.browser import make_browser_tool

    tool = make_browser_tool(llm=None)
    assert tool.name == "browser.task"
    out = asyncio.run(tool.ainvoke({"task": "open https://example.com"}))
    assert out["ok"] == "false"
    assert "Phase 3" in out["error"] or "not installed" in out["error"]


def test_browser_tool_present_in_registry(client: TestClient) -> None:
    r = client.get(
        "/local/v1/tools",
        headers={"Authorization": "Bearer test-pairing-token"},
    )
    names = {t["name"] for t in r.json()["tools"]}
    assert "browser.task" in names


# --- full registry async assembly ---


def test_async_build_tools_returns_full_set(tmp_path: Path) -> None:
    """build_tools (async) should assemble every Phase 2' category."""
    import asyncio

    from local_host.config import reset_settings_for_tests
    from local_host.store.sqlite import LocalStore
    from local_host.tools.registry import build_tools

    async def run() -> list[str]:
        reset_settings_for_tests(data_dir=tmp_path)
        store = await LocalStore.open(tmp_path / "store.db")
        try:
            tools = await build_tools(
                store=store,
                workspace_root=str(tmp_path),
                include_mcp=False,  # no MCP servers configured
            )
            return [t.name for t in tools]
        finally:
            await store.close()

    names = asyncio.run(run())
    expected = {
        "time.now",
        "environment.observe",
        "open.url",
        "open.file",
        "clipboard.read",
        "clipboard.write",
        "web.fetch",
        "task.verify",
        "image.generate",
        "image.edit",
        "workspace.open",
        "browser.task",
        "memory.search",
        "user.ask",
    }
    # ls / read_file / write_file / edit_file / glob / grep / execute are
    # added by deepagents FilesystemMiddleware INSIDE create_deep_agent —
    # they're not in the registry's own list.
    missing = expected - set(names)
    assert not missing, f"missing tools: {missing}"
