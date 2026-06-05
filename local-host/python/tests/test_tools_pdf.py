"""Contract tests for the pdf.inspect tool — cloud Tool Gateway proxy.

Mirrors the test_tools_code.py pattern: invoke the internal helper
(`_pdf_inspect_impl`) directly so we don't have to construct a full
LangChain ToolCall envelope. The @tool wrapper is a thin shim over
this helper — its only extra responsibility is pulling run_id out
of RunnableConfig, which the call_tool_gateway tests already
cover via test_web_search_tool.py.

What we pin:

  1. Successful "info" call produces the expected outbound HTTP
     body (tool + arguments + run_id + idempotency).
  2. Successful "search" call passes the query through.
  3. Missing document_id → recoverable error before any HTTP.
  4. Unknown operation → recoverable error before any HTTP.
  5. Operation=search with whitespace-only query → recoverable
     error before any HTTP.
  6. No conversation context (empty run_id) → clear unrecoverable
     error before any HTTP.
  7. Unpaired daemon (no cloud token) inherits the standard
     `cloud_session_missing` envelope from call_tool_gateway.
"""

from __future__ import annotations

import json

import httpx
import pytest

from local_host.config import reset_settings_for_tests
from local_host.tools import _gateway as gateway_module
from local_host.tools import pdf as pdf_module


def _patch_httpx(monkeypatch, handler) -> list[httpx.Request]:
    """Same MockTransport shim used by the code/web/image gateway tests."""
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
def settings_with_session():
    return reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://api.test",
        SHEJANE_CLOUD_TOKEN="cloud-jwt",
    )


@pytest.fixture
def settings_unpaired():
    return reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://api.test",
        SHEJANE_CLOUD_TOKEN="",
    )


@pytest.mark.asyncio
async def test_info_proxies_to_gateway(monkeypatch, settings_with_session) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "code": 0,
                "message": "ok",
                "data": {
                    "ok": True,
                    "content": "Info for paper.pdf: 12 page(s).",
                    "data": {"metadata": {"pages": 12, "title": "Paper"}},
                },
            },
        )

    recorded = _patch_httpx(monkeypatch, handler)
    result = await pdf_module._pdf_inspect_impl(
        document_id="doc_abc",
        operation="info",
        query=None,
        tool_call_id="call_1",
        run_id="run_xyz",
    )

    assert result["ok"] is True
    assert "12 page" in result["content"]
    assert result["data"]["metadata"]["pages"] == 12

    assert len(recorded) == 1
    req = recorded[0]
    assert req.method == "POST"
    assert str(req.url) == "http://api.test/api/v1/agent/tools/execute"
    assert req.headers["authorization"] == "Bearer cloud-jwt"
    body = json.loads(req.content)
    assert body["tool"] == "pdf.inspect"
    assert body["arguments"]["document_id"] == "doc_abc"
    assert body["arguments"]["operation"] == "info"
    assert "query" not in body["arguments"]  # info doesn't need a query
    assert body["run_id"] == "run_xyz"
    assert body["tool_call_id"] == "call_1"
    assert body["idempotency_key"] == "call_1"


@pytest.mark.asyncio
async def test_search_passes_query(monkeypatch, settings_with_session) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "code": 0,
                "message": "ok",
                "data": {
                    "ok": True,
                    "content": "Found 3 match(es) for 'attention'.",
                    "data": {
                        "matches": [{"page": 1, "snippet": "We propose a new attention…"}],
                        "query": "attention",
                    },
                },
            },
        )

    recorded = _patch_httpx(monkeypatch, handler)
    result = await pdf_module._pdf_inspect_impl(
        document_id="doc_abc",
        operation="search",
        query="attention",
        tool_call_id="call_2",
        run_id="run_xyz",
    )
    assert result["ok"] is True
    body = json.loads(recorded[0].content)
    assert body["arguments"]["operation"] == "search"
    assert body["arguments"]["query"] == "attention"


@pytest.mark.asyncio
async def test_rejects_missing_document_id() -> None:
    result = await pdf_module._pdf_inspect_impl(
        document_id="  ",
        operation="info",
        query=None,
        tool_call_id="call_3",
        run_id="run_xyz",
    )
    assert result["ok"] is False
    assert result["errorCode"] == "missing_document_id"
    assert result["recoverable"] is True


@pytest.mark.asyncio
async def test_rejects_unknown_operation() -> None:
    result = await pdf_module._pdf_inspect_impl(
        document_id="doc_abc",
        operation="rasterize_page",  # not in v1
        query=None,
        tool_call_id="call_4",
        run_id="run_xyz",
    )
    assert result["ok"] is False
    assert result["errorCode"] == "unknown_operation"


@pytest.mark.asyncio
async def test_search_requires_query() -> None:
    result = await pdf_module._pdf_inspect_impl(
        document_id="doc_abc",
        operation="search",
        query="  ",  # whitespace only
        tool_call_id="call_5",
        run_id="run_xyz",
    )
    assert result["ok"] is False
    assert result["errorCode"] == "missing_query"


@pytest.mark.asyncio
async def test_no_conversation_context_is_a_clear_error() -> None:
    result = await pdf_module._pdf_inspect_impl(
        document_id="doc_abc",
        operation="info",
        query=None,
        tool_call_id="call_6",
        run_id="",  # no thread_id
    )
    assert result["ok"] is False
    assert result["errorCode"] == "no_conversation_context"
    assert result["recoverable"] is False


@pytest.mark.asyncio
async def test_unpaired_returns_cloud_session_missing(settings_unpaired) -> None:
    # No cloud token → call_tool_gateway short-circuits without a
    # network call. Confirms pdf.inspect inherits the standard
    # unpaired-daemon UX from the shared gateway helper.
    result = await pdf_module._pdf_inspect_impl(
        document_id="doc_abc",
        operation="info",
        query=None,
        tool_call_id="call_7",
        run_id="run_xyz",
    )
    assert result["ok"] is False
    assert result["errorCode"] == "cloud_session_missing"


def test_registry_includes_pdf_inspect() -> None:
    # Smoke check: pdf.inspect is in the always-on core toolset
    # (no gate flag — gateway re-checks document ownership).
    from local_host.tools.registry import core_tools

    tools = core_tools()
    names = {t.name for t in tools}
    assert "pdf.inspect" in names
