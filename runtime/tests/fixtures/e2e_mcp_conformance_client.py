from __future__ import annotations

import asyncio
import os
import sys

from shejane_runtime.tools.mcp import _MCPServerSupervisor


async def _run(url: str) -> None:
    scenario = os.environ.get("MCP_CONFORMANCE_SCENARIO")
    if scenario not in {"initialize", "sse-retry", "tools_call"}:
        raise ValueError(f"unsupported MCP conformance scenario: {scenario}")
    supervisor = _MCPServerSupervisor(
        "conformance",
        {"transport": "streamable_http", "url": url},
    )
    try:
        tools = await supervisor.start()
        if scenario == "tools_call":
            add_numbers = next(tool for tool in tools if tool.name.endswith("add_numbers"))
            result = await add_numbers.ainvoke({"a": 2, "b": 3})
            if "5" not in str(result):
                raise AssertionError(f"unexpected add_numbers result: {result!r}")
        elif scenario == "sse-retry":
            reconnect = next(tool for tool in tools if tool.name.endswith("test_reconnection"))
            result = await reconnect.ainvoke({})
            if "completed successfully" not in str(result):
                raise AssertionError(f"unexpected reconnection result: {result!r}")
    finally:
        await supervisor.stop()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: e2e_mcp_conformance_client.py SERVER_URL")
    asyncio.run(_run(sys.argv[1]))
