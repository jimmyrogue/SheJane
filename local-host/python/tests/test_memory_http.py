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
    os.environ["JIANDANLY_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.delenv("JIANDANLY_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    settings = reset_settings_for_tests(
        JIANDANLY_LOCAL_HOST_ADDR="127.0.0.1",
        JIANDANLY_LOCAL_HOST_PORT=17371,
        JIANDANLY_LOCAL_HOST_TOKEN="tok",
        JIANDANLY_CLOUD_BASE_URL="http://localhost:8080",
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

    from local_host.middleware.memory_writeback import NAMESPACE

    # Swap the SQLite-backed store opened in lifespan for an in-memory
    # one — same BaseStore interface, but trivially shareable across
    # event loops.
    mem_store = InMemoryStore()
    client.app.state.agent_store = mem_store

    async def _seed() -> None:
        await mem_store.aput(NAMESPACE, "k1", {"goal": "a", "answer": "1"})
        await mem_store.aput(NAMESPACE, "k2", {"goal": "b", "answer": "2"})
        await mem_store.aput(NAMESPACE, "k3", {"goal": "c", "answer": "3"})

    asyncio.run(_seed())

    resp = client.delete("/local/v1/memory", headers=HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["cleared"] is True
    assert body["deleted_count"] == 3

    async def _remaining() -> list:
        return list(await mem_store.asearch(NAMESPACE))

    assert asyncio.run(_remaining()) == []


def test_clear_memory_idempotent(client: TestClient) -> None:
    """Calling twice in a row must not error; second call returns 0."""
    resp1 = client.delete("/local/v1/memory", headers=HEADERS)
    resp2 = client.delete("/local/v1/memory", headers=HEADERS)
    assert resp1.status_code == 200
    assert resp2.status_code == 200
    assert resp2.json()["deleted_count"] == 0
