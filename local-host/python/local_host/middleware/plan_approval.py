"""Plan approval middleware.

When Plan Mode is enabled, the first meaningful tool call should be
`write_todos`. This middleware pauses immediately after the model proposes
that call and before tools execute, so the renderer can ask the user to approve,
revise, or reject the plan.
"""

from __future__ import annotations

from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.types import interrupt

TODO_STATUSES = {"pending", "in_progress", "completed"}


class PlanApprovalMiddleware(AgentMiddleware):
    """Pause on `write_todos` until the user reviews the proposed plan."""

    def after_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        messages = list(state.get("messages") or [])
        if not messages:
            return None

        last_ai_msg = next((msg for msg in reversed(messages) if isinstance(msg, AIMessage)), None)
        if not last_ai_msg or not last_ai_msg.tool_calls:
            return None

        write_call = next(
            (call for call in last_ai_msg.tool_calls if call.get("name") == "write_todos"),
            None,
        )
        if write_call is None:
            return None

        todos = normalize_todos((write_call.get("args") or {}).get("todos"))
        payload = {
            "kind": "plan_approval",
            "tool_call_id": str(write_call.get("id") or ""),
            "todos": todos,
            "summary": summarize_todos(todos),
        }
        response = interrupt(payload)
        decision = response if isinstance(response, dict) else {}
        decision_type = str(decision.get("decision") or "approve")

        if decision_type == "approve":
            return None
        if decision_type not in {"modify", "reject"}:
            raise ValueError(f"Unexpected plan approval decision: {decision!r}")

        instructions = str(decision.get("instructions") or "").strip()
        artificial_messages = [
            _tool_feedback_for_decision(call, decision_type, instructions)
            for call in last_ai_msg.tool_calls
        ]
        return {"messages": [last_ai_msg, *artificial_messages]}

    async def aafter_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        return self.after_model(state, runtime)


def normalize_todos(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    todos: list[dict[str, str]] = []
    for item in value:
        if isinstance(item, dict):
            content = str(item.get("content") or "").strip()
            status = str(item.get("status") or "pending").strip()
        else:
            content = str(item).strip()
            status = "pending"
        if not content:
            continue
        todos.append(
            {
                "content": content,
                "status": status if status in TODO_STATUSES else "pending",
            }
        )
    return todos


def summarize_todos(todos: list[dict[str, str]]) -> str:
    return "; ".join(item["content"] for item in todos[:5])


def _tool_feedback_for_decision(
    tool_call: dict[str, Any],
    decision: str,
    instructions: str,
) -> ToolMessage:
    tool_name = str(tool_call.get("name") or "")
    tool_call_id = str(tool_call.get("id") or "")
    if tool_name == "write_todos":
        if decision == "modify":
            content = (
                "User requested changes to this plan before execution. "
                f"Instructions: {instructions or 'Revise the plan, then call write_todos again.'}"
            )
        else:
            content = (
                "User rejected this plan before execution. Do not execute it; "
                "ask the user how to proceed if the next step is unclear."
            )
    else:
        content = "Skipped because the plan was not approved before execution."
    return ToolMessage(
        content=content,
        name=tool_name or None,
        tool_call_id=tool_call_id,
        status="error",
    )
