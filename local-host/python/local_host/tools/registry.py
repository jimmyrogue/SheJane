"""Tool registry — flat list of `BaseTool` instances for create_agent.

Phase 2' assembles the trivial + custom + toolkit tools. MCP and browser-use
are added behind a flag (so the daemon can boot even when their dependencies
are misconfigured).
"""

from __future__ import annotations

import logging
from typing import Any

from langchain_core.tools import BaseTool

from ..store.sqlite import LocalStore
from .trivial import TRIVIAL_TOOLS
from .workspace import make_fs_toolkit, make_workspace_open_tool

log = logging.getLogger("local_host.tools.registry")


def core_tools() -> list[BaseTool]:
    """Tools that should always be available — no external deps required."""
    return list(TRIVIAL_TOOLS)


def build_tools(
    *,
    store: LocalStore | None = None,
    workspace_root: str | None = None,
) -> list[BaseTool]:
    """Assemble the full per-run toolset.

    Phase 2' returns: trivial + workspace.open + fs toolkit (read/write/list).
    Phase 2' part 3+ will extend this with Tavily, custom web/image/task/skill
    tools, MCP, and browser-use.
    """
    tools: list[BaseTool] = list(TRIVIAL_TOOLS)
    if store is not None:
        tools.append(make_workspace_open_tool(store))
    tools.extend(make_fs_toolkit(workspace_root))
    return tools


def describe_tools(
    *,
    store: LocalStore | None = None,
    workspace_root: str | None = None,
) -> list[dict[str, Any]]:
    """Lightweight serialization for `GET /v1/tools`."""
    out: list[dict[str, Any]] = []
    for t in build_tools(store=store, workspace_root=workspace_root):
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
