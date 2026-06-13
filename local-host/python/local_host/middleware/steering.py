"""Mid-run steering middleware.

Users can append instructions while a long local run is still active. The HTTP
endpoint stores those instructions in SQLite; this middleware drains them at
the next `before_model` hook so the model sees the update before its next
reasoning step.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage

from ..store.sqlite import LocalStore

SteeringEmitter = Callable[[str, dict[str, Any]], Awaitable[None]]


class SteeringMiddleware(AgentMiddleware):
    """Inject queued user steering instructions before the next model call."""

    def __init__(
        self,
        *,
        store: LocalStore,
        run_id: str,
        emit: SteeringEmitter | None = None,
    ) -> None:
        super().__init__()
        self.store = store
        self.run_id = run_id
        self.emit = emit

    async def abefore_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        rows = await self.store.claim_pending_steering(self.run_id)
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
        if self.emit is not None:
            await self.emit("steering.injected", payload)

        return {
            "messages": [
                HumanMessage(
                    content=(
                        "【运行中用户追加指令】\n"
                        "用户在当前任务执行中补充了下面的指示。请从下一步开始纳入当前任务；"
                        "如果它和较早指示冲突，以这条追加指示为准。\n\n"
                        f"{content}"
                    )
                )
            ]
        }
