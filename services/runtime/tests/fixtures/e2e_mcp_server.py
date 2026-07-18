import asyncio
import os
import time
from pathlib import Path

import mcp.types as types
from mcp.server.fastmcp import Context, FastMCP

server = FastMCP("SheJane E2E")

pid_log = os.environ.get("E2E_MCP_PID_LOG")
if pid_log:
    with Path(pid_log).open("a", encoding="utf-8") as handle:
        handle.write(f"{os.getpid()}\n")


@server.tool()
def echo(value: str) -> str:
    """Echo a deterministic value for the Runtime MCP contract test."""
    return f"{os.environ.get('E2E_MCP_PREFIX', 'E2E_MCP_OK')}:{value}"


@server.tool(structured_output=True)
def structured(value: str) -> dict[str, object]:
    """Return deterministic structured content with a published output schema."""
    return {"echo": value, "length": len(value)}


@server.tool()
def fail(value: str) -> str:
    """Raise a deterministic execution error for the Runtime MCP contract test."""
    raise RuntimeError(f"E2E_MCP_FAILURE:{value}")


@server.tool()
def crash() -> str:
    """Terminate the stdio server during a Tool call for recovery tests."""
    os._exit(23)


@server.tool()
def hang(seconds: float = 120.0) -> str:
    """Block long enough for the Runtime MCP timeout and session-retirement path."""
    time.sleep(seconds)
    return "unexpected hang completion"


@server.tool()
async def long_running(steps: int, delay_seconds: float, ctx: Context) -> str:
    """Report deterministic progress and remain cancellable between steps."""
    for index in range(steps):
        await ctx.report_progress(index + 1, total=steps, message=f"step {index + 1}")
        await asyncio.sleep(delay_seconds)
    return f"E2E_MCP_PROGRESS:{steps}"


def _register_helper(index: int) -> None:
    @server.tool(name=f"helper_{index:02d}")
    def helper(value: str) -> str:
        """Provide a deterministic helper result."""
        return f"E2E_MCP_HELPER_{index:02d}:{value}"


for helper_index in range(1, 12):
    _register_helper(helper_index)


cursor_log = os.environ.get("E2E_MCP_CURSOR_LOG")
if cursor_log:
    original_list_tools = server.list_tools

    @server._mcp_server.list_tools()
    async def list_tools_paginated(request: types.ListToolsRequest) -> types.ListToolsResult:
        cursor = request.params.cursor if request.params is not None else None
        with Path(cursor_log).open("a", encoding="utf-8") as handle:
            handle.write(f"{cursor or '<start>'}\n")
        tools = await original_list_tools()
        start = int(cursor.removeprefix("page:")) if cursor else 0
        end = min(start + 4, len(tools))
        next_cursor = f"page:{end}" if end < len(tools) else None
        return types.ListToolsResult(tools=tools[start:end], nextCursor=next_cursor)


if __name__ == "__main__":
    server.run()
