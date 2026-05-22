"""Contract tests for the image.generate / image.edit tools.

These tools MUST proxy through the cloud Tool Gateway
(`POST /api/v1/agent/tools/execute`) — the OpenAI key lives in the
API's model registry, never in the daemon environment. The tests pin:

  1. The outgoing HTTP request shape (path, headers, body keys) the
     Go handler at `tool_gateway.go:agentToolExecute` expects.
  2. The unwrap of `apiResponse<agentToolExecuteResult>` into the
     `{ok, content, data?}` shape the LLM consumes.
  3. Graceful failure when the daemon hasn't been paired yet (no
     cloud_token) — must NOT raise; returns a recoverable tool error
     so the agent can retry after pairing.

Tests target the inner `_invoke_image_tool` directly to bypass
LangChain's ToolMessage-wrapping + InjectedToolCallId requirements —
the outer `@tool` shells just forward to it after pulling run_id from
RunnableConfig.
"""

from __future__ import annotations

import json

import httpx
import pytest

from local_host.config import reset_settings_for_tests
from local_host.tools import image as image_module


def _patch_httpx(monkeypatch, handler) -> list[httpx.Request]:
    """Replace httpx.AsyncClient inside tools.image with a MockTransport
    that records every outbound request. Returns the recording list so
    tests can assert on it.
    """
    recorded: list[httpx.Request] = []

    def _capture(request: httpx.Request) -> httpx.Response:
        recorded.append(request)
        return handler(request)

    class _Patched(httpx.AsyncClient):
        def __init__(self, **kw):
            kw.pop("transport", None)
            super().__init__(transport=httpx.MockTransport(_capture), **kw)

    monkeypatch.setattr(image_module.httpx, "AsyncClient", _Patched)
    return recorded


@pytest.fixture
def settings_with_session(monkeypatch):
    """Settings with a paired cloud session — the normal case once the
    user has logged in via the Electron app."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    return reset_settings_for_tests(
        JIANDANLY_LOCAL_HOST_TOKEN="tok",
        JIANDANLY_CLOUD_BASE_URL="http://api.test",
        JIANDANLY_CLOUD_TOKEN="cloud-jwt",
    )


@pytest.fixture
def settings_unpaired(monkeypatch):
    """Settings before the user has logged in — cloud_token is empty."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    return reset_settings_for_tests(
        JIANDANLY_LOCAL_HOST_TOKEN="tok",
        JIANDANLY_CLOUD_BASE_URL="http://api.test",
        JIANDANLY_CLOUD_TOKEN="",
    )


@pytest.mark.asyncio
async def test_image_generate_proxies_to_cloud_gateway(monkeypatch, settings_with_session) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "code": 0,
                "message": "ok",
                "data": {
                    "ok": True,
                    "content": "Generated 1 image. Saved to s3://bucket/key.png",
                    "data": {
                        "images": [{"url": "s3://bucket/key.png", "size": "1024x1024"}],
                    },
                },
            },
        )

    recorded = _patch_httpx(monkeypatch, handler)
    result = await image_module._invoke_image_tool(
        "image.generate",
        {"prompt": "a sunset", "size": "1024x1024", "n": 1},
        run_id="run_xyz",
        tool_call_id="call_abc",
    )

    # Outbound shape mirrors what tool_gateway.go:agentToolExecuteRequest
    # expects: run_id + tool_call_id + tool + arguments + idempotency_key.
    assert len(recorded) == 1
    req = recorded[0]
    assert req.method == "POST"
    assert str(req.url) == "http://api.test/api/v1/agent/tools/execute"
    assert req.headers["authorization"] == "Bearer cloud-jwt"
    body = json.loads(req.content)
    assert body["tool"] == "image.generate"
    assert body["run_id"] == "run_xyz"
    assert body["tool_call_id"] == "call_abc"
    assert body["arguments"] == {"prompt": "a sunset", "size": "1024x1024", "n": 1}
    assert body["idempotency_key"] == "call_abc"

    # Returned shape unwraps `data` from the apiResponse envelope.
    assert result["ok"] is True
    assert "Generated 1 image" in result["content"]
    assert result["data"]["images"][0]["url"] == "s3://bucket/key.png"


