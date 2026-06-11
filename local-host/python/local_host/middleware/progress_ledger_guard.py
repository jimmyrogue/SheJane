"""Bounded progress-ledger refresh guard for long-running local work.

Diagnostics can tell the user that a handoff ledger is missing or stale, but a
long-running harness should nudge the model before it finalizes. This middleware
does that narrowly: after a final model turn, if the run used any non-progress
tool and has not called `task.progress` after the latest such tool, it asks the
model to refresh the ledger and jumps back to the model once.
"""

from __future__ import annotations

import json
from typing import Any

from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain_core.messages import HumanMessage

_CONTROL_TOOLS = {
    "clipboard.read",
    "clipboard.write",
    "environment.observe",
    "open.file",
    "open.url",
    "task.verify",
    "time.now",
    "user.ask",
    "workspace.open",
    "write_todos",
}


class ProgressLedgerGuardMiddleware(AgentMiddleware):
    """Ask the model to refresh `task.progress` before finalizing tool work."""

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

        gap = _progress_ledger_gap(messages)
        if gap is None:
            return None

        attempts = _int_state(state.get("progress_ledger_guard_attempts"))
        if attempts >= self.max_attempts:
            return {
                "progress_ledger_guard": {
                    "status": "exhausted",
                    "attempts": attempts,
                    "max_attempts": self.max_attempts,
                    "last_tool": gap["last_tool"],
                }
            }

        attempt = attempts + 1
        return {
            "messages": [
                HumanMessage(
                    content=(
                        "Before finalizing, refresh the durable progress ledger.\n"
                        f"Latest work tool after the last ledger update: `{gap['last_tool']}`.\n\n"
                        "Call `task.progress` with the current summary, acceptance "
                        "criteria, decisions, files touched, validation commands, "
                        "unresolved risks, and next actions. Then provide the final answer."
                    )
                )
            ],
            "progress_ledger_guard_attempts": attempt,
            "progress_ledger_guard": {
                "status": "refresh_requested",
                "attempts": attempt,
                "max_attempts": self.max_attempts,
                "last_tool": gap["last_tool"],
            },
            "jump_to": "model",
        }


def _progress_ledger_gap(messages: list[Any]) -> dict[str, str] | None:
    latest_work_index = -1
    latest_work_tool = ""
    latest_progress_index = -1

    for index, message in enumerate(messages):
        if getattr(message, "type", None) != "tool":
            continue
        name = str(getattr(message, "name", "") or "")
        if name == "task.progress":
            if _progress_message_ok(getattr(message, "content", "")):
                latest_progress_index = index
            continue
        if name and name not in _CONTROL_TOOLS and _tool_message_success(message):
            latest_work_index = index
            latest_work_tool = name

    if latest_work_index < 0:
        return None
    if latest_progress_index > latest_work_index:
        return None
    return {"last_tool": latest_work_tool or "unknown"}


def _progress_message_ok(content: Any) -> bool:
    parsed = _parse_tool_content(content)
    if not isinstance(parsed, dict):
        return True
    if "ok" not in parsed:
        return True
    return _truthy(parsed.get("ok"))


def _tool_message_success(message: Any) -> bool:
    status = str(getattr(message, "status", "") or "").strip().lower()
    if status and status not in {"success", "ok"}:
        return False
    parsed = _parse_tool_content(getattr(message, "content", ""))
    if isinstance(parsed, dict) and "ok" in parsed:
        return _truthy(parsed.get("ok"))
    return True


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


def _int_state(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0
