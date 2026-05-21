"""user.ask — agent asks the user a clarifying question mid-run.

Calls LangGraph's `interrupt()` from inside the tool. The graph pauses,
RunCoordinator detects `snapshot.next` non-empty and emits `run.waiting`
with the question payload over SSE. The client shows UI, collects an
answer, then POSTs `/local/v1/questions/{id}` (or `/runs/{id}/resume`)
which `Command(resume=...)` the graph — the answer becomes this tool's
return value, which the main LLM consumes.

This fills the gap where:
  - HumanInTheLoopMiddleware handles "may I do this destructive thing?"
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

    Use this only when you genuinely cannot make progress without
    user input — every call pauses the run and surfaces a UI prompt.
    Prefer making a reasonable assumption when the cost of being wrong
    is low.

    Args:
        question: The question to show the user, plain text.
        options: Optional list of suggested answers; the client may
                 render them as buttons. The user may still answer
                 freely — your tool gets back whatever string they
                 supplied.

    Returns:
        The user's answer as a string. May be one of the suggested
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
        return str(raw.get("answer", ""))
    if isinstance(raw, str):
        return raw
    return str(raw) if raw is not None else ""


USER_TOOLS = [user_ask]
