"""Retry structured tool-result envelopes that explicitly opt in.

LangChain's built-in `ToolRetryMiddleware` retries exceptions raised by a tool.
Some SheJane tools deliberately do not raise: they return a JSON envelope like
`{"ok": false, "retryable": true, ...}` so the LLM and diagnostics get a
machine-readable failure. This middleware handles only that narrow result
shape, only for a caller-supplied tool allowlist, and only when the shared
failure policy agrees the failure is safe to retry.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware, ToolCallRequest
from langchain_core.messages import ToolMessage
from langgraph.types import Command

from ..failure_policy import build_retry_decision


class ToolResultRetryMiddleware(AgentMiddleware):
    """Retry `ToolMessage` envelopes with `ok=false` and `retryable=true`."""

    def __init__(
        self,
        *,
        max_retries: int = 2,
        tools: list[Any] | None = None,
        initial_delay: float = 1.0,
        backoff_factor: float = 2.0,
        max_delay: float = 30.0,
    ) -> None:
        super().__init__()
        self.max_retries = max(0, int(max_retries))
        self.initial_delay = max(0.0, float(initial_delay))
        self.backoff_factor = max(0.0, float(backoff_factor))
        self.max_delay = max(0.0, float(max_delay))
        self._tool_filter = None if tools is None else {_tool_name(tool) for tool in tools}

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command[Any]],
    ) -> ToolMessage | Command[Any]:
        if not self._should_retry_tool(request):
            return handler(request)

        for attempt in range(self.max_retries + 1):
            result = handler(request)
            decision = _retry_decision_for_failed_result(
                result,
                attempt=attempt,
                max_attempts=self.max_retries,
                initial_delay=self.initial_delay,
                backoff_factor=self.backoff_factor,
                max_delay=self.max_delay,
            )
            if decision is None or not decision["should_retry"]:
                return result
            delay = float(decision["delay_s"])
            if delay > 0:
                time.sleep(delay)

        raise RuntimeError("unreachable tool result retry state")

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        if not self._should_retry_tool(request):
            return await handler(request)

        for attempt in range(self.max_retries + 1):
            result = await handler(request)
            decision = _retry_decision_for_failed_result(
                result,
                attempt=attempt,
                max_attempts=self.max_retries,
                initial_delay=self.initial_delay,
                backoff_factor=self.backoff_factor,
                max_delay=self.max_delay,
            )
            if decision is None or not decision["should_retry"]:
                return result
            delay = float(decision["delay_s"])
            if delay > 0:
                await asyncio.sleep(delay)

        raise RuntimeError("unreachable async tool result retry state")

    def _should_retry_tool(self, request: ToolCallRequest) -> bool:
        if self._tool_filter is None:
            return True
        tool = request.tool.name if request.tool else str(request.tool_call.get("name") or "")
        return tool in self._tool_filter


def _retry_decision_for_failed_result(
    result: ToolMessage | Command[Any],
    *,
    attempt: int,
    max_attempts: int,
    initial_delay: float,
    backoff_factor: float,
    max_delay: float,
) -> dict[str, Any] | None:
    if not isinstance(result, ToolMessage):
        return None
    parsed = _parse_tool_content(result.content)
    if not isinstance(parsed, dict) or "ok" not in parsed:
        return None
    if _truthy(parsed.get("ok")) or not _truthy(parsed.get("retryable")):
        return None
    payload = dict(parsed)
    payload["retryable"] = True
    return build_retry_decision(
        "tool.failed",
        payload,
        attempt=attempt,
        max_attempts=max_attempts,
        initial_delay=initial_delay,
        backoff_factor=backoff_factor,
        max_delay=max_delay,
    )


def _parse_tool_content(content: Any) -> Any:
    if isinstance(content, dict):
        return content
    if isinstance(content, str):
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            return None
    return None


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "ok", "passed"}
    if isinstance(value, (int, float)):
        return value != 0
    return bool(value)


def _tool_name(tool: Any) -> str:
    return str(getattr(tool, "name", tool))
