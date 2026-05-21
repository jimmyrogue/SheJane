"""Tool registry — flat list of `BaseTool` instances for create_agent.

Phase 2' assembles the trivial + custom + toolkit tools. MCP and browser-use
are added behind a flag (so the daemon can boot even when their dependencies
are misconfigured).
"""

from __future__ import annotations

import logging
from typing import Any

from langchain_core.tools import BaseTool

from ..config import get_settings
from ..store.sqlite import LocalStore
from .image import IMAGE_TOOLS
from .mcp import build_mcp_tools
from .skills import SKILL_TOOLS
from .trivial import TRIVIAL_TOOLS
from .verify import VERIFY_TOOLS
from .web import WEB_TOOLS, make_tavily_search
from .workspace import make_fs_toolkit, make_workspace_open_tool

log = logging.getLogger("local_host.tools.registry")


def core_tools() -> list[BaseTool]:
    """Tools that should always be available — no external deps required."""
    return [
        *TRIVIAL_TOOLS,
        *WEB_TOOLS,
        *VERIFY_TOOLS,
        *SKILL_TOOLS,
        *IMAGE_TOOLS,
    ]


async def build_tools(
    *,
    store: LocalStore | None = None,
    workspace_root: str | None = None,
    include_mcp: bool = True,
) -> list[BaseTool]:
    """Assemble the full per-run toolset.

    Phase 2' returns trivial + workspace.open + fs toolkit + web (fetch +
    optional Tavily) + task.verify + skill.use + image.* + MCP.
    browser-use comes in part 5.
    """
    tools: list[BaseTool] = []
    tools.extend(TRIVIAL_TOOLS)
    tools.extend(WEB_TOOLS)
    tools.extend(VERIFY_TOOLS)
    tools.extend(SKILL_TOOLS)
    tools.extend(IMAGE_TOOLS)
    if store is not None:
        tools.append(make_workspace_open_tool(store))
    tools.extend(make_fs_toolkit(workspace_root))

    tavily = make_tavily_search()
    if tavily is not None:
        tools.append(tavily)

    if include_mcp:
        data_dir = get_settings().data_dir
        tools.extend(await build_mcp_tools(data_dir))

    return tools


def describe_tools_sync(
    *,
    store: LocalStore | None = None,
    workspace_root: str | None = None,
) -> list[dict[str, Any]]:
    """Sync subset for `GET /v1/tools` — omits MCP (which requires a
    running event loop) and Tavily details. Just core + workspace + fs."""
    out: list[dict[str, Any]] = []
    tools: list[BaseTool] = list(core_tools())
    if store is not None:
        tools.append(make_workspace_open_tool(store))
    tools.extend(make_fs_toolkit(workspace_root))
    for t in tools:
        out.append(
            {
                "name": t.name,
                "description": (t.description or "").strip().splitlines()[0]
                if t.description
                else "",
                "args_schema": t.args_schema.model_json_schema()
                if t.args_schema
                else None,
            }
        )
    return out


# Backwards-compatible alias used by the HTTP layer.
describe_tools = describe_tools_sync
