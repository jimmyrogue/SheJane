"""Bounded verification repair loop.

When the model explicitly runs `task.verify` and that structured check fails,
the next final answer should not silently pass through as if the task were
done. This middleware catches that narrow case after a model turn with no tool
calls, appends a repair instruction, and jumps back to the model node.

The loop is intentionally small and capped. It does not second-guess fuzzy LLM
critic scores; it reacts only to machine-readable `task.verify` failures.
"""

from __future__ import annotations

import json
from typing import Any

from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain_core.messages import HumanMessage


class VerificationLoopMiddleware(AgentMiddleware):
    """Ask the model to repair once when `task.verify` failed."""

    def __init__(self, *, max_attempts: int = 1) -> None:
        super().__init__()
        self.max_attempts = max(0, max_attempts)

    @hook_config(can_jump_to=["model"])
    def after_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        if self.max_attempts <= 0:
            return None

        messages = state.get("messages") or []
        if not messages:
            return None
        last = messages[-1]
        if getattr(last, "type", None) != "ai":
            return None
        if getattr(last, "tool_calls", None):
            return None

        failure = _latest_failed_task_verify(messages)
        if failure is None:
            return None

        attempts = _int_state(state.get("verification_repair_attempts"))
        if attempts >= self.max_attempts:
            return {
                "verification_loop": {
                    "status": "exhausted",
                    "attempts": attempts,
                    "max_attempts": self.max_attempts,
                    "reason": failure["reason"],
                }
            }

        attempt = attempts + 1
        return {
            "messages": [
                HumanMessage(
                    content=(
                        "Verification failed, so do not finalize yet.\n"
                        f"Failure: {failure['reason']}\n\n"
                        "Repair the underlying issue, then run `task.verify` "
                        "or an equivalent check again. Only provide the final "
                        "answer after verification passes. If it cannot be "
                        "fixed, explain the exact blocker."
                    )
                )
            ],
            "verification_repair_attempts": attempt,
            "verification_loop": {
                "status": "repair_requested",
                "attempts": attempt,
                "max_attempts": self.max_attempts,
                "reason": failure["reason"],
            },
            "jump_to": "model",
        }


def _latest_failed_task_verify(messages: list[Any]) -> dict[str, str] | None:
    for message in reversed(messages):
        if getattr(message, "type", None) != "tool":
            continue
        if getattr(message, "name", "") != "task.verify":
            continue
        parsed = _parse_tool_content(getattr(message, "content", ""))
        if not isinstance(parsed, dict):
            continue
        if _truthy(parsed.get("ok")):
            continue
        reason = _verification_reason(parsed)
        return {
            "tool_call_id": str(getattr(message, "tool_call_id", "")),
            "reason": reason,
        }
    return None


def _parse_tool_content(content: Any) -> Any:
    if isinstance(content, dict):
        return content
    if isinstance(content, str):
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            return None
    return None


def _verification_reason(payload: dict[str, Any]) -> str:
    results = payload.get("results")
    if isinstance(results, list):
        for item in results:
            if not isinstance(item, dict):
                continue
            if _truthy(item.get("ok")):
                continue
            detail = item.get("detail")
            if isinstance(detail, str) and detail.strip():
                return detail.strip()
    error = payload.get("error")
    if isinstance(error, str) and error.strip():
        return error.strip()
    return "task.verify returned ok=false"


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "ok", "passed"}
    if isinstance(value, (int, float)):
        return value != 0
    return bool(value)


def _int_state(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0
