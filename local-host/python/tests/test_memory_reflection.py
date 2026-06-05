"""Tests for the post-fix wiring: agent_store flows through, memory= path
flows through, critic mode is opt-in.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from langgraph.store.memory import InMemoryStore

from local_host.config import reset_settings_for_tests

# --- open_store / open_checkpointer integration ---


def test_open_store_creates_async_sqlite_store(tmp_path: Path) -> None:
    from local_host.agent.builder import open_store

    async def run() -> None:
        reset_settings_for_tests(data_dir=tmp_path)
        store, stack = await open_store()
        try:
            ns = ("notes", "global")
            await store.aput(ns, "k1", {"text": "hello"})
            items = await store.asearch(ns)
            keys = [item.key for item in items]
            assert "k1" in keys
        finally:
            await stack.aclose()

    asyncio.run(run())


# --- memory_sources parser ---


def test_resolve_memory_sources_empty_returns_none() -> None:
    from local_host.agent.builder import _resolve_memory_sources
    from local_host.config import Settings

    s = Settings(SHEJANE_LOCAL_MEMORY_PATHS="")
    assert _resolve_memory_sources(s) is None


def test_resolve_memory_sources_splits_and_expands(monkeypatch) -> None:
    from local_host.agent.builder import _resolve_memory_sources
    from local_host.config import Settings

    monkeypatch.setenv("HOME", "/home/test")
    s = Settings(SHEJANE_LOCAL_MEMORY_PATHS="~/a.md,/abs/b.md, /spaced/c.md ")
    out = _resolve_memory_sources(s)
    assert out is not None
    # Order preserved, ~ expanded, whitespace trimmed
    assert out == ["/home/test/a.md", "/abs/b.md", "/spaced/c.md"]


# --- agent_store flows from build_agent to runtime ---


def test_build_agent_accepts_agent_store(tmp_path: Path, monkeypatch) -> None:
    from local_host.agent.builder import build_agent, open_checkpointer
    from local_host.store.sqlite import LocalStore

    async def run() -> bool:
        reset_settings_for_tests(data_dir=tmp_path)
        monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
        monkeypatch.delenv("TAVILY_API_KEY", raising=False)
        store = await LocalStore.open(tmp_path / "store.db")
        saver, stack = await open_checkpointer()
        agent_store = InMemoryStore()
        try:
            agent = await build_agent(
                store=store,
                checkpointer=saver,
                agent_store=agent_store,
                workspace_root=str(tmp_path),
                run_id="t-store-1",
            )
            # Compiled agent should expose the store on its config or
            # state. Easiest check: it has the standard ainvoke method
            # (no exception during compile is the main signal).
            return hasattr(agent, "ainvoke")
        finally:
            await store.close()
            await stack.aclose()

    assert asyncio.run(run()) is True


# --- reflect critic mode (opt-in via env) ---


def test_reflect_returns_stats_when_critic_disabled(monkeypatch) -> None:
    import asyncio as _a

    from langchain_core.messages import AIMessage, HumanMessage

    from local_host.middleware.reflect import ReflectMiddleware

    monkeypatch.delenv("SHEJANE_LOCAL_CRITIC", raising=False)
    mw = ReflectMiddleware()
    state = {
        "messages": [
            HumanMessage(content="task"),
            AIMessage(content="final answer here"),
        ]
    }
    # Sync path is unconditional stats
    sync_result = mw.after_agent(state, runtime=None)
    assert sync_result["reflection"]["ai_messages"] == 1
    assert "critic" not in sync_result["reflection"]

    # Async path also stats-only when env unset
    async_result = _a.run(mw.aafter_agent(state, runtime=None))
    assert "critic" not in async_result["reflection"]


def test_reflect_runs_critic_when_env_enabled(monkeypatch) -> None:
    import asyncio as _a
    from types import SimpleNamespace

    from langchain_core.messages import AIMessage, HumanMessage

    from local_host.middleware.reflect import ReflectMiddleware

    monkeypatch.setenv("SHEJANE_LOCAL_CRITIC", "1")

    class FakeCriticModel:
        last_messages = None

        async def ainvoke(self, msgs):
            FakeCriticModel.last_messages = msgs
            return SimpleNamespace(
                content='{"coverage": 4, "clarity": 5, "grounding": 3, "notes": ["cite sources"]}'
            )

    mw = ReflectMiddleware(critic_model=FakeCriticModel())
    state = {
        "messages": [
            HumanMessage(content="explain X"),
            AIMessage(content="X is ..."),
        ]
    }
    result = _a.run(mw.aafter_agent(state, runtime=None))
    critic = result["reflection"]["critic"]
    assert critic["coverage"] == 4
    assert critic["clarity"] == 5
    assert "cite sources" in critic["notes"]
    # The critic prompt was actually invoked
    assert FakeCriticModel.last_messages is not None


# --- memory.search tool ---


def test_memory_search_returns_error_without_store() -> None:
    import asyncio as _a

    from local_host.tools.memory import memory_search

    # ainvoke without store binding ⇒ permissive default returns error.
    result = _a.run(memory_search.ainvoke({"query": "x"}))
    assert result["ok"] == "false"
    assert "not configured" in result["error"]


def test_memory_search_finds_writeback_entries() -> None:
    """End-to-end: MemoryWritebackMiddleware writes a note, memory.search
    finds it via the same BaseStore."""
    import asyncio as _a

    from local_host.tools.memory import NAMESPACE, memory_search

    store = InMemoryStore()

    async def run() -> dict:
        # Simulate a writeback from a past run.
        await store.aput(
            NAMESPACE,
            "past-run-1",
            {"goal": "find react docs", "answer": "see https://react.dev"},
        )
        await store.aput(
            NAMESPACE,
            "past-run-2",
            {"goal": "tally Q4 expenses", "answer": "USD 12,340"},
        )
        # Now the agent calls memory.search at runtime.
        return await memory_search.ainvoke({"query": "react", "limit": 5, "store": store})

    result = _a.run(run())
    assert result["ok"] == "true"
    # Either both notes come back (no embedding → list-all) or react one
    # ranks first. Either way: react note is present.
    serialized = str(result["results"])
    assert "react" in serialized.lower()


def test_memory_search_respects_limit() -> None:
    import asyncio as _a

    from local_host.tools.memory import NAMESPACE, memory_search

    store = InMemoryStore()

    async def run() -> dict:
        for i in range(10):
            await store.aput(NAMESPACE, f"k{i}", {"text": f"note {i}"})
        return await memory_search.ainvoke({"query": "note", "limit": 3, "store": store})

    result = _a.run(run())
    assert result["ok"] == "true"
    assert len(result["results"]) <= 3


# --- MemoryWritebackMiddleware: enabled flag gates persistence ---


def test_memory_writeback_skips_when_disabled() -> None:
    """`MemoryWritebackMiddleware(enabled=False)` must NOT call `store.aput`,
    even though the store is wired up. Gate is the user's "memory: off"
    setting flowing in from the renderer."""
    import asyncio as _a

    from langchain_core.messages import AIMessage, HumanMessage

    from local_host.middleware.memory_writeback import MemoryWritebackMiddleware

    class RecordingStore:
        def __init__(self) -> None:
            self.put_calls: list[tuple] = []

        async def aput(self, namespace, key, value) -> None:
            self.put_calls.append((namespace, key, value))

    store = RecordingStore()

    class _Runtime:
        def __init__(self, s) -> None:
            self.store = s

    mw = MemoryWritebackMiddleware(enabled=False)
    state = {
        "messages": [
            HumanMessage(content="goal"),
            AIMessage(content="answer"),
        ]
    }
    _a.run(mw.aafter_agent(state, runtime=_Runtime(store)))
    assert store.put_calls == []


def test_memory_writeback_persists_when_enabled() -> None:
    """Default `enabled=True` preserves the original persistence behavior."""
    from langchain_core.messages import AIMessage, HumanMessage

    from local_host.middleware.memory_writeback import NAMESPACE, MemoryWritebackMiddleware

    store = InMemoryStore()

    class _Runtime:
        def __init__(self, s) -> None:
            self.store = s

    mw = MemoryWritebackMiddleware()  # default enabled=True
    state = {
        "messages": [
            HumanMessage(content="research react routing"),
            AIMessage(content="see react-router docs"),
        ]
    }

    async def run() -> list:
        await mw.aafter_agent(state, runtime=_Runtime(store))
        return list(await store.asearch(NAMESPACE))

    items = asyncio.run(run())
    assert len(items) == 1
    note = items[0].value
    assert "react routing" in note["goal"]
    assert "react-router" in note["answer"]


# --- build_agent: tool gating on memory_enabled ---


def test_build_agent_excludes_memory_search_when_disabled(tmp_path: Path, monkeypatch) -> None:
    """`memory_enabled=False` should drop `memory.search` from the tool
    set handed to `create_deep_agent`, so the model can't even attempt
    to recall. We spy on the `tools=` kwarg rather than introspecting
    the compiled LangGraph — the latter wraps tools in opaque nodes
    that aren't worth our test pinning."""
    import local_host.agent.builder as builder_mod
    from local_host.agent.builder import build_agent, open_checkpointer
    from local_host.store.sqlite import LocalStore

    captured: dict[str, list[str]] = {}

    def fake_create_deep_agent(**kwargs):
        captured["tool_names"] = [t.name for t in kwargs.get("tools", [])]
        return object()  # only the tools list matters here

    monkeypatch.setattr(builder_mod, "create_deep_agent", fake_create_deep_agent)

    async def run(memory_enabled: bool) -> list[str]:
        reset_settings_for_tests(data_dir=tmp_path)
        monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
        monkeypatch.delenv("TAVILY_API_KEY", raising=False)
        store = await LocalStore.open(tmp_path / "store.db")
        saver, stack = await open_checkpointer()
        try:
            await build_agent(
                store=store,
                checkpointer=saver,
                agent_store=InMemoryStore(),
                workspace_root=str(tmp_path),
                run_id=f"r-{memory_enabled}",
                memory_enabled=memory_enabled,
            )
            return list(captured["tool_names"])
        finally:
            await store.close()
            await stack.aclose()

    on_names = asyncio.run(run(memory_enabled=True))
    off_names = asyncio.run(run(memory_enabled=False))
    assert "memory.search" in on_names, "memory.search must be present when memory_enabled=True"
    assert "memory.search" not in off_names, (
        "memory.search must be excluded when memory_enabled=False"
    )


def test_reflect_critic_swallows_errors(monkeypatch) -> None:
    import asyncio as _a

    from langchain_core.messages import AIMessage, HumanMessage

    from local_host.middleware.reflect import ReflectMiddleware

    monkeypatch.setenv("SHEJANE_LOCAL_CRITIC", "1")

    class BrokenModel:
        async def ainvoke(self, msgs):
            raise RuntimeError("rate limit")

    mw = ReflectMiddleware(critic_model=BrokenModel())
    state = {
        "messages": [
            HumanMessage(content="explain"),
            AIMessage(content="something"),
        ]
    }
    # Should not raise even though critic call fails
    result = _a.run(mw.aafter_agent(state, runtime=None))
    assert "critic" not in result["reflection"]
