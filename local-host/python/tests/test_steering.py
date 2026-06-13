"""Mid-run steering tests."""

from __future__ import annotations

from langchain_core.messages import HumanMessage

from local_host.middleware.steering import SteeringMiddleware
from local_host.store.sqlite import LocalStore


async def test_steering_middleware_injects_pending_instructions(tmp_path) -> None:
    store = await LocalStore.open(tmp_path / "local.db")
    try:
        run = await store.create_run(goal="Original task", workspace_path=None)
        first = await store.create_steering_instruction(
            run_id=run["id"],
            content="Focus on tests before editing.",
        )
        second = await store.create_steering_instruction(
            run_id=run["id"],
            content="Keep the patch small.",
        )
        emitted: list[tuple[str, dict]] = []

        async def emit(event_type: str, payload: dict) -> None:
            emitted.append((event_type, payload))

        middleware = SteeringMiddleware(store=store, run_id=run["id"], emit=emit)

        result = await middleware.abefore_model(
            {"messages": [HumanMessage(content="Original task")]},
            runtime=None,
        )

        assert result is not None
        injected = result["messages"][0]
        assert getattr(injected, "type", None) == "human"
        assert "Focus on tests before editing." in injected.content
        assert "Keep the patch small." in injected.content
        assert emitted == [
            (
                "steering.injected",
                {
                    "instruction_ids": [first["id"], second["id"]],
                    "count": 2,
                    "content": "Focus on tests before editing.\n\nKeep the patch small.",
                },
            )
        ]

        assert await store.claim_pending_steering(run["id"]) == []
    finally:
        await store.close()


async def test_steering_middleware_noops_without_pending_instructions(tmp_path) -> None:
    store = await LocalStore.open(tmp_path / "local.db")
    try:
        run = await store.create_run(goal="Original task", workspace_path=None)
        middleware = SteeringMiddleware(store=store, run_id=run["id"])

        assert await middleware.abefore_model({"messages": []}, runtime=None) is None
    finally:
        await store.close()
