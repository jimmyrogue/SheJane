"""Mid-loop reflection: critique tool results before the main LLM consumes them.

Existing reflection only fires at end-of-run (`ReflectMiddleware`) or
catches empty/refusal final answers (`OutputGuardMiddleware`). Both are
*after the fact*. By then the main LLM has already used dirty tool
results to write the answer.

This middleware fires per `wrap_tool_call`: every time a watched tool
returns a `ToolMessage`, a cheap LLM is asked "is this usable for the
original task?" If not, we either:
  - prepend a warning to the ToolMessage so the main LLM notices and
    can decide to retry (mode='nudge'), or
  - replace the ToolMessage entirely with a "retry with different
    approach" signal (mode='block').

Modes (env `JIANDANLY_LOCAL_TOOL_CRITIC`):
  off       — middleware not added (default)
  watch     — run critic + log verdict but don't mutate the ToolMessage
  nudge     — prepend ⚠️ warning when verdict.usable == false
  block     — replace ToolMessage content entirely when not usable
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage

log = logging.getLogger("local_host.middleware.tool_critic")


# Tools whose output is "lossy" / "error-prone enough to be worth critiquing".
# trivial tools (time.now, clipboard.*, open.*, environment.observe,
# task.verify) deliberately omitted — their outputs are structured and
# rarely need second-guessing.
DEFAULT_WATCH_TOOLS = frozenset(
    {
        "web.fetch",
        "tavily_search",
        "task",         # subagent dispatch
        "browser.task", # browser-use agent
        "execute",      # deepagents shell-equivalent
        "read_file",    # binary / huge files
        "edit_file",    # may silently noop on mismatched anchor
    }
)


CRITIC_SYSTEM_PROMPT = """You are a strict tool-result reviewer.

Given a tool name, its arguments, and what the tool returned, decide
whether the result is USABLE for completing the user's original task.

Common signals that a result is NOT usable:
- Error messages, 404 pages, paywalls, login walls
- Off-topic content (search returned irrelevant results, fetched wrong page)
- Empty/whitespace, generic apologies, or stub answers
- Obvious truncation where the key info is missing
- Schema-broken structured output

Respond with JSON only, no prose:
{"usable": true|false, "reason": "<one short sentence>"}
"""


class ToolResultCriticMiddleware(AgentMiddleware):
    """Critique watched tool results and optionally annotate or replace."""

    def __init__(
        self,
        *,
        critic_model: Any = None,
        watch_tools: set[str] | None = None,
        mode: str | None = None,
        max_input_chars: int = 2_000,
    ) -> None:
        super().__init__()
        self.critic_model = critic_model
        self.watch_tools = set(watch_tools) if watch_tools else set(DEFAULT_WATCH_TOOLS)
        self.mode = self._resolve_mode(mode)
        self.max_input_chars = max_input_chars

    @staticmethod
    def _resolve_mode(explicit: str | None) -> str:
        raw = (explicit or os.environ.get("JIANDANLY_LOCAL_TOOL_CRITIC", "off")).lower().strip()
        if raw in {"watch", "nudge", "block"}:
            return raw
        return "off"

    async def awrap_tool_call(self, request: Any, handler: Any) -> Any:
        # Always execute the tool first — we observe, not block, by default.
        result = await handler(request)

        if self.mode == "off":
            return result

        tool_name = request.tool_call.get("name", "")
        if tool_name not in self.watch_tools:
            return result

        if not isinstance(result, ToolMessage):
            # Some interceptors return Command instead of ToolMessage.
            # Don't critique those — too implementation-specific.
            return result

        verdict = await self._run_critic(request, result)

        log.info(
            "tool.critic verdict=%s tool=%s mode=%s reason=%s",
            verdict.get("usable"),
            tool_name,
            self.mode,
            verdict.get("reason", ""),
        )

        if verdict.get("usable", True):  # default to usable on uncertainty
            return result

        if self.mode == "watch":
            return result

        if self.mode == "block":
            return ToolMessage(
                content=(
                    f"⚠️ Tool result rejected by mid-loop critic. "
                    f"Reason: {verdict.get('reason', 'result unusable')}. "
                    f"Please retry with a different approach (revised args, "
                    f"different tool, or skip this step)."
                ),
                tool_call_id=result.tool_call_id,
                name=result.name,
            )

        # mode == "nudge" — prepend warning, keep original payload.
        original = _stringify(result.content)
        result.content = (
            f"⚠️ MID-LOOP CRITIC: {verdict.get('reason', 'result looks insufficient')}\n"
            f"Consider retrying or trying a different approach.\n"
            f"---\n{original}"
        )
        return result

    async def _run_critic(self, request: Any, result: Any) -> dict[str, Any]:
        """Best-effort cheap critic call. Failures → assume usable (fail-open)."""
        if self.critic_model is None or not hasattr(self.critic_model, "ainvoke"):
            log.debug("tool.critic skipped: no critic_model")
            return {"usable": True, "reason": "no critic model configured"}

        original_task = _extract_first_user_text(request)
        tool_name = request.tool_call.get("name", "")
        tool_args = request.tool_call.get("args", {})
        result_text = _stringify(result.content)[: self.max_input_chars]
        truncated_note = (
            " (truncated)"
            if isinstance(result.content, str) and len(result.content) > self.max_input_chars
            else ""
        )

        prompt = HumanMessage(
            content=(
                f"ORIGINAL TASK:\n{original_task or '(unknown)'}\n\n"
                f"TOOL: {tool_name}\n"
                f"ARGS: {json.dumps(tool_args, default=str)[:500]}\n\n"
                f"RESULT{truncated_note}:\n{result_text}"
            )
        )

        try:
            response = await self.critic_model.ainvoke(
                [SystemMessage(content=CRITIC_SYSTEM_PROMPT), prompt]
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("tool.critic call failed: %s", exc)
            return {"usable": True, "reason": "critic call failed (fail-open)"}

        text = getattr(response, "content", "")
        if not isinstance(text, str):
            return {"usable": True, "reason": "critic returned non-string"}

        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            log.debug("tool.critic returned non-JSON: %s", text[:200])
            return {"usable": True, "reason": "critic returned non-JSON (fail-open)"}

        if not isinstance(parsed, dict):
            return {"usable": True, "reason": "critic JSON not an object"}
        return parsed


def _stringify(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for piece in content:
            if isinstance(piece, dict) and piece.get("type") == "text":
                parts.append(str(piece.get("text", "")))
            else:
                parts.append(str(piece))
        return "".join(parts)
    return str(content)


def _extract_first_user_text(request: Any) -> str:
    """Pull the original user prompt out of the runtime state so the
    critic can judge usability *against the task*, not just the tool."""
    state = getattr(request, "state", None)
    if not state:
        return ""
    messages = state.get("messages") if isinstance(state, dict) else None
    if not messages:
        return ""
    for msg in messages:
        if getattr(msg, "type", None) == "human":
            content = getattr(msg, "content", "")
            return content if isinstance(content, str) else ""
    return ""
