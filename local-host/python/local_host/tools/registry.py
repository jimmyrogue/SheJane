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
from .browser import make_browser_tool
from .image import IMAGE_TOOLS
from .mcp import build_mcp_tools
from .memory import MEMORY_TOOLS
from .trivial import TRIVIAL_TOOLS
from .user import USER_TOOLS
from .verify import VERIFY_TOOLS
from .web import WEB_TOOLS, make_tavily_search
from .workspace import make_workspace_open_tool

log = logging.getLogger("local_host.tools.registry")


def core_tools() -> list[BaseTool]:
    """Tools that should always be available — no external deps required."""
    return [
        *TRIVIAL_TOOLS,
        *WEB_TOOLS,
        *VERIFY_TOOLS,
        *IMAGE_TOOLS,
        *MEMORY_TOOLS,
        *USER_TOOLS,
    ]


async def build_tools(
    *,
    store: LocalStore | None = None,
    workspace_root: str | None = None,
    include_mcp: bool = True,
    browser_llm: Any = None,
) -> list[BaseTool]:
    """Assemble the full per-run toolset.

    All Phase 2' categories: trivial + workspace.open + fs toolkit + web
    (fetch + optional Tavily) + task.verify + skill.use + image.* + MCP +
    browser.task. The browser tool is always present but reports
    "configure-me" if `browser_llm` is None.
    """
    tools: list[BaseTool] = []
    tools.extend(TRIVIAL_TOOLS)
    tools.extend(WEB_TOOLS)
    tools.extend(VERIFY_TOOLS)
    tools.extend(IMAGE_TOOLS)
    tools.extend(MEMORY_TOOLS)
    tools.extend(USER_TOOLS)
    if store is not None:
        tools.append(make_workspace_open_tool(store))
    # fs.list/read/write are provided by deepagents FilesystemMiddleware
    # (auto-added by create_deep_agent), so we do NOT add FileManagementToolkit
    # tools here — that would collide on `read_file` / `write_file` names.

    tavily = make_tavily_search()
    if tavily is not None:
        tools.append(tavily)

    tools.append(make_browser_tool(llm=browser_llm))

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
    running event loop) + the deepagents auto-tools (ls, read_file,
    write_file, edit_file, glob, grep, execute, task, write_todos) which
    only materialize inside the compiled agent."""
    out: list[dict[str, Any]] = []
    tools: list[BaseTool] = list(core_tools())
    if store is not None:
        tools.append(make_workspace_open_tool(store))
    tools.append(make_browser_tool(llm=None))
    for t in tools:
        out.append(
            {
                "name": t.name,
                "description": (t.description or "").strip().splitlines()[0]
                if t.description
                else "",
                "args_schema": _serialize_args_schema(t),
            }
        )
    return out


def _serialize_args_schema(tool: BaseTool) -> dict[str, Any] | None:
    """Render the LLM-visible part of the tool's args schema as JSON Schema.

    Prefer `tool_call_schema` (excludes `InjectedStore`/`InjectedToolArg`).
    Fall back to `args_schema` for tools that don't override
    `tool_call_schema`. If even that fails (e.g. Callable types in the
    schema — happens with deepagents `task`), return a permissive object
    schema so /v1/tools doesn't 500.
    """
    schema_attr = getattr(tool, "tool_call_schema", None) or tool.args_schema
    if schema_attr is None:
        return None
    try:
        return schema_attr.model_json_schema()
    except Exception:  # noqa: BLE001
        return {"type": "object", "additionalProperties": True}


# Backwards-compatible alias used by the HTTP layer.
describe_tools = describe_tools_sync
