"""P2 fast/deep routing — pick the conversation's mode at the first model
call based on heuristic difficulty signals.

This is *not* a real router (would need to call an LLM to decide). Phase 3'
ships the simple form: count user message length, count number of tool
results so far, escalate to "deep" when either is large.
"""

from __future__ import annotations

import logging
from typing import Any

from langchain.agents.middleware import AgentMiddleware

log = logging.getLogger("local_host.middleware.router")


class FastDeepRouterMiddleware(AgentMiddleware):
    """Tag the current run as fast/deep before the first model call."""

    def __init__(
        self,
        *,
        deep_user_length_threshold: int = 500,
        deep_tool_count_threshold: int = 3,
    ) -> None:
        super().__init__()
        self.deep_user_length_threshold = deep_user_length_threshold
        self.deep_tool_count_threshold = deep_tool_count_threshold

    def before_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:  # noqa: ARG002
        # Only run once: if we already chose, leave it be.
        if state.get("mode_route") in ("fast", "deep"):
            return None

        messages = state.get("messages") or []
        user_chars = 0
        tool_count = 0
        for msg in messages:
            msg_type = getattr(msg, "type", None)
            if msg_type == "human":
                content = getattr(msg, "content", "")
                user_chars += len(content) if isinstance(content, str) else 0
            elif msg_type == "tool":
                tool_count += 1

        deep = (
            user_chars >= self.deep_user_length_threshold
            or tool_count >= self.deep_tool_count_threshold
        )
        mode = "deep" if deep else "fast"
        log.info(
            "router pick mode=%s (user_chars=%d, tool_count=%d)",
            mode,
            user_chars,
            tool_count,
        )
        # State key downstream tooling can read; BackendChatModel itself
        # reads `mode` from its own field, set at build_agent time. Future
        # work: pipe this back into the model via `wrap_model_call`.
        return {"mode_route": mode}
