from __future__ import annotations

import re
from collections.abc import AsyncIterator, Sequence
from pathlib import Path

import pytest
from langchain_core.callbacks import AsyncCallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessageChunk, BaseMessage, HumanMessage
from langchain_core.outputs import ChatGenerationChunk, ChatResult
from langchain_core.tools import tool
from langgraph.graph import START, MessagesState, StateGraph

from local_host.auth import LOCAL_OWNER_PRINCIPAL_ID
from local_host.llm.ledger import (
    LedgerChatModel,
    ModelContextBudgetExceeded,
    _conservative_token_count,
    _enforce_context_envelope,
)
from local_host.store.sqlite import LocalStore, ModelCallBudgetExceeded


class _StreamingModel(BaseChatModel):
    fail_after_output: bool = False

    @property
    def _llm_type(self) -> str:
        return "ledger-test"

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: object,
    ) -> AsyncIterator[ChatGenerationChunk]:
        yield ChatGenerationChunk(message=AIMessageChunk(content="hello"))
        if self.fail_after_output:
            raise TimeoutError("provider disconnected")
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content="",
                usage_metadata={"input_tokens": 7, "output_tokens": 3, "total_tokens": 10},
                response_metadata={"request_id": "provider-1"},
            )
        )

    async def _agenerate(self, *args: object, **kwargs: object) -> ChatResult:
        raise NotImplementedError

    def _generate(self, *args: object, **kwargs: object) -> ChatResult:
        raise NotImplementedError


class _BindableStreamingModel(_StreamingModel):
    bound_tool_names: tuple[str, ...] = ()

    def bind_tools(
        self,
        tools: Sequence[object],
        *,
        tool_choice: str | None = None,
        **kwargs: object,
    ) -> BaseChatModel:
        del tool_choice, kwargs
        return self.model_copy(
            update={
                "bound_tool_names": tuple(
                    str(item["function"]["name"])  # type: ignore[index]
                    for item in tools
                )
            }
        )


class _RunnableBindingStreamingModel(_StreamingModel):
    def bind_tools(
        self,
        tools: Sequence[object],
        *,
        tool_choice: str | None = None,
        **kwargs: object,
    ) -> BaseChatModel:
        return self.bind(tools=tools, tool_choice=tool_choice, **kwargs)  # type: ignore[return-value]


class _StrictToolStreamingModel(_StreamingModel):
    bound_tool_name: str = ""

    def bind_tools(
        self,
        tools: Sequence[object],
        *,
        tool_choice: str | None = None,
        **kwargs: object,
    ) -> BaseChatModel:
        del tool_choice, kwargs
        function = tools[0]["function"]  # type: ignore[index]
        name = str(function["name"])
        assert re.fullmatch(r"[a-zA-Z0-9_-]+", name)
        return self.model_copy(update={"bound_tool_name": name})

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: object,
    ) -> AsyncIterator[ChatGenerationChunk]:
        del messages, stop, run_manager, kwargs
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content="",
                tool_call_chunks=[
                    {"name": self.bound_tool_name, "args": "{}", "id": "call-1", "index": 0}
                ],
            )
        )


@tool("office.read")
def _office_read(path: str) -> str:
    """Read an Office document."""
    return path


@tool("workspace.read")
def _workspace_read(path: str) -> str:
    """Read a workspace file."""
    return path


async def _store_and_run(tmp_path: Path) -> tuple[LocalStore, dict[str, object]]:
    store = await LocalStore.open(tmp_path / "runtime.db")
    run = await store.create_run(
        principal_id=LOCAL_OWNER_PRINCIPAL_ID,
        goal="test",
        workspace_path=None,
    )
    return store, run


