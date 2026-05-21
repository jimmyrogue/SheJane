"""Tests for BackendChatModel — uses httpx.MockTransport so we don't need
a live Go backend to exercise the SSE parsing + LangChain message glue.
"""

from __future__ import annotations

import asyncio
from typing import Iterable

import httpx
import pytest
from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import tool

from local_host.llm.backend import BackendChatModel


def _sse(events: Iterable[tuple[str, str]]) -> bytes:
    """Encode (event, data_json_str) pairs into SSE bytes."""
    parts: list[str] = []
    for name, payload in events:
        parts.append(f"event: {name}\ndata: {payload}\n\n")
    return "".join(parts).encode("utf-8")


def _stream_response(events: Iterable[tuple[str, str]]) -> httpx.Response:
    body = _sse(events)
    return httpx.Response(
        200,
        content=body,
        headers={"content-type": "text/event-stream"},
    )


def _make_model_with_mock(transport_handler) -> BackendChatModel:
    """Replace the model's httpx client with a MockTransport handler.

    Monkey-patch `httpx.AsyncClient` for the test duration via a helper
    factory so the model itself stays unchanged.
    """
    return BackendChatModel(
        cloud_base_url="http://test-backend",
        cloud_token="t",
        run_id="run-test",
    )


def _patched_async_client(transport_handler):
    """Return a class that mimics httpx.AsyncClient but uses a MockTransport."""

    class _Patched(httpx.AsyncClient):
        def __init__(self, **kw):
            super().__init__(
                transport=httpx.MockTransport(transport_handler),
                **{k: v for k, v in kw.items() if k != "transport"},
            )

    return _Patched


def test_agenerate_text_only(monkeypatch) -> None:
    """Backend returns a text-only stream → AIMessage with combined content."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/api/v1/agent/llm/stream"
        assert request.headers["accept"] == "text/event-stream"
        assert request.headers["authorization"] == "Bearer t"
        body = request.read()
        assert b"run-test" in body
        return _stream_response([
            ("llm.delta", '{"content_delta": "Hello"}'),
            ("llm.delta", '{"content_delta": ", "}'),
            ("llm.delta", '{"content_delta": "world."}'),
            ("llm.usage", '{"input_tokens": 5, "output_tokens": 3, "credits_cost": 1}'),
            ("llm.done", '{"request_id": "req-1", "finish_reason": "stop"}'),
        ])

    monkeypatch.setattr(
        "local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler)
    )
    model = _make_model_with_mock(handler)

    result = asyncio.run(model._agenerate([HumanMessage(content="Hi")]))
    assert len(result.generations) == 1
    msg = result.generations[0].message
    assert msg.content == "Hello, world."
    assert result.generations[0].generation_info["finish_reason"] == "stop"


def test_agenerate_with_tool_calls(monkeypatch) -> None:
    """Backend emits llm.tool_call → AIMessage with structured tool_calls."""

    def handler(request: httpx.Request) -> httpx.Response:
        return _stream_response([
            ("llm.delta", '{"content_delta": "Let me check..."}'),
            ("llm.tool_call", '{"id": "call_1", "name": "time.now", "arguments": {"timezone": "UTC"}}'),
            ("llm.done", '{"request_id": "req-2", "finish_reason": "tool_calls"}'),
        ])

    monkeypatch.setattr(
        "local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler)
    )
    model = _make_model_with_mock(handler)

    result = asyncio.run(model._agenerate([HumanMessage(content="What time is it?")]))
    msg = result.generations[0].message
    assert "Let me check..." in msg.content
    assert len(msg.tool_calls) == 1
    assert msg.tool_calls[0]["name"] == "time.now"
    assert msg.tool_calls[0]["args"] == {"timezone": "UTC"}


def test_astream_yields_per_token(monkeypatch) -> None:
    """astream should yield one ChatGenerationChunk per llm.delta event."""

    def handler(request: httpx.Request) -> httpx.Response:
        return _stream_response([
            ("llm.delta", '{"content_delta": "a"}'),
            ("llm.delta", '{"content_delta": "b"}'),
            ("llm.delta", '{"content_delta": "c"}'),
            ("llm.done", '{"request_id": "req-3", "finish_reason": "stop"}'),
        ])

    monkeypatch.setattr(
        "local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler)
    )
    model = _make_model_with_mock(handler)

    async def collect() -> list[str]:
        return [c.message.content async for c in model._astream([HumanMessage(content="hi")])]

    chunks = asyncio.run(collect())
    # tokens only — usage/done are filtered out without capture_meta
    assert chunks == ["a", "b", "c"]


def test_backend_4xx_raises(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(402, json={"error": "insufficient credits"})

    monkeypatch.setattr(
        "local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler)
    )
    model = _make_model_with_mock(handler)

    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(model._agenerate([HumanMessage(content="x")]))


def test_bind_tools_serializes_correctly() -> None:
    @tool("demo.echo")
    def demo_echo(message: str) -> str:
        """Echo the message back."""
        return message

    base = BackendChatModel()
    bound = base.bind_tools([demo_echo])
    assert isinstance(bound, BackendChatModel)
    assert len(bound.bound_tools) == 1
    t = bound.bound_tools[0]
    assert t["name"] == "demo.echo"
    assert "Echo" in t["description"]
    assert t["inputSchema"]["type"] == "object"


def test_message_conversion_round_trip() -> None:
    """ToolMessage / HumanMessage / AIMessage all serialize cleanly."""
    from langchain_core.messages import AIMessage

    from local_host.llm.backend import _message_to_dict

    assert _message_to_dict(HumanMessage(content="hi"))["role"] == "user"
    assert _message_to_dict(
        ToolMessage(content="result", tool_call_id="x", name="t")
    ) == {
        "role": "tool",
        "content": "result",
        "toolCallId": "x",
        "name": "t",
    }
    ai = AIMessage(
        content="answer",
        tool_calls=[{"id": "c1", "name": "t", "args": {"k": "v"}}],
    )
    out = _message_to_dict(ai)
    assert out["role"] == "assistant"
    assert out["toolCalls"] == [{"id": "c1", "name": "t", "arguments": {"k": "v"}}]
