from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage


class FakeCompletionModel:
    def __init__(self, content: str) -> None:
        self.content = content
        self.messages: list[Any] = []

    async def ainvoke(self, messages: list[Any], **_kwargs: Any) -> AIMessage:
        self.messages = messages
        return AIMessage(content=self.content)


@pytest.mark.asyncio
async def test_reviewer_repairs_a_final_answer_that_drops_a_subagent_result() -> None:
    from shejane_runtime.middleware.completion_reviewer import review_completion_candidate

    model = FakeCompletionModel(
        '{"decision":"repair","reason":"The final answer omits E2E_SUBAGENT_RESULT."}'
    )

    result = await review_completion_candidate(
        model=model,
        task_goal="Delegate the task, then include E2E_SUBAGENT_RESULT in the final answer.",
        messages=[
            HumanMessage(content="Delegate the task."),
            ToolMessage(
                content="E2E_SUBAGENT_RESULT",
                name="task",
                tool_call_id="task-1",
            ),
            AIMessage(content="完成。"),
        ],
        final_candidate="完成。",
        timeout_seconds=1,
    )

    assert result["decision"] == "repair"
    assert "E2E_SUBAGENT_RESULT" in str(model.messages)


@pytest.mark.asyncio
async def test_reviewer_allows_a_concise_answer_that_satisfies_the_goal() -> None:
    from shejane_runtime.middleware.completion_reviewer import review_completion_candidate

    model = FakeCompletionModel('{"decision":"allow","reason":"The requested result is present."}')

    result = await review_completion_candidate(
        model=model,
        task_goal="Include RESULT-1.",
        messages=[HumanMessage(content="Include RESULT-1."), AIMessage(content="RESULT-1")],
        final_candidate="RESULT-1",
        timeout_seconds=1,
    )

    assert result["decision"] == "allow"


@pytest.mark.asyncio
async def test_reviewer_rejects_invalid_or_extra_output_shape() -> None:
    from shejane_runtime.middleware.completion_reviewer import (
        CompletionReviewUnavailable,
        review_completion_candidate,
    )

    model = FakeCompletionModel(
        '{"decision":"repair","reason":"missing","instruction":"run another tool"}'
    )

    with pytest.raises(CompletionReviewUnavailable):
        await review_completion_candidate(
            model=model,
            task_goal="Do it.",
            messages=[HumanMessage(content="Do it."), AIMessage(content="Done")],
            final_candidate="Done",
            timeout_seconds=1,
        )