@pytest.mark.asyncio
async def test_stream_settles_usage_without_reading_sse(tmp_path: Path) -> None:
    store, run = await _store_and_run(tmp_path)
    try:
        model = LedgerChatModel(
            delegate=_StreamingModel(),
            store=store,
            run_id=str(run["id"]),
            execution_attempt_id="job-1:1",
            model_name="local:test:model",
            max_calls=2,
            profile={"max_input_tokens": 8_192},
        )

        chunks = [chunk async for chunk in model.astream([HumanMessage(content="hi")])]

        assert "".join(str(chunk.content) for chunk in chunks) == "hello"
        assert await store.model_usage_summary(str(run["id"])) == {
            "input_tokens": 7,
            "output_tokens": 3,
            "unmetered_calls": 0,
            "outcome_unknown_calls": 0,
            "model_calls": 1,
        }
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_graph_message_stream_exposes_only_ledger_model_chunks(tmp_path: Path) -> None:
    store, run = await _store_and_run(tmp_path)
    try:
        model = LedgerChatModel(
            delegate=_RunnableBindingStreamingModel(),
            store=store,
            run_id=str(run["id"]),
            execution_attempt_id="job-1:1",
            model_name="local:test:model",
            max_calls=2,
            profile={"max_input_tokens": 8_192},
        ).bind_tools([_workspace_read])

        async def call_model(state: MessagesState) -> dict[str, list[BaseMessage]]:
            return {"messages": [await model.ainvoke(state["messages"])]}

        graph_builder = StateGraph(MessagesState)
        graph_builder.add_node("model", call_model)
        graph_builder.add_edge(START, "model")
        graph = graph_builder.compile()

        chunks = []
        async for part in graph.astream(
            {"messages": [HumanMessage(content="hi")]},
            stream_mode=["updates", "messages"],
            version="v2",
        ):
            if part["type"] == "messages":
                chunks.append(part["data"][0])

        assert [chunk.content for chunk in chunks if chunk.content] == ["hello"]
        assert sum(bool(chunk.usage_metadata) for chunk in chunks) == 1
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_failure_after_visible_output_is_outcome_unknown(tmp_path: Path) -> None:
    store, run = await _store_and_run(tmp_path)
    try:
        model = LedgerChatModel(
            delegate=_StreamingModel(fail_after_output=True),
            store=store,
            run_id=str(run["id"]),
            execution_attempt_id="job-1:1",
            model_name="local:test:model",
            max_calls=2,
            profile={"max_input_tokens": 8_192},
        )

        with pytest.raises(TimeoutError):
            _ = [chunk async for chunk in model.astream([HumanMessage(content="hi")])]

        usage = await store.model_usage_summary(str(run["id"]))
        assert usage["outcome_unknown_calls"] == 1
        assert usage["model_calls"] == 1
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_model_budget_is_reserved_durably_across_attempts(tmp_path: Path) -> None:
    store, run = await _store_and_run(tmp_path)
    try:
        first = LedgerChatModel(
            delegate=_StreamingModel(),
            store=store,
            run_id=str(run["id"]),
            execution_attempt_id="job-1:1",
            model_name="local:test:model",
            max_calls=1,
            profile={"max_input_tokens": 8_192},
        )
        _ = [chunk async for chunk in first.astream([HumanMessage(content="hi")])]

        resumed = first.model_copy(update={"execution_attempt_id": "job-2:1"})
        with pytest.raises(ModelCallBudgetExceeded):
            _ = [chunk async for chunk in resumed.astream([HumanMessage(content="again")])]
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_declared_tiny_context_fails_before_provider_call(tmp_path: Path) -> None:
    store, run = await _store_and_run(tmp_path)
    try:
        model = LedgerChatModel(
            delegate=_StreamingModel(),
            store=store,
            run_id=str(run["id"]),
            execution_attempt_id="job-1:1",
            model_name="local:test:tiny",
            max_calls=2,
            profile={"max_input_tokens": 100},
        )

        with pytest.raises(ModelContextBudgetExceeded, match="insufficient context"):
            _ = [chunk async for chunk in model.astream([HumanMessage(content="hello")])]

        assert await store.model_usage_summary(str(run["id"])) == {
            "input_tokens": 0,
            "output_tokens": 0,
            "unmetered_calls": 0,
            "outcome_unknown_calls": 0,
            "model_calls": 0,
        }
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_provider_boundary_filters_office_schema_for_plain_subagent_task(
    tmp_path: Path,
) -> None:
    store, run = await _store_and_run(tmp_path)
    try:
        unbound = LedgerChatModel(
            delegate=_BindableStreamingModel(),
            store=store,
            run_id=str(run["id"]),
            execution_attempt_id="job-1:1",
            model_name="local:test:small",
            max_calls=2,
            profile={"max_input_tokens": 8_192},
        )
        model = unbound.bind_tools([_office_read, _workspace_read])
        assert isinstance(model, LedgerChatModel)

        provider_model, schema_tokens, aliases = model._provider_model(
            [HumanMessage(content="Review this Python function and report the bug.")]
        )

        assert isinstance(provider_model, _BindableStreamingModel)
        assert len(provider_model.bound_tool_names) == 1
        assert aliases[provider_model.bound_tool_names[0]] == "workspace.read"
        assert schema_tokens < model.tool_schema_tokens
        model._bounded_messages(
            [HumanMessage(content="Review this Python function and report the bug.")],
            tool_schema_tokens=schema_tokens,
        )
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_provider_boundary_aliases_and_restores_dotted_tool_names(tmp_path: Path) -> None:
    store, run = await _store_and_run(tmp_path)
    try:
        model = LedgerChatModel(
            delegate=_StrictToolStreamingModel(),
            store=store,
            run_id=str(run["id"]),
            execution_attempt_id="job-1:1",
            model_name="local:test:strict-tools",
            max_calls=2,
            profile={"max_input_tokens": 8_192},
        ).bind_tools([_workspace_read])

        chunks = [chunk async for chunk in model.astream([HumanMessage(content="read it")])]

        assert chunks[0].tool_call_chunks[0]["name"] == "workspace.read"
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_second_store_open_does_not_mutate_active_receipt(tmp_path: Path) -> None:
    db_path = tmp_path / "runtime.db"
    store, run = await _store_and_run(tmp_path)
    await store.reserve_model_call(
        run_id=str(run["id"]),
        execution_attempt_id="job-1:1",
        model="local:test:model",
        max_calls=2,
    )
    await store.close()

    reopened = await LocalStore.open(db_path)
    try:
        usage = await reopened.model_usage_summary(str(run["id"]))
        assert usage["outcome_unknown_calls"] == 0
        assert usage["model_calls"] == 1
    finally:
        await reopened.close()


