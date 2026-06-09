"""Tests for the auto-mode classifier — covers happy path (well-formed
JSON), malformed JSON fallback, network failure fallback, and the
mode.selected event flow through start_run.
"""

from __future__ import annotations

import json
from collections.abc import Iterable

import httpx
import pytest

from local_host.agent.auto_router import _parse_classifier_output, classify_mode


def _sse(events: Iterable[tuple[str, str]]) -> bytes:
    parts = [f"event: {name}\ndata: {payload}\n\n" for name, payload in events]
    return "".join(parts).encode("utf-8")


def _stream_response(events: Iterable[tuple[str, str]]) -> httpx.Response:
    return httpx.Response(
        200,
        content=_sse(events),
        headers={"content-type": "text/event-stream"},
    )


def _make_patched_client(transport_handler):
    class _Patched(httpx.AsyncClient):
        def __init__(self, **kw):
            super().__init__(
                transport=httpx.MockTransport(transport_handler),
                **{k: v for k, v in kw.items() if k != "transport"},
            )

    return _Patched


# --- _parse_classifier_output unit tests -----------------------------


def test_parse_well_formed_json_deep() -> None:
    mode, reason = _parse_classifier_output(
        '{"mode":"deep","reason":"multi-step reasoning needed"}'
    )
    assert mode == "deep"
    assert reason == "multi-step reasoning needed"


def test_parse_well_formed_json_fast() -> None:
    mode, reason = _parse_classifier_output('{"mode":"fast","reason":"simple lookup"}')
    assert mode == "fast"
    assert reason == "simple lookup"


def test_parse_json_with_surrounding_prose() -> None:
    """Some models wrap JSON in code fences or commentary — we strip
    everything outside the first/last brace."""
    text = 'Sure! Here is my decision:\n```json\n{"mode": "deep", "reason": "complex"}\n```\nLet me know!'
    mode, reason = _parse_classifier_output(text)
    assert mode == "deep"
    assert reason == "complex"


def test_parse_unknown_mode_falls_back_to_fast() -> None:
    mode, reason = _parse_classifier_output('{"mode":"gigabrain","reason":"x"}')
    assert mode == "fast"
    assert "unparseable" in reason or "defaulted" in reason


def test_parse_malformed_json_keyword_fallback_to_deep() -> None:
    """When the model emits bare prose but clearly says 'deep', honor it."""
    mode, _reason = _parse_classifier_output("Deep is needed here, the task is complex.")
    assert mode == "deep"


def test_parse_empty_string_defaults_fast() -> None:
    mode, _reason = _parse_classifier_output("")
    assert mode == "fast"


# --- classify_mode integration tests ---------------------------------


@pytest.mark.asyncio
async def test_classify_mode_deep_path(monkeypatch) -> None:
    """End-to-end: classifier streams back a JSON deep decision."""
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read()
        # Stream the JSON answer one chunk at a time so it exercises
        # BackendChatModel's _astream + accumulator path.
        return _stream_response(
            [
                ("llm.delta", json.dumps({"content_delta": '{"mode":"deep",'})),
                ("llm.delta", json.dumps({"content_delta": '"reason":"complex multi-step task"}'})),
                ("llm.done", '{"request_id": "req-1", "finish_reason": "stop"}'),
            ]
        )

    monkeypatch.setattr("httpx.AsyncClient", _make_patched_client(handler))

    mode, reason = await classify_mode(
        goal="Refactor this auth middleware for thread safety",
        history=None,
        cloud_base_url="http://test-backend",
        cloud_token="t",
        run_id="run-auto-1",
    )

    assert mode == "deep"
    assert reason == "complex multi-step task"
    # Goal must reach the classifier so it can decide on actual content.
    assert b"Refactor" in captured["body"]
    # And the classifier itself runs in fast mode (cheaper). The cloud LLM
    # endpoint now takes the routing value under the "model" key.
    assert b'"model":"fast"' in captured["body"]


@pytest.mark.asyncio
async def test_classify_mode_fast_path(monkeypatch) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return _stream_response(
            [
                (
                    "llm.delta",
                    json.dumps({"content_delta": '{"mode":"fast","reason":"simple question"}'}),
                ),
                ("llm.done", '{"request_id": "req-2", "finish_reason": "stop"}'),
            ]
        )

    monkeypatch.setattr("httpx.AsyncClient", _make_patched_client(handler))

    mode, reason = await classify_mode(
        goal="What is 2+2?",
        history=None,
        cloud_base_url="http://test-backend",
        cloud_token="t",
        run_id="run-auto-2",
    )

    assert mode == "fast"
    assert reason == "simple question"


@pytest.mark.asyncio
async def test_classify_mode_network_failure_falls_back_to_fast(monkeypatch) -> None:
    """Classifier should NEVER raise — any failure resolves to fast."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, content=b"internal error")

    monkeypatch.setattr("httpx.AsyncClient", _make_patched_client(handler))

    mode, reason = await classify_mode(
        goal="anything",
        history=None,
        cloud_base_url="http://test-backend",
        cloud_token="t",
        run_id="run-auto-3",
    )

    assert mode == "fast"
    assert "classifier unavailable" in reason or "defaulted" in reason


@pytest.mark.asyncio
async def test_classify_mode_empty_goal_short_circuits(monkeypatch) -> None:
    """Empty goal shouldn't trigger an LLM call — defaults to fast."""
    called = {"count": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        called["count"] += 1
        return _stream_response([])

    monkeypatch.setattr("httpx.AsyncClient", _make_patched_client(handler))

    mode, _reason = await classify_mode(
        goal="",
        history=None,
        cloud_base_url="http://test-backend",
        cloud_token="t",
        run_id="run-auto-4",
    )

    assert mode == "fast"
    assert called["count"] == 0, "empty goal must not pay for a classifier call"


@pytest.mark.asyncio
async def test_classify_mode_includes_recent_history(monkeypatch) -> None:
    """Recent history (last 2 turns) is sent so the classifier can see
    the conversational context, not just the standalone goal."""
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read().decode("utf-8")
        return _stream_response(
            [
                (
                    "llm.delta",
                    json.dumps({"content_delta": '{"mode":"deep","reason":"follow-up"}'}),
                ),
                ("llm.done", '{"request_id": "req-h", "finish_reason": "stop"}'),
            ]
        )

    monkeypatch.setattr("httpx.AsyncClient", _make_patched_client(handler))

    await classify_mode(
        goal="Continue with the analysis",
        history=[
            {"role": "user", "content": "Analyze this dataset for trends"},
            {"role": "assistant", "content": "Initial analysis done. Found 3 patterns."},
            {"role": "user", "content": "Continue with the analysis"},
        ],
        cloud_base_url="http://test-backend",
        cloud_token="t",
        run_id="run-auto-5",
    )

    # The classifier sees the goal + the last 2 turns of history (NOT 3 —
    # we cap to avoid runaway context costs).
    assert "Initial analysis" in captured["body"]
    assert "Continue with the analysis" in captured["body"]
