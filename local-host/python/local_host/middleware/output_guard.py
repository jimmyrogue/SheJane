"""P9 output guard — minimum-bar checks on assistant outputs.

When the LLM emits a final answer (no further tool calls), we check that
it isn't trivially broken: empty content, looks-like-an-apology-only,
contains a refusal pattern that's actually unsafe to surface, etc. If a
check fails we *don't* try to fix the output here — we push a nudge back
into the conversation so the next model turn can do better.

Phase 4'+ may swap the heuristics for an LLM-judge.
"""

from __future__ import annotations

import re
from typing import Any

from langchain.agents.middleware import AgentMiddleware

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
    """Inspect the assistant's final message after every model call."""

    def __init__(self, *, max_nudges: int = 1) -> None:
        super().__init__()
        self.max_nudges = max_nudges

    def after_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:  # noqa: ARG002
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

        nudges = state.get("output_guard_nudges", 0)
        if nudges >= self.max_nudges:
            return None

        if _looks_empty(text):
            return {
                "output_guard_nudges": nudges + 1,
                "messages": [
                    _system_nudge(
                        "Your last response was empty. Please answer the user's "
                        "question explicitly, in one or two short paragraphs."
                    )
                ],
            }

        if _looks_refusal_only(text):
            return {
                "output_guard_nudges": nudges + 1,
                "messages": [
                    _system_nudge(
                        "That looked like a bare refusal. If the task is genuinely "
                        "out of scope, say so AND propose what you *can* do."
                    )
                ],
            }
        return None


def _system_nudge(text: str):
    from langchain_core.messages import HumanMessage

    # Use HumanMessage rather than SystemMessage so the model treats it as
    # in-conversation feedback instead of re-applying it as a global rule.
    return HumanMessage(content=text)
