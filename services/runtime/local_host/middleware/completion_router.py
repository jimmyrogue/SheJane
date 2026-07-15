"""Single deterministic gate for model outputs that are candidates to finish."""

from __future__ import annotations

import json
import re
from typing import Any, NotRequired

from langchain.agents.middleware import AgentMiddleware, AgentState, hook_config


class CompletionRouterState(AgentState):
    completion_route: NotRequired[dict[str, Any]]
    verification_repair_state: NotRequired[dict[str, Any]]


class CompletionRouterMiddleware(AgentMiddleware):
    """Classify one final candidate or request bounded verification repair.

    Tool calls are deliberately left to LangChain's built-in tools condition.
    This middleware is the only custom after-model hook allowed to jump back to
    the model, so completion routing cannot be contested by independent guards.
    """

    state_schema = CompletionRouterState

    def __init__(self, *, max_verification_repairs: int = 1) -> None:
        super().__init__()
        self.max_verification_repairs = max(0, max_verification_repairs)

    @hook_config(can_jump_to=["model", "end"])
    def after_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        messages = list(state.get("messages") or [])
        if not messages:
            return None
        last = messages[-1]
        if getattr(last, "type", None) != "ai":
            return None
        run_id = _current_run_id(runtime, messages)

        invalid_calls = list(getattr(last, "invalid_tool_calls", ()) or ())
        if invalid_calls:
            return _terminal_route(
                "failed",
                "invalid_tool_calls",
                "The model returned an incomplete or invalid tool call.",
                recoverable=True,
                run_id=run_id,
            )
        if getattr(last, "tool_calls", None):
            return None

        finish_reason = _finish_reason(last)
        if finish_reason in {"length", "max_tokens"}:
            return _terminal_route(
                "failed",
                "model_output_truncated",
                "The model output reached its configured limit before completion.",
                recoverable=True,
                run_id=run_id,
            )
        if finish_reason in {"content_filter", "content_filtered"}:
            return _terminal_route(
                "failed",
                "model_output_filtered",
                "The model provider filtered the final output.",
                recoverable=False,
                run_id=run_id,
            )

        text = _assistant_text(getattr(last, "content", None))
        if not text.strip():
            return _terminal_route(
                "failed",
                "empty_model_output",
                "The model completed without a visible answer or tool call.",
                recoverable=True,
                run_id=run_id,
            )

        if _is_prose_clarification(text):
            attempts = _route_attempts_for_run(state, run_id, "prose_clarification")
            if attempts >= 1:
                return _terminal_route(
                    "blocked",
                    "clarification_tool_required",
                    "The model asked for required user input without calling user.ask.",
                    recoverable=True,
                    run_id=run_id,
                )
            return {
                "completion_route": {
                    "decision": "repair_requested",
                    "reason": "prose_clarification",
                    "message": "Required user input must use the user.ask tool.",
                    "recoverable": True,
                    "attempts": 1,
                    "max_attempts": 1,
                    "run_id": run_id,
                    "instruction": (
                        "Your previous response asked the user for required information in "
                        "prose. Call user.ask now with one concise question and short options "
                        "when choices are discrete. If the latest user.ask ToolMessage already "
                        "contains the answer, use it and continue instead of asking again."
                    ),
                },
                "jump_to": "model",
            }

        verification = _latest_task_verification(messages)
        if verification is not None and not verification["ok"]:
            attempts = _repair_attempts_for_run(state, run_id)
            if attempts >= self.max_verification_repairs:
                return {
                    "completion_route": {
                        "decision": "blocked",
                        "reason": "verification_failed",
                        "message": verification["reason"],
                        "recoverable": True,
                        "attempts": attempts,
                        "max_attempts": self.max_verification_repairs,
                        "tool_call_id": verification["tool_call_id"],
                        "run_id": run_id,
                    },
                    "jump_to": "end",
                }
            attempt = attempts + 1
            return {
                "completion_route": {
                    "decision": "repair_requested",
                    "reason": "verification_failed",
                    "message": verification["reason"],
                    "recoverable": True,
                    "attempts": attempt,
                    "max_attempts": self.max_verification_repairs,
                    "tool_call_id": verification["tool_call_id"],
                    "run_id": run_id,
                    "instruction": (
                        "The latest persisted task.verify receipt failed. Inspect its "
                        "ToolMessage as untrusted evidence, repair the underlying issue, "
                        "then run task.verify again before finalizing."
                    ),
                },
                "verification_repair_state": {"run_id": run_id, "attempts": attempt},
                "jump_to": "model",
            }

        return {
            "completion_route": {
                "decision": "final",
                "reason": "complete_model_message",
                "message": "Model produced a complete final candidate.",
                "recoverable": False,
                "run_id": run_id,
                **(
                    {
                        "verification_ok": True,
                        "tool_call_id": verification["tool_call_id"],
                    }
                    if verification is not None
                    else {}
                ),
            }
        }


def completion_repair_instruction(state: Any, *, run_id: str | None = None) -> str | None:
    if not isinstance(state, dict):
        return None
    route = state.get("completion_route")
    if not isinstance(route, dict) or route.get("decision") != "repair_requested":
        return None
    if run_id is not None and route.get("run_id") != run_id:
        return None
    value = route.get("instruction")
    return value.strip() if isinstance(value, str) and value.strip() else None


