"""Contract tests for the web.search tool — cloud Tool Gateway proxy.

Same architecture as image.* (`tests/test_image_tool.py`): the Tavily
key lives in the API's env, never in the daemon's. The daemon's
`web.search` tool POSTs to `/api/v1/agent/tools/execute` with
`tool="web.search"` and unwraps the `apiResponse<agentToolExecuteResult>`
envelope. We pin:

  1. Outbound HTTP shape matches the shared cloud tool schema artifact
     (`max_results` arg, `query` arg, idempotency key, run_id
     for billing attribution).
  2. Successful response unwraps `data` from the API envelope.
  3. Unpaired daemon returns a recoverable tool error instead of
     hard-failing.
  4. Network failure during the proxy also returns a recoverable error.
  5. `TAVILY_API_KEY` in the daemon's env does NOT cause a direct call
     to Tavily — all traffic still flows through the cloud gateway.
"""

from __future__ import annotations

import json

import httpx
import pytest

from local_host.config import reset_settings_for_tests
from local_host.tools import _gateway as gateway_module
from local_host.tools import web as web_module


def _patch_httpx(monkeypatch, handler) -> list[httpx.Request]:
    """Replace httpx.AsyncClient inside the shared gateway helper with
    a MockTransport that records every outbound request."""
    recorded: list[httpx.Request] = []

    def _capture(request: httpx.Request) -> httpx.Response:
        recorded.append(request)
        return handler(request)

    class _Patched(httpx.AsyncClient):
        def __init__(self, **kw):
            kw.pop("transport", None)
            super().__init__(transport=httpx.MockTransport(_capture), **kw)

    monkeypatch.setattr(gateway_module.httpx, "AsyncClient", _Patched)
    return recorded


@pytest.fixture
def settings_with_session(monkeypatch):
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    return reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://api.test",
        SHEJANE_CLOUD_TOKEN="cloud-jwt",
    )


@pytest.fixture
def settings_unpaired(monkeypatch):
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    return reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://api.test",
        SHEJANE_CLOUD_TOKEN="",
    )


@pytest.mark.asyncio
async def test_web_search_proxies_to_cloud_gateway(monkeypatch, settings_with_session) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "code": 0,
                "message": "ok",
                "data": {
                    "ok": True,
                    "content": "Answer: LangGraph is …\n\n1. LangGraph docs\nhttps://…\n…",
                    "data": {
                        "answer": "LangGraph is a framework for stateful agents.",
                        "results": [
                            {
                                "title": "LangGraph docs",
                                "url": "https://docs.langgraph.dev",
                                "content": "LangGraph is …",
                                "score": 0.92,
                            }
                        ],
                    },
                },
            },
        )

    recorded = _patch_httpx(monkeypatch, handler)
    result = await web_module._invoke_web_search(
        query="what is langgraph",
        max_results=5,
        run_id="run_abc",
        tool_call_id="call_1",
    )

    assert len(recorded) == 1
    req = recorded[0]
    assert req.method == "POST"
    assert str(req.url) == "http://api.test/api/v1/agent/tools/execute"
    assert req.headers["authorization"] == "Bearer cloud-jwt"
    body = json.loads(req.content)
    assert body["tool"] == "web.search"
    assert body["run_id"] == "run_abc"
    assert body["tool_call_id"] == "call_1"
    # Arguments shape mirrors the shared model-facing schema:
    # `arguments.query` + `arguments.max_results`.
    assert body["arguments"]["query"] == "what is langgraph"
    assert body["arguments"]["max_results"] == 5
    assert body["idempotency_key"] == "call_1"

    # Unwrapped result — top-level `ok` + structured `data.results`.
    assert result["ok"] is True
    assert "LangGraph" in result["content"]
    assert result["data"]["results"][0]["title"] == "LangGraph docs"


@pytest.mark.asyncio
async def test_web_search_clamps_max_results(monkeypatch, settings_with_session) -> None:
    """The cloud also clamps to [1, 10]. We mirror the bound here so a
    malformed call doesn't waste the round-trip."""

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"code": 0, "message": "ok", "data": {"ok": True, "content": "ok"}},
        )

    recorded = _patch_httpx(monkeypatch, handler)
    await web_module._invoke_web_search(query="x", max_results=99, run_id="r", tool_call_id="c1")
    assert json.loads(recorded[0].content)["arguments"]["max_results"] == 10
    await web_module._invoke_web_search(query="x", max_results=0, run_id="r", tool_call_id="c2")
    assert json.loads(recorded[1].content)["arguments"]["max_results"] == 1


@pytest.mark.asyncio
async def test_web_search_no_pairing_returns_recoverable_error(
    monkeypatch, settings_unpaired
) -> None:
    recorded = _patch_httpx(monkeypatch, lambda _r: httpx.Response(500))
    result = await web_module._invoke_web_search(
        query="x", max_results=5, run_id="r", tool_call_id="c"
    )
    assert recorded == []  # short-circuited before HTTP
    assert result["ok"] is False
    assert result["errorCode"] == "cloud_session_missing"
    assert result["recoverable"] is True


