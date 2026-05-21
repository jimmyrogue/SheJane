"""P4 reflection — record a short critic note after the agent finishes.

Phase 3' ships the lightweight form: count messages, count tool calls,
attach a structured `reflection` dict to state. Phase 4'+ can promote this
to a real critic-reviser pass (extra LLM call).
"""

from __future__ import annotations

import logging
from typing import Any

from langchain.agents.middleware import AgentMiddleware

log = logging.getLogger("local_host.middleware.reflect")


class ReflectMiddleware(AgentMiddleware):
    def after_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:  # noqa: ARG002
        messages = state.get("messages") or []
        ai_count = sum(1 for m in messages if getattr(m, "type", None) == "ai")
        tool_count = sum(1 for m in messages if getattr(m, "type", None) == "tool")
        last_ai_len = 0
        for m in reversed(messages):
            if getattr(m, "type", None) == "ai":
                content = getattr(m, "content", "")
                last_ai_len = len(content) if isinstance(content, str) else 0
                break

        summary = {
            "ai_messages": ai_count,
            "tool_results": tool_count,
            "final_answer_chars": last_ai_len,
        }
        log.info("reflect %s", summary)
        return {"reflection": summary}