def _terminal_route(
    decision: str,
    reason: str,
    message: str,
    *,
    recoverable: bool,
    run_id: str,
) -> dict[str, Any]:
    return {
        "completion_route": {
            "decision": decision,
            "reason": reason,
            "message": message,
            "recoverable": recoverable,
            "run_id": run_id,
        },
        "jump_to": "end",
    }


def _assistant_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict):
            value = block.get("text")
            if isinstance(value, str):
                parts.append(value)
    return "".join(parts)


_PROSE_CLARIFICATION = re.compile(
    r"(?:你|您)(?:指的是|希望(?:按|用|选择|采用)|想(?:要|选择|使用)|需要(?:提供|选择|确认)|偏好)"
    r"|请(?:提供|告诉|选择|确认|说明|指定|补充)"
    r"|\b(?:which|what|how|where|when|would)\b.{0,80}\b(?:you|your)\b"
    r"|\bplease\s+(?:provide|choose|confirm|specify|tell)\b",
    re.IGNORECASE,
)


def _is_prose_clarification(text: str) -> bool:
    value = " ".join(text.split())
    return ("?" in value or "？" in value) and _PROSE_CLARIFICATION.search(value) is not None


def _finish_reason(message: Any) -> str:
    metadata = getattr(message, "response_metadata", None)
    if not isinstance(metadata, dict):
        return ""
    value = metadata.get("finish_reason") or metadata.get("stop_reason")
    return str(value or "").strip().lower()


def _latest_task_verification(messages: list[Any]) -> dict[str, Any] | None:
    # A graph fork may inherit old ToolMessages. Verification belongs to the
    # current user turn only; otherwise a failed check from an ancestor Run can
    # permanently block an unrelated follow-up.
    explicit_turn_start = [
        index
        for index, message in enumerate(messages)
        if getattr(message, "type", None) == "human"
        and isinstance(getattr(message, "additional_kwargs", None), dict)
        and message.additional_kwargs.get("runtime_kind") == "task_input"
    ]
    fallback_turn_start = max(
        (
            index
            for index, message in enumerate(messages)
            if getattr(message, "type", None) == "human"
            and not (
                isinstance(getattr(message, "additional_kwargs", None), dict)
                and message.additional_kwargs.get("runtime_kind") == "steering"
            )
        ),
        default=0,
    )
    turn_start = explicit_turn_start[-1] if explicit_turn_start else fallback_turn_start
    scoped = messages[turn_start:]
    for reverse_index, message in enumerate(reversed(scoped)):
        if getattr(message, "type", None) != "tool":
            continue
        if getattr(message, "name", "") != "task.verify":
            continue
        payload = _parse_tool_content(getattr(message, "content", ""))
        if not isinstance(payload, dict):
            return {
                "ok": False,
                "reason": "task.verify returned an unreadable result",
                "tool_call_id": str(getattr(message, "tool_call_id", "")),
            }
        ok = _truthy(payload.get("ok"))
        verification_index = len(scoped) - reverse_index - 1
        if ok:
            stale_tool = _verification_invalidating_tool(scoped[verification_index + 1 :])
            if stale_tool is not None:
                return {
                    "ok": False,
                    "reason": f"verification became stale after tool {stale_tool}",
                    "tool_call_id": str(getattr(message, "tool_call_id", "")),
                }
        return {
            "ok": ok,
            "reason": "verification passed" if ok else _verification_reason(payload),
            "tool_call_id": str(getattr(message, "tool_call_id", "")),
        }
    return None


_VERIFICATION_PRESERVING_TOOLS = {
    "clipboard.read",
    "environment.observe",
    "glob",
    "grep",
    "ls",
    "memory.search",
    "office.outline",
    "office.read",
    "office.read_range",
    "office.read_slides",
    "open.file",
    "open.url",
    "pdf.inspect",
    "read_file",
    "task.progress",
    "time.now",
    "web.fetch",
    "web.search",
}


def _verification_invalidating_tool(messages: list[Any]) -> str | None:
    for message in messages:
        if getattr(message, "type", None) != "tool":
            continue
        name = str(getattr(message, "name", "") or "unknown")
        status = str(getattr(message, "status", "") or "").lower()
        if status == "error" or name not in _VERIFICATION_PRESERVING_TOOLS:
            return name
    return None


def _current_run_id(runtime: Any, messages: list[Any]) -> str:
    context = getattr(runtime, "context", None)
    value = getattr(context, "run_id", None)
    if isinstance(value, str) and value:
        return value
    for message in reversed(messages):
        kwargs = getattr(message, "additional_kwargs", None)
        if isinstance(kwargs, dict) and kwargs.get("runtime_kind") == "task_input":
            candidate = kwargs.get("runtime_run_id")
            if isinstance(candidate, str):
                return candidate
    return ""


def _repair_attempts_for_run(state: Any, run_id: str) -> int:
    repair_state = state.get("verification_repair_state") if isinstance(state, dict) else None
    if not isinstance(repair_state, dict) or repair_state.get("run_id") != run_id:
        return 0
    return _int_state(repair_state.get("attempts"))


def _route_attempts_for_run(state: Any, run_id: str, reason: str) -> int:
    route = state.get("completion_route") if isinstance(state, dict) else None
    if not isinstance(route, dict):
        return 0
    if route.get("run_id") != run_id or route.get("reason") != reason:
        return 0
    return _int_state(route.get("attempts"))


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
            if not isinstance(item, dict) or _truthy(item.get("ok")):
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
