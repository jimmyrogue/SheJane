"""P9 output guard — observe-only checks on assistant outputs.

When the assistant produces a problem-looking final answer (empty
content, bare refusal …) we log it for later analysis and tag run state
so other layers can react. We do NOT try to fix the answer by injecting
a retry nudge: when this middleware runs, the deepagents agent loop has
already decided the assistant is done (no further tool calls), so any
new message we append to state is never seen by another model call —
it just becomes the latest message and corrupts downstream consumers
(notably _extract_final_text in runs.py surfaced our injected nudge as
the user-visible reply).

Phase 4'+ may swap this for either an LLM-judge OR a real retry
mechanism that hooks back into the loop before termination.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from langchain.agents.middleware import AgentMiddleware

log = logging.getLogger("local_host.middleware.output_guard")

REFUSAL_PATTERNS = [
    re.compile(r"^\s*(对不起|抱歉|i\s+can(?:not|'?t)|sorry)", re.I),
]


def _looks_empty(text: str) -> bool:
    return not text or not text.strip()


def _looks_refusal_only(text: str) -> bool:
    stripped = text.strip()
    if len(stripped) > 120:
        return False
    return any(p.match(stripped) for p in REFUSAL_PATTERNS)


class OutputGuardMiddleware(AgentMiddleware):
    """Inspect the assistant's final message after every model call.

    Observe-only — see module docstring for why we don't inject retry
    nudges anymore.
    """

    def after_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        messages = state.get("messages") or []
        if not messages:
            return None
        last = messages[-1]
        if getattr(last, "type", None) != "ai":
            return None
        # If the assistant is asking for more tool calls, let the loop run.
        if getattr(last, "tool_calls", None):
            return None
        content = getattr(last, "content", "")
        text = content if isinstance(content, str) else ""

        if _looks_empty(text):
            log.warning(
                "output_guard: assistant produced empty final content — "
                "deepagents loop already terminated, can't auto-retry."
            )
            return {"output_guard_flag": "empty"}
        if _looks_refusal_only(text):
            log.info("output_guard: final answer looks like a bare refusal")
            return {"output_guard_flag": "refusal"}
        return None
