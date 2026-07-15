"""Deterministic per-request tool visibility without changing graph identity."""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from langchain.agents.middleware import AgentMiddleware

from ..tools.mcp import MCP_TOOL_SEARCH_NAME, MCP_TOOL_SEARCH_RESULT_KIND

_OFFICE_SIGNALS = (
    "office.",
    ".docx",
    ".xlsx",
    ".pptx",
    "microsoft word",
    "microsoft excel",
    "powerpoint",
    "spreadsheet",
    "presentation",
    "workbook",
    "worksheet",
    "slide deck",
    "文档",
    "表格",
    "幻灯",
    "演示文稿",
    "工作簿",
    "工作表",
    "单元格",
)


def _tool_name(tool: Any) -> str:
    if isinstance(tool, dict):
        function = tool.get("function")
        if isinstance(function, dict):
            return str(function.get("name") or "")
        return str(tool.get("name") or "")
    return str(getattr(tool, "name", "") or "")


def _message_text(message: Any) -> str:
    parts: list[str] = []
    text = getattr(message, "text", None)
    if isinstance(text, str):
        parts.append(text)
    else:
        content = getattr(message, "content", None)
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, str):
                    parts.append(block)
                elif isinstance(block, dict):
                    value = block.get("text") or block.get("content")
                    if isinstance(value, str):
                        parts.append(value)
    for call in getattr(message, "tool_calls", ()) or ():
        if isinstance(call, dict):
            parts.append(str(call.get("name") or ""))
    name = getattr(message, "name", None)
    if isinstance(name, str):
        parts.append(name)
    return "\n".join(parts)


def visible_tools_for_messages(
    tools: Sequence[Any],
    messages: Sequence[Any],
    *,
    task_goal: str | None = None,
) -> list[Any]:
    """Return the request-visible subset without changing registered tools."""
    corpus = (
        [task_goal]
        if isinstance(task_goal, str) and task_goal.strip()
        else [_message_text(message) for message in messages]
    )
    text = "\n".join(corpus).lower()
    office_tools = [tool for tool in tools if _tool_name(tool).startswith("office.")]
    non_office_tools = [tool for tool in tools if not _tool_name(tool).startswith("office.")]
    if not any(signal in text for signal in _OFFICE_SIGNALS):
        return non_office_tools
    named = {
        name
        for tool in office_tools
        if (name := _tool_name(tool))
        and re.search(rf"(?<![\w.]){re.escape(name.lower())}(?![\w.])", text)
    }
    if named:
        return [tool for tool in tools if _tool_name(tool) in named or tool in non_office_tools]
    return list(tools)


def _mcp_search_result_names(messages: Sequence[Any]) -> set[str]:
    for message in reversed(messages):
        if getattr(message, "name", None) != MCP_TOOL_SEARCH_NAME:
            continue
        candidates = [getattr(message, "artifact", None), getattr(message, "content", None)]
        for candidate in candidates:
            if isinstance(candidate, str):
                try:
                    candidate = json.loads(candidate)
                except (TypeError, ValueError):
                    continue
            if not isinstance(candidate, dict):
                continue
            if candidate.get("kind") != MCP_TOOL_SEARCH_RESULT_KIND:
                continue
            tools = candidate.get("tools")
            if isinstance(tools, list):
                return {
                    str(item.get("name"))
                    for item in tools
                    if isinstance(item, dict) and item.get("name")
                }
        return set()
    return set()


class ToolVisibilityMiddleware(AgentMiddleware):
    """Hide large optional tool families from a model request when irrelevant.

    The compiled graph still owns the complete tool set, so checkpoint forks and
    follow-up turns keep the same graph definition. The decision uses the current
    goal plus the complete retained message/tool-call history, not only one turn.
    """

    def __init__(self, *, deferred_tool_names: set[str] | None = None) -> None:
        super().__init__()
        self.deferred_tool_names = deferred_tool_names or set()

    @staticmethod
    def _apply(request: Any, deferred_tool_names: set[str] | None = None) -> Any:
        context = getattr(getattr(request, "runtime", None), "context", None)
        task_goal = getattr(context, "task_goal", None)
        visible = visible_tools_for_messages(
            request.tools,
            request.messages,
            task_goal=task_goal,
        )
        deferred = deferred_tool_names or set()
        if deferred:
            corpus = [task_goal] if isinstance(task_goal, str) else []
            corpus.extend(_message_text(message) for message in request.messages)
            text = "\n".join(corpus).lower()
            revealed = _mcp_search_result_names(request.messages)
            revealed.update(name for name in deferred if name.lower() in text)
            visible = [
                item
                for item in visible
                if _tool_name(item) not in deferred or _tool_name(item) in revealed
            ]
        if len(visible) == len(request.tools):
            return request
        return request.override(tools=visible)

    def wrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        return handler(self._apply(request, self.deferred_tool_names))

    async def awrap_model_call(
        self,
        request: Any,
        handler: Callable[[Any], Awaitable[Any]],
    ) -> Any:
        return await handler(self._apply(request, self.deferred_tool_names))
