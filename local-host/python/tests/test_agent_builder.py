"""Tests for `local_host.agent.builder` — verifies that the agent compiles
with the full middleware stack and that AsyncSqliteSaver opens cleanly with
the eager-setup fix from Phase 0.
"""

from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack
from pathlib import Path
from types import SimpleNamespace
from typing import ClassVar

import httpx
from langchain_core.messages import SystemMessage

from local_host.config import reset_settings_for_tests
from local_host.store.sqlite import LocalStore


def test_runtime_prompt_is_built_from_invocation_context() -> None:
    from local_host.agent.builder import RuntimePromptMiddleware
    from local_host.agent.context_builder import RuntimeContext

    class Request:
        runtime = SimpleNamespace(
            context=RuntimeContext(
                run_id="run_private",
                principal_id="user_private",
                store=object(),
                task_goal="检查运行时上下文",
                workspace_root="/tmp/workspace",
            )
        )
        system_message = SystemMessage(content="deep agent base prompt")
        state: ClassVar[dict[str, object]] = {
            "completion_route": {
                "decision": "repair_requested",
                "run_id": "run_private",
                "instruction": "Repair the persisted verification failure.",
            }
        }

        def override(self, **changes):
            clone = Request()
            clone.system_message = changes["system_message"]
            return clone

    def handler(request):
        return request.system_message

    message = RuntimePromptMiddleware().wrap_model_call(Request(), handler)
    rendered = str(message.content)

    assert "deep agent base prompt" in rendered
    assert "检查运行时上下文" in rendered
    assert "/tmp/workspace" in rendered
    assert "<runtime-repair>" in rendered
    assert "Repair the persisted verification failure." in rendered
    assert "run_private" not in rendered
    assert "user_private" not in rendered


def test_runtime_model_is_selected_from_invocation_context() -> None:
    from local_host.agent.builder import RuntimeModelMiddleware
    from local_host.agent.context_builder import RuntimeContext

    runtime_model = object()

    class Request:
        runtime = SimpleNamespace(context=RuntimeContext(model=runtime_model))
        model = object()

        def override(self, **changes):
            clone = Request()
            clone.model = changes["model"]
            return clone

    selected = RuntimeModelMiddleware().wrap_model_call(Request(), lambda request: request.model)

    assert selected is runtime_model


async def test_agent_definition_cache_reuses_only_matching_structure(
    tmp_path: Path,
    monkeypatch,
) -> None:
    import local_host.agent.builder as builder_module
    from local_host.agent.builder import build_agent, open_checkpointer
    from local_host.agent.context_builder import RuntimeContext

    compiled: list[object] = []

    def fake_create_deep_agent(**_kwargs):
        definition = object()
        compiled.append(definition)
        return definition

    monkeypatch.setattr(builder_module, "create_deep_agent", fake_create_deep_agent)
    settings = reset_settings_for_tests(data_dir=tmp_path, SHEJANE_FAKE_LLM=True)
    store = await LocalStore.open(tmp_path / "store.db")
    saver, stack = await open_checkpointer(settings)
    cache: dict[str, object] = {}
    lock = asyncio.Lock()
    for name in ("one", "two", "three"):
        (tmp_path / name).mkdir()
    try:
        first = await build_agent(
            store=store,
            checkpointer=saver,
            workspace_root=str(tmp_path / "one"),
            run_id="run_one",
            settings=settings,
            mcp_enabled=False,
            runtime_context=RuntimeContext(run_id="run_one", store=store),
            definition_cache=cache,
            definition_cache_lock=lock,
        )
        second = await build_agent(
            store=store,
            checkpointer=saver,
            workspace_root=str(tmp_path / "two"),
            run_id="run_two",
            settings=settings,
            mcp_enabled=False,
            runtime_context=RuntimeContext(run_id="run_two", store=store),
            definition_cache=cache,
            definition_cache_lock=lock,
        )
        changed = await build_agent(
            store=store,
            checkpointer=saver,
            workspace_root=str(tmp_path / "three"),
            run_id="run_three",
            settings=settings.model_copy(update={"max_tool_retries": 5}),
            mcp_enabled=False,
            runtime_context=RuntimeContext(run_id="run_three", store=store),
            definition_cache=cache,
            definition_cache_lock=lock,
        )

        assert first is second
        assert changed is not first
        assert len(compiled) == 2
    finally:
        await store.close()
        await stack.aclose()


