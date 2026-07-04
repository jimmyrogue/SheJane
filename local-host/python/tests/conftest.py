"""Test-wide pytest fixtures.

We auto-disable MCP on-disk discovery in every test. Without this, any
test that builds the agent picks up the developer's actual Claude
Desktop / Cursor / Codex MCP server list — which (a) makes the test
flaky (tries to spawn npx / uv subprocesses that may not exist in CI)
and (b) leaks environment-specific config into otherwise hermetic
tests. Tests that DO want to exercise discovery (test_mcp.py) opt
back in explicitly by setting SHEJANE_LOCAL_MCP_DISCOVERY=on inside
the test body.

We also disable LangSmith/LangChain external tracing. Agent tests create many
LangGraph runs; inheriting a developer shell's LANGSMITH_* credentials turns
unit tests into networked trace ingestion and can produce rate-limit noise.
"""

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _isolate_skills_disk_scan_by_default(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Keep agent tests from inheriting the developer's real skill library."""
    monkeypatch.setenv("SHEJANE_LOCAL_SKILLS_PATH", str(tmp_path / "empty-skills"))


@pytest.fixture(autouse=True)
def _disable_mcp_disk_scan_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force MCP discovery to skip on-disk sources in every test.

    Honored by `local_host.tools.mcp.discover_servers`: when
    SHEJANE_LOCAL_MCP_DISCOVERY != "on", only the env var
    SHEJANE_LOCAL_MCP_SERVERS is consulted.
    """
    monkeypatch.setenv("SHEJANE_LOCAL_MCP_DISCOVERY", "off")


@pytest.fixture(autouse=True)
def _disable_external_tracing_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep pytest hermetic even when the parent shell has LangSmith enabled."""
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "false")
    monkeypatch.delenv("LANGSMITH_API_KEY", raising=False)
    monkeypatch.delenv("LANGCHAIN_API_KEY", raising=False)


@pytest.fixture(autouse=True)
def _disable_cloud_auto_resolve_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """No-op the cloud Auto-model resolution in every test.

    Runs created with model="auto" (the schema default) fire one POST to
    {cloud}/api/v1/models/resolve at run start. Tests patch httpx at the
    module-global boundary (`local_host.llm.backend.httpx.AsyncClient` IS
    the shared httpx module), so that extra request would land in their
    sequence-scripted fake transports and shift the scripts. Returning None
    keeps the run on "auto" (the cloud maps it to the default model per
    turn). Tests that exercise resolution re-patch this themselves (see
    test_model_resolve.py).
    """

    async def _noop(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setattr("local_host.runs.resolve_auto_model", _noop)
