"""P4 reflection — two operating modes.

  ┌──────────────────┬──────────────────────────────────────────────────────┐
  │ stats (default)  │ Lightweight: count messages + final answer length,  │
  │                  │ write to `state["reflection"]`. Zero extra LLM cost. │
  ├──────────────────┼──────────────────────────────────────────────────────┤
  │ critic           │ One extra LLM call against the final answer: a      │
  │                  │ critic model scores it on coverage/clarity/grounding.│
  │ SHEJANE_LOCAL_ │ Result lands in `state["reflection"]["critic"]`.    │
  │ CRITIC=1         │ Caller decides whether to surface to the user.       │
  └──────────────────┴──────────────────────────────────────────────────────┘

Critic is opt-in because it doubles run cost on the post-answer leg.
"""

from __future__ import annotations

import logging
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage, SystemMessage

log = logging.getLogger("local_host.middleware.reflect")


CRITIC_SYSTEM_PROMPT = """You are a strict but constructive critic of agent answers.

Score the answer on three axes (1–5 each):
- Coverage: does it address the user's actual question?
- Clarity: is it concise and structured?
- Grounding: are claims backed by tool outputs / cited sources?

Then list up to 3 concrete improvements. Be terse — one line per item.

Return JSON only, this exact shape:
{"coverage": 0, "clarity": 0, "grounding": 0, "notes": ["...", "..."]}
"""


class ReflectMiddleware(AgentMiddleware):
    def __init__(self, *, critic_model: Any = None, enabled: bool | None = None) -> None:
        super().__init__()
        # `critic_model` is an injected `BaseChatModel` (only used when the
        # critic runs). If None at runtime, we fall back to the agent's
        # primary model — see `_run_critic`.
        self.critic_model = critic_model
        # Whether the real LLM critic runs. None ⇒ fall back to the
        # SHEJANE_LOCAL_CRITIC env var (legacy / standalone behavior);
        # builder.py passes an explicit bool so a per-run override
        # (Advanced agent settings) wins over the env default.
        self.enabled = enabled

    def _critic_enabled(self) -> bool:
        if self.enabled is not None:
            return self.enabled
        import os

        return os.environ.get("SHEJANE_LOCAL_CRITIC", "").lower() in {"1", "true", "yes"}

    def after_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        messages = state.get("messages") or []
        ai_count = sum(1 for m in messages if getattr(m, "type", None) == "ai")
        tool_count = sum(1 for m in messages if getattr(m, "type", None) == "tool")
        last_ai_content = ""
        for m in reversed(messages):
            if getattr(m, "type", None) == "ai":
                c = getattr(m, "content", "")
                if isinstance(c, str):
                    last_ai_content = c
                break

        summary: dict[str, Any] = {
            "ai_messages": ai_count,
            "tool_results": tool_count,
            "final_answer_chars": len(last_ai_content),
        }
        log.info("reflect %s", summary)
        return {"reflection": summary}

    async def aafter_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        # Default to the sync stats summary first.
        stats = self.after_agent(state, runtime) or {}

        if not self._critic_enabled():
            return stats

        critic_result = await self._run_critic(state, runtime)
        if critic_result is not None:
            stats.setdefault("reflection", {})["critic"] = critic_result
        return stats

    async def _run_critic(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        """Single LLM critic pass — best-effort, swallows errors."""
        messages = state.get("messages") or []
        user_q: str | None = None
        final_a: str | None = None
        for m in messages:
            if getattr(m, "type", None) == "human" and user_q is None:
                c = getattr(m, "content", "")
                user_q = c if isinstance(c, str) else None
        for m in reversed(messages):
            if getattr(m, "type", None) == "ai":
                c = getattr(m, "content", "")
                if isinstance(c, str) and c.strip():
                    final_a = c
                    break
        if not user_q or not final_a:
            return None

        # Try to reuse the agent's primary model via the runtime context
        # — falls back to nothing if not exposed (depends on LangGraph
        # version). The injected `critic_model` overrides this.
        model = self.critic_model or getattr(runtime, "context", None) or None

        if model is None or not hasattr(model, "ainvoke"):
            log.debug("critic skipped: no usable model on runtime")
            return None

        prompt_msgs = [
            SystemMessage(content=CRITIC_SYSTEM_PROMPT),
            HumanMessage(content=f"USER QUESTION:\n{user_q}\n\nFINAL ANSWER:\n{final_a}"),
        ]
        try:
            response = await model.ainvoke(prompt_msgs)
        except Exception as exc:
            log.warning("critic call failed: %s", exc)
            return None
        text = getattr(response, "content", "") or ""
        try:
            import json

            return json.loads(text) if isinstance(text, str) else None
        except Exception:
            log.debug("critic returned non-JSON: %s", text[:200])
            return {"raw": text[:1000]}
