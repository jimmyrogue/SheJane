"""Mid-run steering middleware.

Users can append instructions while a long local run is still active. The HTTP
endpoint stores those instructions in SQLite; this middleware drains them at
the next `before_model` hook so the model sees the update before its next
reasoning step.
"""

from __future__ import annotations

from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage


class SteeringMiddleware(AgentMiddleware):
    """Inject queued user steering instructions before the next model call."""

    async def abefore_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        context = getattr(runtime, "context", None)
        store = getattr(context, "store", None)
        run_id = getattr(context, "run_id", None)
        if store is None or not run_id:
            return None
        rows = await store.claim_pending_steering(run_id)
        if not rows:
            return None

        contents = [str(row.get("content", "")).strip() for row in rows]
        content = "\n\n".join(item for item in contents if item)
        if not content:
            return None

        payload = {
            "instruction_ids": [row["id"] for row in rows],
            "count": len(rows),
            "content": content,
        }
        emit = getattr(context, "steering_emit", None)
        if emit is not None:
            await emit("steering.injected", payload)

        return {
            "messages": [
                HumanMessage(
                    content=(
                        "【运行中用户追加指令】\n"
                        "用户在当前任务执行中补充了下面的指示。请从下一步开始纳入当前任务；"
                        "如果它和较早指示冲突，以这条追加指示为准。\n\n"
                        f"{content}"
                    ),
                    additional_kwargs={"runtime_kind": "steering"},
                )
            ]
        }
