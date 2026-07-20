from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage


class FakeApprovalModel:
    def __init__(self, content: str) -> None:
        self.content = content
        self.messages: list[Any] = []

    async def ainvoke(self, messages: list[Any], **_kwargs: Any) -> AIMessage:
        self.messages = messages
        return AIMessage(content=self.content)


@pytest.mark.asyncio
async def test_reviewer_returns_one_bounded_decision_per_operation() -> None:
    from shejane_runtime.middleware.approval_reviewer import review_approval_batch

    model = FakeApprovalModel(
        '{"decisions":[{"operation_id":"op-1","decision":"allow","reason":"requested test"}]}'
    )

    decisions = await review_approval_batch(
        model=model,
        task_goal="Run the test command",
        actions=[
            {
                "operation_id": "op-1",
                "tool_name": "execute",
                "risk": "external_or_unknown",
                "arguments": {"command": "make test", "api_key": "secret-value"},
            }
        ],
        timeout_seconds=1,
    )

    assert decisions == {"op-1": {"decision": "allow", "reason": "requested test"}}
    assert "secret-value" not in str(model.messages)


@pytest.mark.asyncio
async def test_reviewer_rejects_incomplete_or_unsupported_decisions() -> None:
    from shejane_runtime.middleware.approval_reviewer import (
        ApprovalReviewUnavailable,
        review_approval_batch,
    )

    model = FakeApprovalModel(
        '{"decisions":[{"operation_id":"other","decision":"deny","reason":"no"}]}'
    )

    with pytest.raises(ApprovalReviewUnavailable):
        await review_approval_batch(
            model=model,
            task_goal="Run tests",
            actions=[
                {
                    "operation_id": "op-1",
                    "tool_name": "execute",
                    "risk": "external_or_unknown",
                    "arguments": {"command": "make test"},
                }
            ],
            timeout_seconds=1,
        )
