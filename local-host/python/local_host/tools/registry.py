"""Tool registry — flat list of `BaseTool` instances for create_agent.

Phase 2' assembles the trivial + custom + toolkit tools. MCP and browser-use
are added behind a flag (so the daemon can boot even when their dependencies
are misconfigured).
"""

from __future__ import annotations

import logging
from typing import Any

from langchain_core.tools import BaseTool

from .trivial import TRIVIAL_TOOLS

log = logging.getLogger("local_host.tools.registry")


def core_tools() -> list[BaseTool]:
    """Tools that should always be available — no external deps required."""
    return list(TRIVIAL_TOOLS)


def describe_tools() -> list[dict[str, Any]]:
    """Lightweight serialization for `GET /v1/tools`."""
    out: list[dict[str, Any]] = []
    for t in core_tools():
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
