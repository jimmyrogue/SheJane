"""Tests for BackendChatModel — uses httpx.MockTransport so we don't need
a live Go backend to exercise the SSE parsing + LangChain message glue.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterable

import httpx
import pytest
from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import tool

from local_host.llm.backend import BackendChatModel, BackendLLMError


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
        return _stream_response(
            [
                ("llm.delta", '{"content_delta": "Hello"}'),
                ("llm.delta", '{"content_delta": ", "}'),
                ("llm.delta", '{"content_delta": "world."}'),
                ("llm.usage", '{"input_tokens": 5, "output_tokens": 3, "credits_cost": 1}'),
                ("llm.done", '{"request_id": "req-1", "finish_reason": "stop"}'),
            ]
        )

    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler))
    model = _make_model_with_mock(handler)

    result = asyncio.run(model._agenerate([HumanMessage(content="Hi")]))
    assert len(result.generations) == 1
    msg = result.generations[0].message
    assert msg.content == "Hello, world."
    assert result.generations[0].generation_info["finish_reason"] == "stop"
    # _agenerate captures per-call usage onto the final message.
    assert msg.additional_kwargs.get("usage") == {
        "input_tokens": 5,
        "output_tokens": 3,
        "credits_cost": 1,
    }


def test_agenerate_with_tool_calls(monkeypatch) -> None:
    """Backend emits llm.tool_call → AIMessage with structured tool_calls."""

    def handler(request: httpx.Request) -> httpx.Response:
        return _stream_response(
            [
                ("llm.delta", '{"content_delta": "Let me check..."}'),
                (
                    "llm.tool_call",
                    '{"id": "call_1", "name": "time.now", "arguments": {"timezone": "UTC"}}',
                ),
                ("llm.done", '{"request_id": "req-2", "finish_reason": "tool_calls"}'),
            ]
        )

    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler))
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
        return _stream_response(
            [
                ("llm.delta", '{"content_delta": "a"}'),
                ("llm.delta", '{"content_delta": "b"}'),
                ("llm.delta", '{"content_delta": "c"}'),
                ("llm.done", '{"request_id": "req-3", "finish_reason": "stop"}'),
            ]
        )

    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler))
    model = _make_model_with_mock(handler)

    async def collect() -> list[str]:
        return [c.message.content async for c in model._astream([HumanMessage(content="hi")])]

    chunks = asyncio.run(collect())
    # The final empty chunk carries the provider request id for the durable
    # model-call receipt; product text streaming still sees only a/b/c.
    assert chunks == ["a", "b", "c", ""]


def test_astream_surfaces_usage(monkeypatch) -> None:
    """astream surfaces llm.usage via additional_kwargs so it survives into
    LangGraph messages mode and reaches the per-turn usage chip."""

    def handler(request: httpx.Request) -> httpx.Response:
        return _stream_response(
            [
                ("llm.delta", '{"content_delta": "hi"}'),
                ("llm.usage", '{"input_tokens": 7, "output_tokens": 4, "credits_cost": 2}'),
                ("llm.done", '{"request_id": "req-u", "finish_reason": "stop"}'),
            ]
        )

    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler))
    model = _make_model_with_mock(handler)

    async def collect():
        return [c async for c in model._astream([HumanMessage(content="hi")])]

    chunks = asyncio.run(collect())
    usage_chunks = [c for c in chunks if c.message.additional_kwargs.get("usage")]
    assert len(usage_chunks) == 1
    assert usage_chunks[0].message.additional_kwargs["usage"] == {
        "input_tokens": 7,
        "output_tokens": 4,
        "credits_cost": 2,
    }


def test_backend_4xx_raises(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(402, json={"error": "insufficient credits"})

    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler))
    model = _make_model_with_mock(handler)

    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(model._agenerate([HumanMessage(content="x")]))


def test_backend_llm_error_raises_structured_error(monkeypatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return _stream_response(
            [
                (
                    "llm.error",
                    json.dumps(
                        {
                            "request_id": "req-error",
                            "message": "rate limit exceeded",
                            "code": "rate_limit",
                            "recoverable": True,
                            "retryable": True,
                            "provider": "anthropic",
                        }
                    ),
                )
            ]
        )

    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler))
    model = _make_model_with_mock(handler)

    with pytest.raises(BackendLLMError) as exc_info:
        asyncio.run(model._agenerate([HumanMessage(content="x")]))

    exc = exc_info.value
    assert str(exc) == "rate limit exceeded"
    assert exc.code == "rate_limit"
    assert exc.request_id == "req-error"
    assert exc.provider == "anthropic"
    assert exc.recoverable is True
    assert exc.retryable is True


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
    request = bound._build_request([HumanMessage(content="hi")])
    assert request["max_output_tokens"] == 8192
    assert request["prompt_owner"] == "runtime-v1"


def test_message_conversion_round_trip() -> None:
    """ToolMessage / HumanMessage / AIMessage all serialize cleanly."""
    from langchain_core.messages import AIMessage

    from local_host.llm.backend import _message_to_dict

    assert _message_to_dict(HumanMessage(content="hi"))["role"] == "user"
    assert _message_to_dict(ToolMessage(content="result", tool_call_id="x", name="t")) == {
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
    # No reasoning_content on a vanilla AIMessage → no reasoningContent in dict.
    assert "reasoningContent" not in out


def test_aimessage_reasoning_round_trips_for_deepseek_thinking_mode() -> None:
    """DeepSeek thinking-mode round-trip regression.

    DeepSeek rejects multi-turn requests with 400:
        "The `reasoning_content` in the thinking mode must be passed
         back to the API."
    when the previous assistant message had reasoning_content but the
    next request omits it. We accumulate `reasoning_content` into
    AIMessage.additional_kwargs during streaming (see backend.py's
    `_event_to_chunk` accumulator); the converter MUST surface it as
    `reasoningContent` on the outbound message dict so the Go gateway
    can forward it.
    """
    from langchain_core.messages import AIMessage

    from local_host.llm.backend import _message_to_dict

    ai = AIMessage(
        content="2+2=4",
        additional_kwargs={"reasoning_content": "I should add 2 and 2."},
    )
    out = _message_to_dict(ai)
    assert out["reasoningContent"] == "I should add 2 and 2."