@pytest.mark.asyncio
async def test_expired_lease_marks_open_receipt_outcome_unknown(tmp_path: Path) -> None:
    store, run = await _store_and_run(tmp_path)
    run_id = str(run["id"])
    try:
        job = await store.enqueue_run_job(run_id, kind="start")
        assert job is not None
        leased = await store.claim_run_job(worker_id="worker-1", lease_seconds=-1)
        assert leased is not None
        attempt_id = f"{leased['id']}:{leased['lease_generation']}"
        await store.reserve_model_call(
            run_id=run_id,
            execution_attempt_id=attempt_id,
            model="local:test:model",
            max_calls=2,
        )

        assert await store.claim_run_job(worker_id="worker-2") is None

        usage = await store.model_usage_summary(run_id)
        assert usage["outcome_unknown_calls"] == 1
        quarantined = await store.get_run_job(str(leased["id"]))
        assert quarantined is not None
        assert quarantined["status"] == "leased"
        assert quarantined["quarantined_at"] is not None
        saved_run = await store.get_run(run_id)
        assert saved_run is not None and saved_run["status"] == "cleanup_required"
    finally:
        await store.close()


def test_context_envelope_bounds_single_oversized_message_with_explicit_marker() -> None:
    messages = [HumanMessage(content="A" * 900_000)]

    bounded = _enforce_context_envelope(messages, max_tokens=8_000)

    assert _conservative_token_count(bounded) <= 8_000
    joined = "\n".join(str(message.content) for message in bounded)
    assert "Runtime truncated" in joined or "Runtime context envelope" in joined


def test_context_envelope_bounds_large_history_for_summary_calls() -> None:
    messages = [HumanMessage(content=f"turn-{index}:" + ("x" * 20_000)) for index in range(80)]

    bounded = _enforce_context_envelope(messages, max_tokens=32_000)

    assert _conservative_token_count(bounded) <= 32_000
    assert any("Runtime context envelope" in str(message.content) for message in bounded)
    assert "turn-79" in str(bounded[-1].content)


def test_context_envelope_uses_conservative_count_for_chinese() -> None:
    messages = [HumanMessage(content="中" * 30_000)]

    bounded = _enforce_context_envelope(messages, max_tokens=8_000)

    assert _conservative_token_count(bounded) <= 8_000
    assert "Runtime truncated" in str(bounded[0].content)
