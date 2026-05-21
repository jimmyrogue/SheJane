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
from .skills import SKILL_TOOLS
from .trivial import TRIVIAL_TOOLS
from .verify import VERIFY_TOOLS
from .web import WEB_TOOLS, make_tavily_search
from .workspace import make_fs_toolkit, make_workspace_open_tool

log = logging.getLogger("local_host.tools.registry")


def core_tools() -> list[BaseTool]:
    """Tools that should always be available — no external deps required."""
    return [*TRIVIAL_TOOLS, *WEB_TOOLS, *VERIFY_TOOLS, *SKILL_TOOLS]


def build_tools(
    *,
    store: LocalStore | None = None,
    workspace_root: str | None = None,
) -> list[BaseTool]:
    """Assemble the full per-run toolset.

    Phase 2' returns trivial + workspace.open + fs toolkit + web (fetch +
    optional Tavily search) + task.verify + skill.use. MCP and browser-use
    come in part 4 and 5.
    """
    tools: list[BaseTool] = []
    tools.extend(TRIVIAL_TOOLS)
    tools.extend(WEB_TOOLS)
    tools.extend(VERIFY_TOOLS)
    tools.extend(SKILL_TOOLS)
    if store is not None:
        tools.append(make_workspace_open_tool(store))
    tools.extend(make_fs_toolkit(workspace_root))
    tavily = make_tavily_search()
    if tavily is not None:
        tools.append(tavily)
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
