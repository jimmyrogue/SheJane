"""Legacy plan approval persistence compatibility tests."""

from __future__ import annotations

from typing import Any

from local_host.auth import LOCAL_OWNER_PRINCIPAL_ID
from local_host.runs import _waiting_status_for_interrupts
from local_host.store.sqlite import LocalStore


class _Interrupt:
    def __init__(self, value: dict[str, Any]) -> None:
        self.value = value


async def test_plan_approval_store_get_or_create_and_resolve(tmp_path) -> None:
    store = await LocalStore.open(tmp_path / "local.db")
    try:
        run = await store.create_run(
            principal_id=LOCAL_OWNER_PRINCIPAL_ID,
            goal="Refactor billing",
            workspace_path=None,
        )
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
