"""Tool registry — flat list of `BaseTool` instances for create_agent.

Phase 2' assembles the trivial + custom + toolkit tools. MCP and browser-use
are added behind a flag (so the daemon can boot even when their dependencies
are misconfigured).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from deepagents.backends import FilesystemBackend
from deepagents.middleware import FilesystemMiddleware
from langchain_core.tools import BaseTool

from ..config import get_settings
from ..store.sqlite import LocalStore
from .browser import make_browser_tool_if_configured
from .mcp import build_mcp_tools
from .memory import MEMORY_TOOLS
from .office import OFFICE_READ_TOOLS, OFFICE_WRITE_TOOLS
from .progress import PROGRESS_TOOLS, make_progress_tool
from .trivial import TRIVIAL_TOOLS
from .user import USER_TOOLS
from .verify import VERIFY_TOOLS
from .web import web_fetch

log = logging.getLogger("local_host.tools.registry")


def core_tools() -> list[BaseTool]:
    """Tools that should always be available — no external deps required."""
    tools = [
        *TRIVIAL_TOOLS,
        web_fetch,
        *VERIFY_TOOLS,
        *MEMORY_TOOLS,
        *USER_TOOLS,
        *OFFICE_READ_TOOLS,
        # Office writes keep copy-on-first-write semantics, and the Runtime's
        # parameter-bound review policy still treats them as workspace writes.
        *OFFICE_WRITE_TOOLS,
        *PROGRESS_TOOLS,
    ]
    return tools


async def build_tools(
    *,
    include_mcp: bool = True,
    mcp_disabled_servers: set[str] | None = None,
    browser_llm: Any = None,
    browser_headless: bool = True,
) -> list[BaseTool]:
    """Assemble the full per-run toolset.

    All Runtime tool categories: local utilities + web
    (fetch + optional Tavily) + task.verify + skill.use + image.* + MCP.
    `browser.task` is intentionally omitted until both browser-use and a
    browser-specific LLM binding are configured.

    """
    tools: list[BaseTool] = []
    tools.extend(TRIVIAL_TOOLS)
    tools.append(web_fetch)
    tools.extend(VERIFY_TOOLS)
    tools.extend(MEMORY_TOOLS)
    tools.extend(USER_TOOLS)
    tools.extend(OFFICE_READ_TOOLS)
    tools.extend(OFFICE_WRITE_TOOLS)
    tools.append(make_progress_tool())
    # ls/read_file/write_file/edit_file/glob/grep/execute are provided by
    # deepagents FilesystemMiddleware
    # (auto-added by create_deep_agent), so we do NOT add FileManagementToolkit
    # tools here — that would collide on `read_file` / `write_file` names.
    # web.fetch remains a local, SSRF-guarded tool.

    browser_tool = make_browser_tool_if_configured(llm=browser_llm, headless=browser_headless)
    if browser_tool is not None:
        tools.append(browser_tool)

    if include_mcp:
        data_dir = get_settings().data_dir
        tools.extend(await build_mcp_tools(data_dir, disabled_servers=mcp_disabled_servers))

    return tools


def describe_tools_sync(
    *,
    store: LocalStore | None = None,
    workspace_root: str | None = None,
) -> list[dict[str, Any]]:
    """Sync subset for `GET /v1/tools`.

    MCP is omitted because it requires a running event loop and configured
    servers. deepagents filesystem/shell tools are included as the current
    runtime contract, using deepagents' own middleware factory for schemas so
    the discovery endpoint does not invent a parallel fs.* vocabulary.
    """
    out: list[dict[str, Any]] = []
    tools: list[BaseTool] = [*_deepagents_filesystem_tools(workspace_root), *core_tools()]
    for t in tools:
        definition = tool_definition(t)
        definition["description"] = definition["description"].splitlines()[0]
        out.append(definition)
    return out


def tool_definition(tool: BaseTool) -> dict[str, Any]:
    return {
        "name": tool.name,
        "description": (tool.description or "").strip(),
        "args_schema": _serialize_args_schema(tool),
    }


def _deepagents_filesystem_tools(workspace_root: str | None = None) -> list[BaseTool]:
    """Return deepagents' filesystem/shell tool definitions for discovery.

    The actual tools are injected later by create_deep_agent via
    FilesystemMiddleware. This helper mirrors that source for /local/v1/tools
    without adding duplicate tools to build_tools().
    """
    root = workspace_root or str(Path.home() / ".shejane" / "workspace")
    backend = FilesystemBackend(root_dir=root, virtual_mode=True, max_file_size_mb=10)
    return list(FilesystemMiddleware(backend=backend).tools)


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
    except Exception:
        return {"type": "object", "additionalProperties": True}


# Backwards-compatible alias used by the HTTP layer.
describe_tools = describe_tools_sync
