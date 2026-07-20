"""Legacy plan approval persistence compatibility tests."""

from __future__ import annotations

from typing import Any

import pytest

from shejane_runtime.auth import LOCAL_OWNER_PRINCIPAL_ID
from shejane_runtime.runs import ExecutionSettlementError, _waiting_status_for_interrupts
from shejane_runtime.store.sqlite import LocalStore


class _Interrupt:
    def __init__(self, value: dict[str, Any]) -> None:
        self.value = value


async def test_plan_approval_store_get_or_create(tmp_path) -> None:
    store = await LocalStore.open(tmp_path / "local.db")
    try:
        run = await store.create_run(
            principal_id=LOCAL_OWNER_PRINCIPAL_ID,
            goal="Refactor task handling",
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

    finally:
        await store.close()


def test_plan_approval_interrupt_marks_run_waiting_for_input() -> None:
    assert (
        _waiting_status_for_interrupts([_Interrupt({"kind": "plan_approval"})]) == "waiting_input"
    )


def test_graph_cannot_wait_without_a_durable_interrupt() -> None:
    with pytest.raises(ExecutionSettlementError, match="without a durable interrupt"):
        _waiting_status_for_interrupts([])
