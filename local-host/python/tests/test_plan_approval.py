"""Plan approval middleware and persistence tests."""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage

from local_host.runs import _waiting_status_for_interrupts
from local_host.store.sqlite import LocalStore


class _Interrupt:
    def __init__(self, value: dict[str, Any]) -> None:
        self.value = value


async def test_plan_approval_store_get_or_create_and_resolve(tmp_path) -> None:
    store = await LocalStore.open(tmp_path / "local.db")
    try:
        run = await store.create_run(goal="Refactor billing", workspace_path=None)
        todos = [
            {"content": "Add focused tests", "status": "pending"},
            {"content": "Implement the smallest change", "status": "pending"},
        ]

        first = await store.create_plan_approval(
            run_id=run["id"],
            tool_call_id="call-plan",
            todos=todos,
            summary="Add focused tests; Implement the smallest change",
        )
        second = await store.create_plan_approval(
            run_id=run["id"],
            tool_call_id="call-plan",
            todos=todos,
            summary="Add focused tests; Implement the smallest change",
        )

        assert second["id"] == first["id"]
        assert second["todos"] == todos
        assert second["status"] == "pending"

        resolved = await store.resolve_plan_approval(
            first["id"],
            status="modified",
            instructions="Split the API and UI work.",
        )

        assert resolved is not None
        assert resolved["status"] == "modified"
        assert resolved["instructions"] == "Split the API and UI work."
        assert resolved["resolved_at"]
    finally:
        await store.close()


def test_plan_approval_interrupt_marks_run_waiting_for_input() -> None:
    assert (
        _waiting_status_for_interrupts([_Interrupt({"kind": "plan_approval"})]) == "waiting_input"
    )


def test_plan_approval_middleware_modify_skips_sibling_tool_calls(monkeypatch) -> None:
    import local_host.middleware.plan_approval as plan_mod

    captured: dict[str, Any] = {}

    def fake_interrupt(payload: dict[str, Any]) -> dict[str, str]:
        captured["payload"] = payload
        return {"decision": "modify", "instructions": "Add a verification step first."}

    monkeypatch.setattr(plan_mod, "interrupt", fake_interrupt)

    middleware = plan_mod.PlanApprovalMiddleware()
    message = AIMessage(
        content="",
        tool_calls=[
            {
                "name": "write_todos",
                "args": {
                    "todos": [
                        {"content": "Edit the daemon", "status": "pending"},
                        {"content": "Update the UI", "status": "pending"},
                    ]
                },
                "id": "call-plan",
            },
            {
                "name": "execute",
                "args": {"command": "make test"},
                "id": "call-execute",
            },
        ],
    )

    result = middleware.after_model({"messages": [message]}, runtime=None)

    assert captured["payload"] == {
        "kind": "plan_approval",
        "tool_call_id": "call-plan",
        "todos": [
            {"content": "Edit the daemon", "status": "pending"},
            {"content": "Update the UI", "status": "pending"},
        ],
        "summary": "Edit the daemon; Update the UI",
    }
    assert result is not None
    tool_messages = result["messages"][1:]
    assert [item.tool_call_id for item in tool_messages] == ["call-plan", "call-execute"]
    assert "Add a verification step first." in tool_messages[0].content
    assert "Skipped because the plan was not approved" in tool_messages[1].content
