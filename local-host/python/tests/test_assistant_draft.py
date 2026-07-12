from __future__ import annotations

from pathlib import Path

import pytest
from langchain_core.messages import AIMessage

from local_host.auth import LOCAL_OWNER_PRINCIPAL_ID
from local_host.runs import _assistant_draft_from_update
from local_host.store.sqlite import LocalStore


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
