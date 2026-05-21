"""MCP integration via langchain-mcp-adapters.

Config source order:
1. `JIANDANLY_LOCAL_MCP_SERVERS` env var containing JSON (matches the Node
   daemon's existing convention so we can share config files during cutover)
2. `<data_dir>/mcp-servers.json` file
3. Empty (no MCP tools)

Each entry follows MultiServerMCPClient's schema directly:
    {
        "server-name": {
            "transport": "stdio" | "sse" | "http" | "websocket",
            "command": "...",            # for stdio
            "args": [...],
            "cwd": "...",
            "env": {...},
            "url": "...",                # for http/sse/websocket
            "headers": {...}
        }
    }
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from langchain_core.tools import BaseTool

log = logging.getLogger("local_host.tools.mcp")


def _load_mcp_config(data_dir: Path | None) -> dict[str, dict[str, Any]]:
    raw = os.environ.get("JIANDANLY_LOCAL_MCP_SERVERS", "").strip()
    if raw:
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            log.warning("ignoring malformed JIANDANLY_LOCAL_MCP_SERVERS: %s", exc)

    if data_dir is not None:
        path = data_dir / "mcp-servers.json"
        if path.exists():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                log.warning("ignoring malformed %s: %s", path, exc)

    return {}


async def build_mcp_tools(data_dir: Path | None) -> list[BaseTool]:
    """Connect to every configured MCP server and return their tools.

    Failure to connect to any one server does NOT abort the boot — we log
    the error and continue with the others. This matches the daemon's
    desire to stay up even when an MCP server is misconfigured.
    """
    config = _load_mcp_config(data_dir)
    if not config:
        return []

    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient
    except ImportError:
        log.warning("langchain-mcp-adapters not installed; skipping MCP")
        return []

    client = MultiServerMCPClient(config, tool_name_prefix=True)
    try:
        tools = await client.get_tools()
    except Exception as exc:  # noqa: BLE001 — connect surface is broad
        log.warning("MCP get_tools() failed (%s): %s", type(exc).__name__, exc)
        return []
    log.info(
        "loaded %d MCP tools across %d servers", len(tools), len(config)
    )
    return list(tools)
