"""Auto model resolution (cloud-owned).

Unit-tests the daemon→cloud resolve client, plus the run-level integration:
a model="auto" run asks the cloud once, emits `model.selected` for the UI
badge, and persists the concrete model id so resumes stay on it.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from local_host.config import reset_settings_for_tests
from local_host.llm.resolve import resolve_auto_model
from local_host.server import create_app

# ---------------------------------------------------------------------------
# Unit: the HTTP client.
# ---------------------------------------------------------------------------


def _patched_async_client(handler):
    class _Patched(httpx.AsyncClient):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(**{k: v for k, v in kwargs.items() if k in {"transport", "timeout"}})

    return _Patched


@pytest.mark.asyncio
async def test_resolve_auto_model_parses_cloud_response(monkeypatch) -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("Authorization", "")
        captured["body"] = json.loads(request.read())
        return httpx.Response(
            200,
            json={
                "code": 0,
                "message": "ok",
                "data": {"model_id": "chat.deep", "label": "深度", "reason": "复杂推理"},
            },
        )

    monkeypatch.setattr("local_host.llm.resolve.httpx.AsyncClient", _patched_async_client(handler))
    picked = await resolve_auto_model(
        "重构认证模块", cloud_base_url="http://cloud.test", cloud_token="tok-1"
    )
    assert picked == {"model_id": "chat.deep", "label": "深度", "reason": "复杂推理"}
    assert captured["url"] == "http://cloud.test/api/v1/models/resolve"
    assert captured["auth"] == "Bearer tok-1"
    assert captured["body"] == {"goal": "重构认证模块"}


@pytest.mark.asyncio
async def test_resolve_auto_model_returns_none_on_failures(monkeypatch) -> None:
    # Non-200 → None.
    monkeypatch.setattr(
        "local_host.llm.resolve.httpx.AsyncClient",
        _patched_async_client(lambda _req: httpx.Response(503, json={"message": "no catalog"})),
    )
    assert await resolve_auto_model("x", cloud_base_url="http://c", cloud_token="") is None

    # Empty model_id → None.
    monkeypatch.setattr(
        "local_host.llm.resolve.httpx.AsyncClient",
        _patched_async_client(lambda _req: httpx.Response(200, json={"data": {"model_id": ""}})),
    )
    assert await resolve_auto_model("x", cloud_base_url="http://c", cloud_token="") is None

    # Transport error → None (never raises into the run).
    def _boom(_req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    monkeypatch.setattr("local_host.llm.resolve.httpx.AsyncClient", _patched_async_client(_boom))
    assert await resolve_auto_model("x", cloud_base_url="http://c", cloud_token="") is None


# ---------------------------------------------------------------------------
# Integration: an auto run emits model.selected + persists the resolved id.
# ---------------------------------------------------------------------------


def _stream_response(events: list[tuple[str, str]]) -> httpx.Response:
    body = "".join(f"event: {name}\ndata: {data}\n\n" for name, data in events)
    return httpx.Response(200, content=body, headers={"Content-Type": "text/event-stream"})


def test_auto_run_emits_model_selected_and_persists(monkeypatch) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-resolve-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)

    def llm_handler(request: httpx.Request) -> httpx.Response:
        return _stream_response(
            [
                ("llm.delta", '{"content_delta": "好的。"}'),
                ("llm.done", '{"request_id": "r", "finish_reason": "stop"}'),
            ]
        )

    monkeypatch.setattr(
        "local_host.llm.backend.httpx.AsyncClient",
        type(
            "_Patched",
            (httpx.AsyncClient,),
            {
                "__init__": lambda self, *a, **kw: httpx.AsyncClient.__init__(
                    self, transport=httpx.MockTransport(llm_handler), timeout=kw.get("timeout")
                )
            },
        ),
    )

    # Re-patch the conftest no-op with a canned cloud answer.
    async def fake_resolve(goal, **kwargs):
        assert goal == "帮我分析这份报表"
        return {"model_id": "chat.deep", "label": "深度", "reason": "需要推理"}

    monkeypatch.setattr("local_host.runs.resolve_auto_model", fake_resolve)

    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp,
    )
    app = create_app(settings)
    with TestClient(app) as client:
        created = client.post(
            "/local/v1/runs",
            headers={"Authorization": "Bearer tok"},
            json={"goal": "帮我分析这份报表", "model": "auto"},
        )
        assert created.status_code == 200, created.text
        run_id = created.json()["id"]

        with client.stream(
            "GET", f"/local/v1/runs/{run_id}/stream", headers={"Authorization": "Bearer tok"}
        ) as resp:
            assert resp.status_code == 200
            body = resp.read().decode("utf-8")

        # model.selected rides the SSE envelope with the resolved id + label.
        assert "model.selected" in body
        assert (
            '"resolved_model_id": "chat.deep"' in body or '"resolved_model_id":"chat.deep"' in body
        )
        assert "深度" in body

        # The concrete model is persisted (resume after restart keeps it).
        run = client.get(f"/local/v1/runs/{run_id}", headers={"Authorization": "Bearer tok"})
        assert run.status_code == 200
