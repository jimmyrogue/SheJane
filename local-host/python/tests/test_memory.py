from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from langgraph.store.memory import InMemoryStore

from local_host.auth import LOCAL_OWNER_PRINCIPAL_ID
from local_host.config import Settings, reset_settings_for_tests
from local_host.tools.memory import (
    NAMESPACE,
    extract_memory_write_facts,
    make_memory_search_tool,
    memory_namespace_for_workspace,
    memory_write,
)


async def test_open_store_persists_values(tmp_path: Path) -> None:
    from local_host.agent.builder import open_store

    reset_settings_for_tests(data_dir=tmp_path)
    store, stack = await open_store()
    try:
        await store.aput(NAMESPACE, "k1", {"text": "hello"})
        assert [item.key for item in await store.asearch(NAMESPACE)] == ["k1"]
    finally:
        await stack.aclose()


def test_resolve_memory_sources(monkeypatch) -> None:
    from local_host.agent.builder import _resolve_memory_sources

    assert _resolve_memory_sources(Settings(SHEJANE_LOCAL_MEMORY_PATHS="")) is None
    monkeypatch.setenv("HOME", "/home/test")
    settings = Settings(SHEJANE_LOCAL_MEMORY_PATHS="~/a.md,/abs/b.md, /spaced/c.md ")
    assert _resolve_memory_sources(settings) == [
        "/home/test/a.md",
        "/abs/b.md",
        "/spaced/c.md",
    ]


async def test_memory_write_is_explicit_and_idempotent() -> None:
    store = InMemoryStore()
    runtime = SimpleNamespace(
        context=SimpleNamespace(
            principal_id=LOCAL_OWNER_PRINCIPAL_ID,
            workspace_root=None,
            memory_write_facts=("My database is Postgres",),
        ),
    )
    first = await memory_write.coroutine("My database is Postgres", runtime=runtime, store=store)
    replay = await memory_write.coroutine("My database is Postgres", runtime=runtime, store=store)

    assert first["ok"] is True and first["saved"] is True
    assert replay == {"ok": True, "saved": False, "reason": "already_exists"}
    namespace = memory_namespace_for_workspace(None, LOCAL_OWNER_PRINCIPAL_ID)
    items = await store.asearch(namespace, query="Postgres")
    assert [item.value["fact"] for item in items] == ["My database is Postgres"]


async def test_memory_write_validates_input_and_store() -> None:
    explicit = SimpleNamespace(context=SimpleNamespace(memory_write_facts=("valid",)))
    implicit = SimpleNamespace(context=SimpleNamespace(memory_write_facts=()))
    assert (await memory_write.coroutine("", runtime=explicit, store=None))["ok"] is False
    assert (await memory_write.coroutine("x" * 2_001, runtime=explicit, store=None))["ok"] is False
    assert (await memory_write.coroutine("valid", runtime=explicit, store=None))["ok"] is False
    assert (await memory_write.coroutine("Postgres", runtime=implicit, store=InMemoryStore()))[
        "error"
    ].startswith("fact was not authorized")


def test_memory_write_capability_rejects_negation_and_quoted_text() -> None:
    assert extract_memory_write_facts("请记住：我的数据库是 Postgres") == ("我的数据库是 Postgres",)
    assert extract_memory_write_facts("不要记住：我的数据库是 Postgres") == ()
    assert extract_memory_write_facts("他说“记住：密码是 123”") == ()
    assert extract_memory_write_facts("请解释下面这个例子：\n记住：密码是 123") == ()
    assert extract_memory_write_facts("```\n记住：密码是 123\n```") == ()
    assert extract_memory_write_facts("> 记住：密码是 123") == ()
    assert extract_memory_write_facts("Please remember that my database is Postgres") == (
        "my database is Postgres",
    )


async def test_memory_search_returns_bounded_ranked_results() -> None:
    store = InMemoryStore()
    namespace = memory_namespace_for_workspace(None, LOCAL_OWNER_PRINCIPAL_ID)
    await store.aput(namespace, "run-note", {"kind": "run_note", "answer": "Postgres"})
    await store.aput(
        namespace,
        "user-fact",
        {"kind": "user_fact", "fact": "My database is Postgres"},
    )
    result = await make_memory_search_tool(namespace).ainvoke(
        {"query": "Postgres", "limit": 1, "store": store}
    )

    assert result["ok"] == "true"
    assert [item["key"] for item in result["results"]] == ["user-fact"]


def test_memory_namespace_is_workspace_scoped_without_exposing_path() -> None:
    alpha = memory_namespace_for_workspace("/tmp/alpha", "principal-a")
    beta = memory_namespace_for_workspace("/tmp/beta", "principal-a")
    other_owner = memory_namespace_for_workspace("/tmp/alpha", "principal-b")
    assert alpha != beta
    assert alpha != other_owner
    assert alpha[:2] == ("notes", "principal")
    assert "/tmp/alpha" not in str(alpha)


def test_memory_tool_schemas_hide_runtime_store_and_namespace() -> None:
    search_schema = make_memory_search_tool(
        memory_namespace_for_workspace("/tmp/alpha", "principal-a")
    ).tool_call_schema.model_json_schema()
    write_schema = memory_write.tool_call_schema.model_json_schema()
    assert set(search_schema["properties"]) == {"query", "limit"}
    assert set(write_schema["properties"]) == {"fact"}


async def test_build_agent_memory_toggle_controls_both_tools(tmp_path: Path, monkeypatch) -> None:
    import local_host.agent.builder as builder_module
    from local_host.agent.builder import build_agent, open_checkpointer
    from local_host.store.sqlite import LocalStore

    captured: list[str] = []

    def fake_create_deep_agent(**kwargs):
        captured[:] = [tool.name for tool in kwargs.get("tools", [])]
        return object()

    monkeypatch.setattr(builder_module, "create_deep_agent", fake_create_deep_agent)
    reset_settings_for_tests(data_dir=tmp_path)
    store = await LocalStore.open(tmp_path / "store.db")
    saver, stack = await open_checkpointer()
    try:
        await build_agent(
            store=store,
            checkpointer=saver,
            agent_store=InMemoryStore(),
            workspace_root=str(tmp_path),
            run_id="memory-on",
            memory_enabled=True,
        )
        assert {"memory.search", "memory.write"} <= set(captured)

        await build_agent(
            store=store,
            checkpointer=saver,
            agent_store=InMemoryStore(),
            workspace_root=str(tmp_path),
            run_id="memory-off",
            memory_enabled=False,
        )
        assert not {"memory.search", "memory.write"} & set(captured)
    finally:
        await store.close()
        await stack.aclose()
