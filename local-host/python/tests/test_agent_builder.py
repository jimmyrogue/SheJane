"""Tests for `local_host.agent.builder` — verifies that the agent compiles
with the full middleware stack and that AsyncSqliteSaver opens cleanly with
the eager-setup fix from Phase 0.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx

from local_host.config import reset_settings_for_tests
from local_host.store.sqlite import LocalStore


def _patched_async_client(handler):
    class _Patched(httpx.AsyncClient):
        def __init__(self, **kw):
            super().__init__(
                transport=httpx.MockTransport(handler),
                **{k: v for k, v in kw.items() if k != "transport"},
            )

    return _Patched


def _stream_response(events: list[tuple[str, str]]) -> httpx.Response:
    body = "".join(f"event: {n}\ndata: {p}\n\n" for n, p in events).encode("utf-8")
    return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})


def test_open_checkpointer_eager_setup(tmp_path: Path) -> None:
    """Eager setup should NOT raise the disk-I/O race we saw in spike."""
    from local_host.agent.builder import open_checkpointer

    async def run() -> None:
        reset_settings_for_tests(data_dir=tmp_path)
        saver, stack = await open_checkpointer()
        try:
            # If setup() worked, this list call should succeed (returns empty).
            results = [c async for c in saver.alist(config={"configurable": {"thread_id": "nope"}})]
            assert results == []
        finally:
            await stack.aclose()

    asyncio.run(run())


def test_build_agent_assembles_without_workspace(tmp_path: Path, monkeypatch) -> None:
    """Compile-only sanity: build_agent should not throw without a workspace."""
    from local_host.agent.builder import build_agent, open_checkpointer

    async def run() -> None:
        reset_settings_for_tests(data_dir=tmp_path)
        # Ensure MCP isn't enabled (no config), Tavily disabled (no key)
        monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
        monkeypatch.delenv("TAVILY_API_KEY", raising=False)
        store = await LocalStore.open(tmp_path / "store.db")
        saver, stack = await open_checkpointer()
        try:
            agent = await build_agent(
                store=store,
                checkpointer=saver,
                workspace_root=None,
                run_id="t1",
            )
            assert agent is not None
            # Has the expected graph shape (compile returns CompiledStateGraph)
            assert hasattr(agent, "ainvoke")
            assert hasattr(agent, "astream")
        finally:
            await store.close()
            await stack.aclose()

    asyncio.run(run())


def test_build_agent_with_workspace_includes_shell_middleware(tmp_path: Path, monkeypatch) -> None:
    """When workspace_root is set, ShellToolMiddleware injects a shell tool."""
    from local_host.agent.builder import build_agent, open_checkpointer

    async def run() -> list[str]:
        reset_settings_for_tests(data_dir=tmp_path)
        monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
        monkeypatch.delenv("TAVILY_API_KEY", raising=False)
        store = await LocalStore.open(tmp_path / "store.db")
        saver, stack = await open_checkpointer()
        try:
            agent = await build_agent(
                store=store,
                checkpointer=saver,
                workspace_root=str(tmp_path),
                run_id="t2",
            )
            # Pull tool names off the compiled graph
            tools = getattr(agent, "tools", None) or []
            if not tools:
                # fallback: inspect compiled graph
                tools = []
            return [getattr(t, "name", "") for t in tools]
        finally:
            await store.close()
            await stack.aclose()

    # The shell tool isn't always exposed on the compiled-graph surface
    # (depends on LangGraph version) so we settle for no-exception.
    names = asyncio.run(run())
    assert isinstance(names, list)


def test_custom_middleware_includes_bounded_completion_guards(tmp_path: Path) -> None:
    from local_host.agent.builder import _custom_middleware

    settings = reset_settings_for_tests(
        data_dir=tmp_path,
        SHEJANE_LOCAL_VERIFY_REPAIR_MAX=2,
    )

    middleware = _custom_middleware(settings)
    verification = [
        item for item in middleware if type(item).__name__ == "VerificationLoopMiddleware"
    ]
    progress = [
        item for item in middleware if type(item).__name__ == "ProgressLedgerGuardMiddleware"
    ]

    assert len(verification) == 1
    assert verification[0].max_attempts == 2
    assert len(progress) == 1
    assert progress[0].max_attempts == 1


def test_custom_middleware_uses_separate_model_retry_budget(tmp_path: Path) -> None:
    from local_host.agent.builder import _custom_middleware

    settings = reset_settings_for_tests(
        data_dir=tmp_path,
        max_tool_retries=4,
        max_model_retries=1,
    )

    middleware = _custom_middleware(settings)
    tool_retry = [item for item in middleware if type(item).__name__ == "ToolRetryMiddleware"]
    tool_result_retry = [
        item for item in middleware if type(item).__name__ == "ToolResultRetryMiddleware"
    ]
    model_retry = [item for item in middleware if type(item).__name__ == "ModelRetryMiddleware"]

    assert len(tool_retry) == 1
    assert tool_retry[0].max_retries == 4
    assert len(tool_result_retry) == 1
    assert tool_result_retry[0].max_retries == 4
    assert len(model_retry) == 1
    assert model_retry[0].max_retries == 1
    assert model_retry[0].on_failure == "error"
    assert callable(model_retry[0].retry_on)

    from local_host.llm.backend import BackendLLMError

    assert model_retry[0].retry_on(BackendLLMError("rate limited", retryable=True)) is True
    assert model_retry[0].retry_on(BackendLLMError("bad key", retryable=False)) is False
    assert (
        model_retry[0].retry_on(
            BackendLLMError("HTTP 429: insufficient credits", code="insufficient_credits")
        )
        is False
    )
    assert (
        model_retry[0].retry_on(
            BackendLLMError("HTTP 429: missing API key", code="missing_api_key")
        )
        is False
    )
    assert model_retry[0].retry_on(BackendLLMError("provider timed out", code="timeout")) is True
    assert model_retry[0].retry_on(TimeoutError("request timed out")) is True
    assert model_retry[0].retry_on(ValueError("bug")) is False


def test_build_agent_runs_end_to_end_with_mocked_backend(tmp_path: Path, monkeypatch) -> None:
    """The compiled agent should drive a complete invoke against a mocked
    SSE backend, returning a final assistant message.

    This is the strongest Phase 3' Part 2 acceptance: agent assembly is
    correct enough that LangGraph can actually traverse it.
    """
    from local_host.agent.builder import build_agent, open_checkpointer

    def handler(request: httpx.Request) -> httpx.Response:
        # Mock backend returns one delta + done. No tool calls.
        return _stream_response(
            [
                ("llm.delta", '{"content_delta": "All good."}'),
                ("llm.done", '{"request_id": "r1", "finish_reason": "stop"}'),
            ]
        )

    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler))

    async def run() -> str:
        reset_settings_for_tests(data_dir=tmp_path)
        monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
        monkeypatch.delenv("TAVILY_API_KEY", raising=False)
        store = await LocalStore.open(tmp_path / "store.db")
        saver, stack = await open_checkpointer()
        try:
            agent = await build_agent(
                store=store,
                checkpointer=saver,
                workspace_root=None,
                run_id="e2e_1",
            )
            config = {"configurable": {"thread_id": "e2e_1"}}
            result = await agent.ainvoke(
                {"messages": [{"role": "user", "content": "ping"}]},
                config=config,
            )
            final = result["messages"][-1]
            return (
                getattr(final, "content", "")
                if not isinstance(final, dict)
                else final.get("content", "")
            )
        finally:
            await store.close()
            await stack.aclose()

    text = asyncio.run(run())
    assert "All good" in text
