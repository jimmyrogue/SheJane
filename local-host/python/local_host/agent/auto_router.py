"""Auto-mode classifier — when the user picks "Auto" in the UI we run a
cheap fast-model call on the user's goal (plus a few turns of history)
to decide whether the real agent run should use fast or deep.

Why an LLM and not heuristics: a length/tool-count rule misses the
"short prompt, big ask" case ("Refactor this controller for thread
safety" → deep) and the "long prompt, trivial ask" case (a pasted log
that just needs a one-line summary → fast).

The classifier is itself a fast-model call so it's cheap (~200 in / 30
out tokens). On any failure — network error, malformed JSON, unexpected
mode value — we fall back to 'fast', because picking fast over deep is
strictly cheaper and the user can always re-send on "Pro".
"""

from __future__ import annotations

import json
import logging
from typing import Literal

from langchain_core.messages import HumanMessage, SystemMessage

from ..llm.backend import BackendChatModel

log = logging.getLogger("local_host.agent.auto_router")

ResolvedMode = Literal["fast", "deep"]

CLASSIFIER_SYSTEM_PROMPT = """You are a routing classifier for an AI assistant. Decide whether the user's request should be handled by FAST or DEEP.

FAST is the cheaper, lower-latency tier. It's well suited to: simple Q&A, lookups, definitions, boilerplate code, short summaries, translations, format conversions, and tool-orchestration where the model mostly just calls tools.

DEEP is the higher-quality, more expensive tier. It's well suited to: multi-step reasoning, architectural decisions in code, nuanced long-form writing, error-compounding tasks (math derivations, legal/compliance reasoning, careful refactors), and anything where the user explicitly asks for thoroughness, depth, or careful thinking.

Rules:
- Prefer FAST when both tiers could plausibly do the job. We escalate to DEEP only when the task genuinely needs it.
- If the user explicitly asks to "think carefully", "be thorough", "analyze deeply", or similar → DEEP.
- If the task is just orchestrating tools (search, file ops, image generation) → FAST.
- Code requests: trivial syntax/boilerplate → FAST; design decisions or non-trivial refactors → DEEP.

Output a single JSON object on one line and nothing else:
{"mode":"fast"|"deep","reason":"<one short sentence, ≤20 words>"}"""


async def classify_mode(
    *,
    goal: str,
    history: list[dict[str, str]] | None,
    cloud_base_url: str,
    cloud_token: str,
    run_id: str,
) -> tuple[ResolvedMode, str]:
    """Pick fast or deep for an `auto`-mode run.

    Returns (mode, reason). Never raises — any failure resolves to
    ("fast", "<reason about why we couldn't decide>").
    """
    goal_clean = (goal or "").strip()
    if not goal_clean:
        return "fast", "empty goal defaults to fast"

    # Include the last 2 turns of history for context — enough to detect
    # "continue the analysis" type follow-ups without paying for a long
    # transcript.
    recent_history = [h for h in (history or []) if h.get("content")][-2:]
    history_block = ""
    if recent_history:
        lines = [f"{h.get('role', 'user')}: {h.get('content', '').strip()}" for h in recent_history]
        history_block = "RECENT CONTEXT:\n" + "\n".join(lines) + "\n\n"

    user_content = f"{history_block}USER REQUEST:\n{goal_clean}"

    model = BackendChatModel(
        cloud_base_url=cloud_base_url,
        cloud_token=cloud_token,
        mode="fast",
        run_id=run_id,
    )

    try:
        response = await model.ainvoke(
            [
                SystemMessage(content=CLASSIFIER_SYSTEM_PROMPT),
                HumanMessage(content=user_content),
            ]
        )
    except Exception as exc:
        log.warning("auto classifier call failed: %s", exc)
        return "fast", "classifier unavailable, defaulted to fast"

    text = getattr(response, "content", "") or ""
    if not isinstance(text, str):
        return "fast", "classifier returned non-text output"

    mode, reason = _parse_classifier_output(text)
    log.info("auto classifier picked mode=%s reason=%r", mode, reason)
    return mode, reason


def _parse_classifier_output(text: str) -> tuple[ResolvedMode, str]:
    """Pull {mode, reason} out of the model's output. Tolerant of stray
    prose around the JSON — we look for the first {...} block."""
    snippet = text.strip()
    start = snippet.find("{")
    end = snippet.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            data = json.loads(snippet[start : end + 1])
        except json.JSONDecodeError:
            data = None
        if isinstance(data, dict):
            mode_raw = str(data.get("mode", "")).strip().lower()
            reason_raw = str(data.get("reason", "")).strip()
            if mode_raw in ("fast", "deep"):
                return mode_raw, reason_raw or f"classifier picked {mode_raw}"

    # Fallback: keyword match on the raw text — sometimes models forget
    # the JSON wrapper but still say "deep" or "fast" clearly.
    lower = snippet.lower()
    if "deep" in lower and "fast" not in lower:
        return "deep", "classifier output unparseable, kept its deep signal"
    return "fast", "classifier output unparseable, defaulted to fast"