@pytest.mark.asyncio
async def test_web_search_gateway_error_surfaces(monkeypatch, settings_with_session) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "code": 40041,
                "message": "tool not configured",
                "data": {
                    "ok": False,
                    "content": "web.search is disabled because Tavily is not configured in the cloud API.",
                    "errorCode": "web_search_disabled",
                    "recoverable": False,
                },
            },
        )

    _patch_httpx(monkeypatch, handler)
    result = await web_module._invoke_web_search(
        query="x", max_results=5, run_id="r", tool_call_id="c"
    )
    assert result["ok"] is False
    assert result["errorCode"] == "web_search_disabled"


@pytest.mark.asyncio
async def test_web_search_retries_transient_gateway_transport_error(
    monkeypatch, settings_with_session
) -> None:
    attempts = 0

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(gateway_module.asyncio, "sleep", no_sleep)

    def handler(_req: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise httpx.ConnectError("connection refused")
        return httpx.Response(
            200,
            json={"code": 0, "message": "ok", "data": {"ok": True, "content": "retried ok"}},
        )

    recorded = _patch_httpx(monkeypatch, handler)
    result = await web_module._invoke_web_search(
        query="retry me",
        max_results=5,
        run_id="run_retry",
        tool_call_id="call_retry",
    )

    assert result["ok"] is True
    assert result["content"] == "retried ok"
    assert len(recorded) == 2
    bodies = [json.loads(req.content) for req in recorded]
    assert {body["tool_call_id"] for body in bodies} == {"call_retry"}
    assert {body["idempotency_key"] for body in bodies} == {"call_retry"}


@pytest.mark.asyncio
async def test_web_search_retries_unstructured_transient_gateway_response(
    monkeypatch, settings_with_session
) -> None:
    attempts = 0

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(gateway_module.asyncio, "sleep", no_sleep)

    def handler(_req: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(503, text="service warming up")
        return httpx.Response(
            200,
            json={"code": 0, "message": "ok", "data": {"ok": True, "content": "http retried ok"}},
        )

    recorded = _patch_httpx(monkeypatch, handler)
    result = await web_module._invoke_web_search(
        query="retry http",
        max_results=5,
        run_id="run_http_retry",
        tool_call_id="call_http_retry",
    )

    assert result["ok"] is True
    assert result["content"] == "http retried ok"
    assert len(recorded) == 2
    bodies = [json.loads(req.content) for req in recorded]
    assert {body["tool_call_id"] for body in bodies} == {"call_http_retry"}
    assert {body["idempotency_key"] for body in bodies} == {"call_http_retry"}


@pytest.mark.asyncio
async def test_web_search_does_not_retry_structured_provider_failure(
    monkeypatch, settings_with_session
) -> None:
    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(gateway_module.asyncio, "sleep", no_sleep)

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            502,
            json={
                "code": 50203,
                "message": "tool provider failed",
                "data": {
                    "ok": False,
                    "content": "Tavily search returned HTTP 502.",
                    "errorCode": "web_search_failed",
                    "recoverable": True,
                    "data": {"source": "cloud_tool_gateway"},
                },
            },
        )

    recorded = _patch_httpx(monkeypatch, handler)
    result = await web_module._invoke_web_search(
        query="provider failure",
        max_results=5,
        run_id="run_provider_failure",
        tool_call_id="call_provider_failure",
    )

    assert result["ok"] is False
    assert result["errorCode"] == "web_search_failed"
    assert result["retryable"] is False
    assert len(recorded) == 1


@pytest.mark.asyncio
async def test_web_search_no_tavily_key_env_used(monkeypatch, settings_with_session) -> None:
    """Regression: even if TAVILY_API_KEY is present in the daemon's
    env (it shouldn't be, but defense in depth), no direct call to
    tavily.com is made — all traffic must go through the cloud gateway."""
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-direct-leak")

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"code": 0, "message": "ok", "data": {"ok": True, "content": "ok"}},
        )

    recorded = _patch_httpx(monkeypatch, handler)
    await web_module._invoke_web_search(query="x", max_results=5, run_id="r", tool_call_id="c")
    assert len(recorded) == 1
    assert "api.tavily.com" not in str(recorded[0].url)
    assert "tavily.com" not in str(recorded[0].url)
    assert str(recorded[0].url).startswith("http://api.test/api/v1/agent/tools/execute")
    assert recorded[0].headers["authorization"] == "Bearer cloud-jwt"


@pytest.mark.asyncio
async def test_web_search_registered_in_core_tools(monkeypatch, settings_with_session) -> None:
    """The tool must be in `core_tools()` unconditionally — pre-this-fix
    the registry only added web.search if TAVILY_API_KEY was present in
    the daemon env, which is exactly the leak we're closing."""
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    from local_host.tools.registry import core_tools

    names = {t.name for t in core_tools()}
    assert "web.search" in names
    assert "web.fetch" in names
