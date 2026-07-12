"""Contract tests for `DELETE /local/v1/memory`.

Backs the "清空记忆 / Clear memory" button in the agent settings dialog.
Locks the response shape to the TypeScript `ClearMemoryResponse` aliased
in `client/src/shared/local-host/client.ts` and verifies the underlying
BaseStore is actually wiped.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from local_host.config import reset_settings_for_tests
from local_host.server import create_app


@pytest.fixture
def client(monkeypatch) -> TestClient:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-memory-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://localhost:8080",
        data_dir=tmp,
    )
    app = create_app(settings)
    with TestClient(app) as c:
        yield c


HEADERS = {"Authorization": "Bearer tok"}


def test_clear_memory_empty_returns_zero(client: TestClient) -> None:
    resp = client.delete("/local/v1/memory", headers=HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"cleared": True, "deleted_count": 0}


def test_clear_memory_requires_auth(client: TestClient) -> None:
    resp = client.delete("/local/v1/memory")
    assert resp.status_code == 401


def test_clear_memory_deletes_existing_notes(client: TestClient) -> None:
    """Seed three notes via an InMemoryStore override (avoids the
    AsyncSqliteStore-bound-to-TestClient-loop conflict that bites
    `asyncio.run()` in test code), then DELETE and verify
    `deleted_count == 3` AND the namespace is genuinely empty afterward."""
    import asyncio

    from langgraph.store.memory import InMemoryStore

    from local_host.auth import LOCAL_OWNER_PRINCIPAL_ID
    from local_host.tools.memory import memory_namespace_for_workspace

    # Swap the SQLite-backed store opened in lifespan for an in-memory
    # one — same BaseStore interface, but trivially shareable across
    # event loops.
    mem_store = InMemoryStore()
    client.app.state.agent_store = mem_store
    namespace = memory_namespace_for_workspace(None, LOCAL_OWNER_PRINCIPAL_ID)

    async def _seed() -> None:
        await mem_store.aput(namespace, "k1", {"goal": "a", "answer": "1"})
        await mem_store.aput(namespace, "k2", {"goal": "b", "answer": "2"})
        await mem_store.aput(namespace, "k3", {"goal": "c", "answer": "3"})

    asyncio.run(_seed())

    resp = client.delete("/local/v1/memory", headers=HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["cleared"] is True
    assert body["deleted_count"] == 3

    async def _remaining() -> list:
        return list(await mem_store.asearch(namespace))

    assert asyncio.run(_remaining()) == []


def test_clear_memory_deletes_all_notes_namespaces(client: TestClient) -> None:
    import asyncio

    from langgraph.store.memory import InMemoryStore

    from local_host.auth import LOCAL_OWNER_PRINCIPAL_ID
    from local_host.tools.memory import memory_namespace_for_workspace

    mem_store = InMemoryStore()
    client.app.state.agent_store = mem_store
    global_ns = memory_namespace_for_workspace(None, LOCAL_OWNER_PRINCIPAL_ID)
    workspace_ns = memory_namespace_for_workspace("/workspace", LOCAL_OWNER_PRINCIPAL_ID)
    other_owner_ns = memory_namespace_for_workspace(None, "another-principal")

    async def _seed() -> None:
        await mem_store.aput(global_ns, "global", {"goal": "global", "answer": "one"})
        await mem_store.aput(workspace_ns, "w1", {"goal": "workspace", "answer": "one"})
        await mem_store.aput(workspace_ns, "w2", {"goal": "workspace", "answer": "two"})
        await mem_store.aput(other_owner_ns, "private", {"goal": "other", "answer": "keep"})

    asyncio.run(_seed())

    resp = client.delete("/local/v1/memory", headers=HEADERS)
    assert resp.status_code == 200
    assert resp.json()["deleted_count"] == 3

    async def _remaining() -> list:
        out = []
        for namespace in await mem_store.alist_namespaces(prefix=("notes", "principal")):
            out.extend(await mem_store.asearch(namespace))
        return out

    remaining = asyncio.run(_remaining())
    assert [item.key for item in remaining] == ["private"]


def test_clear_memory_idempotent(client: TestClient) -> None:
    """Calling twice in a row must not error; second call returns 0."""
    resp1 = client.delete("/local/v1/memory", headers=HEADERS)
    resp2 = client.delete("/local/v1/memory", headers=HEADERS)
    assert resp1.status_code == 200
    assert resp2.status_code == 200
    assert resp2.json()["deleted_count"] == 0