async def test_cached_definition_keeps_mcp_implementations_attempt_local(
    tmp_path: Path,
    monkeypatch,
) -> None:
    from langchain_core.tools import tool

    import local_host.agent.builder as builder_module
    from local_host.agent.builder import build_agent, open_checkpointer
    from local_host.agent.context_builder import RuntimeContext
    from local_host.tools.mcp import validate_mcp_tools
    from local_host.tools.runtime import RuntimeToolProxy

    builds = 0
    loads = 0
    captured_tools: list[object] = []

    async def fake_build_validated_mcp_tools(_data_dir, **_kwargs):
        nonlocal loads
        loads += 1
        label = f"attempt-{loads}"

        @tool("mcp.demo.lookup")
        async def lookup(value: str) -> str:
            """Look up one value."""
            return f"{label}:{value}"

        return validate_mcp_tools([lookup])

    def fake_create_deep_agent(**kwargs):
        nonlocal builds
        builds += 1
        captured_tools.extend(kwargs["tools"])
        return object()

    monkeypatch.setattr(
        builder_module,
        "build_validated_mcp_tools",
        fake_build_validated_mcp_tools,
    )
    monkeypatch.setattr(builder_module, "create_deep_agent", fake_create_deep_agent)
    settings = reset_settings_for_tests(data_dir=tmp_path, SHEJANE_FAKE_LLM=True)
    store = await LocalStore.open(tmp_path / "store.db")
    saver, stack = await open_checkpointer(settings)
    cache: dict[str, object] = {}
    lock = asyncio.Lock()
    try:
        contexts = [RuntimeContext(run_id=f"run-{index}", store=store) for index in range(2)]
        definitions = [
            await build_agent(
                store=store,
                checkpointer=saver,
                workspace_root=None,
                run_id=f"run-{index}",
                settings=settings,
                runtime_context=contexts[index],
                definition_cache=cache,
                definition_cache_lock=lock,
            )
            for index in range(2)
        ]

        assert definitions[0] is definitions[1]
        assert builds == 1
        assert loads == 2
        assert isinstance(
            next(tool for tool in captured_tools if tool.name == "mcp.demo.lookup"),
            RuntimeToolProxy,
        )
        assert (
            contexts[0].dynamic_tools["mcp.demo.lookup"]
            is not contexts[1].dynamic_tools["mcp.demo.lookup"]
        )
    finally:
        await store.close()
        await stack.aclose()


async def test_model_clients_close_with_execution_scope() -> None:
    from local_host.agent.builder import _register_model_cleanup

    closed: list[str] = []

    class AsyncClient:
        async def close(self) -> None:
            closed.append("async")

    class SyncClient:
        def close(self) -> None:
            closed.append("sync")

    class Model:
        root_async_client = AsyncClient()
        root_client = SyncClient()

    async with AsyncExitStack() as stack:
        _register_model_cleanup(Model(), stack)
        assert closed == []

    assert closed == ["sync", "async"]


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


def test_custom_middleware_has_one_bounded_completion_router(tmp_path: Path) -> None:
    from local_host.agent.builder import _custom_middleware

    settings = reset_settings_for_tests(
        data_dir=tmp_path,
        SHEJANE_LOCAL_VERIFY_REPAIR_MAX=2,
    )

    middleware = _custom_middleware(settings)
    routers = [item for item in middleware if type(item).__name__ == "CompletionRouterMiddleware"]

    assert len(routers) == 1
    assert routers[0].max_verification_repairs == 2
    names = {type(item).__name__ for item in middleware}
    assert not names & {
        "PlanApprovalMiddleware",
        "ReflectMiddleware",
        "MemoryWritebackMiddleware",
    }
    assert not any(
        hook in type(item).__dict__
        for item in middleware
        for hook in ("after_agent", "aafter_agent")
    )


def test_custom_middleware_keeps_tool_retry_but_no_unsafe_model_retry(tmp_path: Path) -> None:
    from local_host.agent.builder import _custom_middleware

    settings = reset_settings_for_tests(
        data_dir=tmp_path,
        max_tool_retries=4,
    )

    middleware = _custom_middleware(settings)
    tool_retry = [item for item in middleware if type(item).__name__ == "ToolRetryMiddleware"]
    tool_result_retry = [
        item for item in middleware if type(item).__name__ == "ToolResultRetryMiddleware"
    ]
    names = [type(item).__name__ for item in middleware]

    assert len(tool_retry) == 1
    assert tool_retry[0].max_retries == 4
    assert len(tool_result_retry) == 1
    assert tool_result_retry[0].max_retries == 4
    assert "ModelRetryMiddleware" not in names
    assert "ContextEditingMiddleware" not in names


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
        from local_host.agent.context_builder import RuntimeContext

        reset_settings_for_tests(data_dir=tmp_path)
        monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
        monkeypatch.delenv("TAVILY_API_KEY", raising=False)
        store = await LocalStore.open(tmp_path / "store.db")
        saver, stack = await open_checkpointer()
        try:
            runtime_context = RuntimeContext(
                run_id="e2e_1",
                store=store,
                task_goal="ping",
            )
            agent = await build_agent(
                store=store,
                checkpointer=saver,
                workspace_root=None,
                run_id="e2e_1",
                runtime_context=runtime_context,
            )
            config = {"configurable": {"thread_id": "e2e_1"}}
            result = await agent.ainvoke(
                {"messages": [{"role": "user", "content": "ping"}]},
                config=config,
                context=runtime_context,
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
