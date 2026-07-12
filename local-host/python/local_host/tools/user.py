"""user.ask — agent asks the user a clarifying question mid-run.

Calls LangGraph's `interrupt()` from inside the tool. The graph pauses,
RunCoordinator detects `snapshot.next` non-empty and emits `run.waiting`
with the question payload over SSE. The client shows UI, collects an
answer, then POSTs `/local/v1/questions/{id}`. The Runtime persists that typed
answer before using `Command(resume=...)`; the answer becomes this tool's
return value, which the main LLM consumes.

This fills the gap where:
  - ToolReviewMiddleware handles "may I perform this consequential action?"
    (permission, pre-tool-call gate)
  - user.ask handles "please clarify something for me" (mid-task Q&A,
    explicit tool call from the LLM)
"""

from __future__ import annotations

from typing import Any

from langchain_core.tools import tool
from langgraph.types import interrupt


@tool("user.ask")
def user_ask(question: str, options: list[str] | None = None) -> str:
    """Ask the human a clarifying question and wait for their answer.

    CALL THIS *BEFORE* OTHER TOOLS when the user's request is missing
    a key input. The full "input audit" rule lives in the developer
    system prompt under "动手前的输入盘点"; in short — list what your
    answer needs, list what you have, ask for the gap before reaching
    for web.search / read_file / image.generate.

    Common cases where this tool runs first:
      * "今天天气怎么样"   → ask city BEFORE web.search
      * "总结这个文档"     → ask file path BEFORE read_file
      * "帮我写个 PPT"     → ask topic / audience BEFORE drafting
      * "搜一下最新进展"   → ask the actual subject BEFORE web.search
      * "帮我订机票"       → ask origin / destination / date

    Skipping this and calling web.search / read_file / image.generate
    with incomplete inputs wastes user credits, clutters the context
    with irrelevant results, and forces you to ask anyway one turn
    later — a real failure mode this codebase has shipped.

    The client renders the question as a clickable card above the
    composer with the supplied options as buttons — much better UX
    than writing the question as markdown in your reply.

    HARD RULES (see "向用户澄清" in the developer system prompt for
    full guidance):
      * One question per call. If you have two questions, make two
        calls; never stack questions inside the `question` text.
      * `options` must be the clickable answers to THIS question.
        Don't put long descriptions in `options`; put short labels.
      * Keep using this tool across rounds — don't switch to prose
        questions after a few calls.

    Examples of GOOD usage:
        user_ask(question="你想在普吉岛待几天？", options=["3天", "5天", "7天"])
        user_ask(question="选择行程风格", options=["放松", "探索", "均衡"])

    AVOID:
        user_ask(question="A) 几天 B) 风格", options=["3天","5天","放松","探索"])
        (multiple questions in one call; options answer only some of them)

    Args:
        question: The question text shown to the user. Keep it short
                  and focused on a single decision.
        options: Suggested answers, each a short label (≤20 chars).
                 Required when there are discrete choices; pass None
                 only when free-form text is the natural input.

    Returns:
        The user's answer as a string. May be one of the supplied
        options, free-form text, or — if the user closed the prompt
        without answering — the empty string.
    """
    payload: dict[str, Any] = {
        "kind": "question",
        "question": question,
        "options": list(options) if options else [],
    }
    # `interrupt()` suspends graph execution, surfaces `payload` as the
    # waiting value, and resumes returning whatever the caller passes
    # to `Command(resume=...)`. By convention we pass `{"answer": "..."}`.
    raw = interrupt(payload)
    if isinstance(raw, dict):
        # Two accepted resume shapes:
        #   1. The client's contract — `{"answers": {question_id: [text]}}`
        #      where the question_id matches what the daemon assigned in
        #      `local_questions`. Multi-question support, ergonomic for
        #      future expansion.
        #   2. Legacy / curl-friendly — `{"answer": "text"}`.
        # Pick the first string we can find from either shape.
        answers = raw.get("answers")
        if isinstance(answers, dict):
            for value in answers.values():
                if isinstance(value, list) and value:
                    return str(value[0])
                if isinstance(value, str) and value:
                    return value
        if "answer" in raw:
            return str(raw.get("answer", ""))
    if isinstance(raw, str):
        return raw
    return str(raw) if raw is not None else ""


USER_TOOLS = [user_ask]
