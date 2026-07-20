from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage


class FakeClarificationModel:
    def __init__(self, content: str) -> None:
        self.content = content
        self.messages: list[Any] = []

    async def ainvoke(self, messages: list[Any], **_kwargs: Any) -> AIMessage:
        self.messages = messages
        return AIMessage(content=self.content)


@pytest.mark.asyncio
async def test_reviewer_rejects_a_question_already_answered_by_history() -> None:
    from shejane_runtime.middleware.clarification_reviewer import review_clarification_batch

    model = FakeClarificationModel(
        '{"decisions":[{"tool_call_id":"ask-1","decision":"repair",'
        '"reason":"The earlier assistant message contains the HTML and the user named 对对碰.html."}]}'
    )

    decisions = await review_clarification_batch(
        model=model,
        task_goal="帮我保存到桌面",
        messages=[
            HumanMessage(content="帮我写一个对对碰游戏"),
            AIMessage(content="<!doctype html><title>对对碰</title>"),
            HumanMessage(content="在桌面新建一个文本文件，命名为 对对碰.html"),
            HumanMessage(content="帮我保存到桌面"),
        ],
        questions=[
            {
                "tool_call_id": "ask-1",
                "question": "你想保存什么内容到桌面？",
                "options": [],
            }
        ],
        runtime_facts={"workspace_configured": False, "attachments": []},
        timeout_seconds=1,
    )

    assert decisions["ask-1"]["decision"] == "repair"
    assert "对对碰.html" in str(model.messages)


@pytest.mark.asyncio
async def test_reviewer_requires_exactly_one_supported_decision_per_question() -> None:
    from shejane_runtime.middleware.clarification_reviewer import (
        ClarificationReviewUnavailable,
        review_clarification_batch,
    )

    model = FakeClarificationModel(
        '{"decisions":[{"tool_call_id":"other","decision":"deny","reason":"no"}]}'
    )

    with pytest.raises(ClarificationReviewUnavailable):
        await review_clarification_batch(
            model=model,
            task_goal="save it",
            messages=[HumanMessage(content="save it")],
            questions=[{"tool_call_id": "ask-1", "question": "What?", "options": []}],
            runtime_facts={},
            timeout_seconds=1,
        )


@pytest.mark.asyncio
async def test_reviewer_accepts_a_single_fenced_json_object() -> None:
    from shejane_runtime.middleware.clarification_reviewer import review_clarification_batch

    model = FakeClarificationModel(
        '```json\n{"decisions":[{"tool_call_id":"ask-1","decision":"allow",'
        '"reason":"A real choice is missing."}]}\n```'
    )

    decisions = await review_clarification_batch(
        model=model,
        task_goal="choose a city",
        messages=[HumanMessage(content="weather")],
        questions=[{"tool_call_id": "ask-1", "question": "Which city?", "options": []}],
        runtime_facts={},
        timeout_seconds=1,
    )

    assert decisions["ask-1"]["decision"] == "allow"
