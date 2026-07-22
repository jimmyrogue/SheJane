from __future__ import annotations

from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from shejane_runtime.auth import LOCAL_OWNER_PRINCIPAL_ID
from shejane_runtime.runs import _assistant_draft_from_state, _assistant_draft_from_update
from shejane_runtime.store.sqlite import LocalStore


def test_extracts_complete_ai_message_not_user_or_tool_state() -> None:
    message = AIMessage(
        id="ai-1",
        content="complete answer",
        tool_calls=[{"id": "call-1", "name": "time.now", "args": {}, "type": "tool_call"}],
    )

    draft = _assistant_draft_from_update({"model": {"messages": [message]}})

    assert draft is not None
    assert draft["content"] == "complete answer"
    assert draft["tool_calls"][0]["name"] == "time.now"


def test_final_draft_keeps_text_from_tool_call_rounds() -> None:
    run_id = "run-current"
    state = {
        "messages": [
            AIMessage(content="previous conversation"),
            HumanMessage(
                content="inspect web fetch",
                additional_kwargs={
                    "runtime_kind": "task_input",
                    "runtime_run_id": run_id,
                },
            ),
            AIMessage(
                id="ai-research",
                content="The implementation has three layers.",
                tool_calls=[{"id": "call-1", "name": "grep", "args": {}, "type": "tool_call"}],
            ),
            ToolMessage(content="result", tool_call_id="call-1"),
            AIMessage(id="ai-final", content="Ask me if you want a live verification."),
        ]
    }

    draft = _assistant_draft_from_state(state, run_id=run_id)

    assert draft is not None
    assert draft["content"] == (
        "The implementation has three layers.\n\nAsk me if you want a live verification."
    )
    assert draft["tool_calls"] == []


@pytest.mark.asyncio
async def test_draft_update_is_idempotent_and_revisions_are_monotonic(tmp_path: Path) -> None:
    store = await LocalStore.open(tmp_path / "runtime.db")
    run = await store.create_run(
        principal_id=LOCAL_OWNER_PRINCIPAL_ID,
        goal="test",
        workspace_path=None,
    )
    run_id = str(run["id"])
    try:
        first = await store.update_assistant_draft(
            run_id=run_id,
            message_key="one",
            content="first",
            tool_calls=[],
        )
        replay = await store.update_assistant_draft(
            run_id=run_id,
            message_key="one",
            content="first",
            tool_calls=[],
        )
        second = await store.update_assistant_draft(
            run_id=run_id,
            message_key="two",
            content="second",
            tool_calls=[],
        )

        assert first["revision"] == replay["revision"] == 1
        assert second["revision"] == 2
        assert (await store.get_assistant_draft(run_id))["content"] == "second"
    finally:
        await store.close()