@pytest.mark.asyncio
async def test_image_generate_no_pairing_returns_recoverable_error(
    monkeypatch, settings_unpaired
) -> None:
    """No cloud_token → tool must NOT raise; returns a structured
    error the agent can show the user (or retry on)."""
    recorded = _patch_httpx(monkeypatch, lambda _r: httpx.Response(500))
    result = await image_module._invoke_image_tool(
        "image.generate",
        {"prompt": "x"},
        run_id="run_x",
        tool_call_id="call_x",
    )
    # No HTTP call was made — short-circuited before the gateway hit.
    assert recorded == []
    assert result["ok"] is False
    assert result["errorCode"] == "cloud_session_missing"
    assert result["recoverable"] is True
    assert "log in" in result["content"].lower()


@pytest.mark.asyncio
async def test_image_generate_gateway_error_surfaces_as_tool_error(
    monkeypatch, settings_with_session
) -> None:
    """When the gateway returns a non-OK envelope, we propagate the
    error code + message so the LLM can decide what to do next."""

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "code": 40041,
                "message": "tool not configured",
                "data": {
                    "ok": False,
                    "content": "image.generate is disabled (no provider).",
                    "errorCode": "image_disabled",
                    "recoverable": False,
                },
            },
        )

    _patch_httpx(monkeypatch, handler)
    result = await image_module._invoke_image_tool(
        "image.generate",
        {"prompt": "x"},
        run_id="run_x",
        tool_call_id="call_x",
    )
    assert result["ok"] is False
    assert result["errorCode"] == "image_disabled"
    assert "disabled" in result["content"]


@pytest.mark.asyncio
async def test_image_generate_gateway_network_error_returns_recoverable(
    monkeypatch, settings_with_session
) -> None:
    """A network failure during the proxy call must surface as a
    recoverable tool error rather than crashing the run."""

    def handler(_req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    _patch_httpx(monkeypatch, handler)
    result = await image_module._invoke_image_tool(
        "image.generate",
        {"prompt": "x"},
        run_id="run_x",
        tool_call_id="call_x",
    )
    assert result["ok"] is False
    assert result["errorCode"] == "gateway_unreachable"
    assert result["recoverable"] is True


@pytest.mark.asyncio
async def test_image_edit_forwards_document_id_path(monkeypatch, settings_with_session) -> None:
    """image.edit must pass through `document_id` (for user-uploaded
    files) AND `image_url` so the cloud API can pick whichever exists."""

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"code": 0, "message": "ok", "data": {"ok": True, "content": "ok"}},
        )

    recorded = _patch_httpx(monkeypatch, handler)
    await image_module._invoke_image_tool(
        "image.edit",
        {
            "prompt": "remove background",
            "document_id": "doc_abc",
            "image_url": "",
            "mask_url": "",
            "mask_document_id": "",
            "size": "1024x1024",
            "n": 1,
        },
        run_id="run_z",
        tool_call_id="call_z",
    )
    body = json.loads(recorded[0].content)
    assert body["tool"] == "image.edit"
    assert body["arguments"]["document_id"] == "doc_abc"
    assert body["arguments"]["prompt"] == "remove background"
    assert body["arguments"]["image_url"] == ""


@pytest.mark.asyncio
async def test_image_generate_no_openai_api_key_env_used(
    monkeypatch, settings_with_session
) -> None:
    """Regression: a hostile OPENAI_API_KEY in the daemon env must NOT
    trigger a direct OpenAI call. All image traffic flows through the
    cloud gateway."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-direct-leak")

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"code": 0, "message": "ok", "data": {"ok": True, "content": "ok"}},
        )

    recorded = _patch_httpx(monkeypatch, handler)
    await image_module._invoke_image_tool(
        "image.generate",
        {"prompt": "x"},
        run_id="run_x",
        tool_call_id="call_x",
    )
    # Single HTTP call — to the gateway, not OpenAI.
    assert len(recorded) == 1
    assert "api.openai.com" not in str(recorded[0].url)
    assert str(recorded[0].url).startswith("http://api.test/api/v1/agent/tools/execute")
    assert recorded[0].headers["authorization"] == "Bearer cloud-jwt"
