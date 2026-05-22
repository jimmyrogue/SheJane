"""Plan-First mode (Plan & Execute) middleware.

When enabled, the agent is **forced to start with planning** before
touching any other tool — concretely, the first model turn is steered
toward calling `write_todos` via a strong system-prompt injection at
`before_agent` time.

Modes (env JIANDANLY_PLAN_FIRST):
  off / 0           — disabled (default)
  on / always / 1   — every run gets the plan-first prompt
  auto              — only complex tasks get it
                      (heuristic: user message length / word count)

Why a middleware instead of just relying on TodoListMiddleware:
  TodoList's stock prompt "encourages" `write_todos` but doesn't force
  it. The agent often skips planning for borderline-complex tasks. This
  middleware injects a SystemMessage explicitly mandating the first
  action be a `write_todos` call (with a fallback line letting the
  agent skip iff the task is genuinely a one-liner).
"""

from __future__ import annotations

import logging
import os
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import SystemMessage

log = logging.getLogger("local_host.middleware.plan_first")


PLAN_FIRST_SYSTEM_PROMPT = """## Plan-First protocol

Before doing **any** other tool call, call `write_todos` with a numbered
plan of the steps you intend to take. Then execute the plan one step at
a time, marking each todo `done` as you complete it.

Two exceptions where you may skip the plan:
- The task is a single trivial lookup (e.g. "what time is it in Tokyo")
- The task is purely conversational with no tool use needed

For anything multi-step, multi-tool, or research-flavored: **plan first**.
"""

# Words that strongly suggest a non-trivial task — "auto" mode treats
# their presence as a signal to enable plan-first for this run.
COMPLEXITY_HINTS = (
    "research",
    "compare",
    "analyze",
    "summarize",
    "plan",
    "design",
    "investigate",
    "draft",
    "write",
    "build",
    "implement",
)

# Min user-message length (chars) that "auto" mode treats as complex.
AUTO_COMPLEX_CHARS = 140


class PlanFirstMiddleware(AgentMiddleware):
    """Inject a plan-first SystemMessage at the start of qualifying runs."""

    def __init__(self, mode: str | None = None) -> None:
        super().__init__()
        # Lock the mode at construction time so a single run sees a
        # consistent decision — env reads at before_agent could race.
        resolved = (mode or os.environ.get("JIANDANLY_PLAN_FIRST", "off")).lower().strip()
        if resolved in {"1", "true", "yes", "on", "always"}:
            self.mode = "always"
        elif resolved == "auto":
            self.mode = "auto"
        else:
            self.mode = "off"

    def before_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        if self.mode == "off":
            return None
        messages = list(state.get("messages") or [])
        if not messages:
            return None

        if self.mode == "auto" and not _looks_complex(messages):
            log.debug("plan-first auto skipped: task looks trivial")
            return None

        log.info("plan-first injecting protocol (mode=%s)", self.mode)
        return {"messages": [SystemMessage(content=PLAN_FIRST_SYSTEM_PROMPT), *messages]}


def _looks_complex(messages: list[Any]) -> bool:
    """Cheap heuristic — looks at the leading user message only."""
    first_user = next(
        (m for m in messages if getattr(m, "type", None) == "human"),
        None,
    )
    if first_user is None:
        return False
    text = getattr(first_user, "content", "")
    if not isinstance(text, str):
        return False
    if len(text) >= AUTO_COMPLEX_CHARS:
        return True
    lower = text.lower()
    return any(hint in lower for hint in COMPLEXITY_HINTS)
