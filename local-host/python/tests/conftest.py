"""Test-wide pytest fixtures.

We auto-disable MCP on-disk discovery in every test. Without this, any
test that builds the agent picks up the developer's actual Claude
Desktop / Cursor / Codex MCP server list — which (a) makes the test
flaky (tries to spawn npx / uv subprocesses that may not exist in CI)
and (b) leaks environment-specific config into otherwise hermetic
tests. Tests that DO want to exercise discovery (test_mcp.py) opt
back in explicitly by setting SHEJANE_LOCAL_MCP_DISCOVERY=on inside
the test body.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _disable_mcp_disk_scan_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force MCP discovery to skip on-disk sources in every test.

    Honored by `local_host.tools.mcp.discover_servers`: when
    SHEJANE_LOCAL_MCP_DISCOVERY != "on", only the env var
    SHEJANE_LOCAL_MCP_SERVERS is consulted.
    """
    monkeypatch.setenv("SHEJANE_LOCAL_MCP_DISCOVERY", "off")
