"""P1 input_guard — coarse prompt-injection / jailbreak heuristic.

Mode (env SHEJANE_RUNTIME_INPUT_GUARD):
  off        — disable entirely
  observe    — flag suspicious input via an `input_guard` state key but
               let the run continue (default)
  block      — write an assistant refusal and jump to end

This is intentionally low-fidelity. ToolReviewMiddleware separately enforces
parameter-bound approval for consequential actions; this heuristic only
handles obvious hostile input patterns.
"""

from __future__ import annotations

import os
import re
from typing import Any

from langchain.agents.middleware import AgentMiddleware

# Match common jailbreak phrasing — "ignore previous instructions",
# "you are now ...", base64-blobs that look like injected prompts, etc.
SUSPICIOUS_PATTERNS = [
    re.compile(r"ignore\s+(all\s+)?(previous|prior|above)\s+instructions", re.I),
    re.compile(r"you\s+are\s+now\s+a", re.I),
    re.compile(r"system\s*[:：]\s*you\s+(are|will|must)", re.I),
    re.compile(r"<\s*/?\s*system\s*>", re.I),
    re.compile(r"developer\s*mode", re.I),
]


def _looks_suspicious(text: str) -> str | None:
    for pat in SUSPICIOUS_PATTERNS:
        m = pat.search(text)
        if m:
            return m.group(0)
    return None


class InputGuardMiddleware(AgentMiddleware):
    """Fires once per agent invocation, on the leading user message."""

    def __init__(self, mode: str | None = None) -> None:
        super().__init__()
        self.mode = (mode or os.environ.get("SHEJANE_RUNTIME_INPUT_GUARD", "observe")).lower()

    def before_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        if self.mode == "off":
            return None
        messages = state.get("messages") or []
        first_user = next(
            (m for m in messages if getattr(m, "type", None) == "human"),
            None,
        )
        if first_user is None:
            return None
        text = getattr(first_user, "content", "")
        if not isinstance(text, str):
            return None
        hit = _looks_suspicious(text)
        if hit is None:
            return None

        flag = {"input_guard": {"flagged": True, "pattern": hit}}
        if self.mode == "block":
            from langchain_core.messages import AIMessage

            flag["messages"] = [
                AIMessage(
                    content=(
                        "我不能按这条指令执行——其中存在覆盖系统提示词的迹象。"
                        "请换一种自然描述，或明确告诉我你的目标。"
                    )
                )
            ]
            flag["jump_to"] = "end"
        return flag
