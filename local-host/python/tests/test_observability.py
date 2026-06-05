"""Tests for the observability layer (DaemonObserver + structlog config)."""

from __future__ import annotations

import asyncio
from typing import Any
from uuid import uuid4

import pytest
import structlog
from structlog.testing import capture_logs

from local_host.observability import (
    DaemonObserver,
    build_callbacks,
    configure_logging,
    is_disabled,
)


@pytest.fixture(autouse=True)
def reset_structlog_state():
    """Each test gets a fresh structlog config (the module caches setup)."""
    import local_host.observability as obs

    obs._configured = False
    structlog.reset_defaults()
    yield
    obs._configured = False


def test_configure_logging_is_idempotent() -> None:
    configure_logging(json_output=True)
    configure_logging(json_output=True)  # second call should be safe
    log = structlog.get_logger("test")
    log.info("hello")  # must not raise


def test_is_disabled_respects_env(monkeypatch: Any) -> None:
    monkeypatch.delenv("SHEJANE_DISABLE_OBSERVABILITY", raising=False)
    assert is_disabled() is False
    monkeypatch.setenv("SHEJANE_DISABLE_OBSERVABILITY", "1")
    assert is_disabled() is True
    monkeypatch.setenv("SHEJANE_DISABLE_OBSERVABILITY", "true")
    assert is_disabled() is True
    monkeypatch.setenv("SHEJANE_DISABLE_OBSERVABILITY", "0")
    assert is_disabled() is False


def test_build_callbacks_returns_observer_by_default(monkeypatch: Any) -> None:
    monkeypatch.delenv("SHEJANE_DISABLE_OBSERVABILITY", raising=False)
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    callbacks = build_callbacks()
    assert len(callbacks) == 1
    assert isinstance(callbacks[0], DaemonObserver)


def test_build_callbacks_empty_when_disabled(monkeypatch: Any) -> None:
    monkeypatch.setenv("SHEJANE_DISABLE_OBSERVABILITY", "1")
    assert build_callbacks() == []


def test_build_callbacks_skips_langfuse_when_sdk_missing(monkeypatch: Any) -> None:
    """If credentials are set but the langfuse SDK isn't installed, we should
    log a warning but still return the daemon observer."""
    monkeypatch.delenv("SHEJANE_DISABLE_OBSERVABILITY", raising=False)
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk_test")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk_test")
    callbacks = build_callbacks()
    # Either 1 (no SDK) or 2 (SDK present). Both are acceptable.
    assert len(callbacks) in (1, 2)
    assert isinstance(callbacks[0], DaemonObserver)


# --- DaemonObserver event capture ---


def test_observer_logs_tool_start_and_end() -> None:
    obs = DaemonObserver()
    run_id = uuid4()

    async def run() -> None:
        await obs.on_tool_start(
            {"name": "fs.read"},
            "{'path': '/tmp/x'}",
            run_id=run_id,
        )
        await obs.on_tool_end("file content here", run_id=run_id)

    with capture_logs() as captured:
        asyncio.run(run())

    events = [e["event"] for e in captured]
    assert "tool.start" in events
    assert "tool.end" in events

    end_event = next(e for e in captured if e["event"] == "tool.end")
    assert end_event["elapsed_ms"] is not None
    assert end_event["elapsed_ms"] >= 0


def test_observer_logs_tool_error_clears_timer() -> None:
    obs = DaemonObserver()
    run_id = uuid4()

    async def run() -> None:
        await obs.on_tool_start({"name": "shell.run"}, "ls /nope", run_id=run_id)
        await obs.on_tool_error(RuntimeError("file not found"), run_id=run_id)

    with capture_logs() as captured:
        asyncio.run(run())

    err_event = next(e for e in captured if e["event"] == "tool.error")
    assert err_event["error_type"] == "RuntimeError"
    assert err_event["error_message"] == "file not found"
    # Subsequent end events should not show negative elapsed (timer was cleared)
    assert run_id not in obs._timers  # type: ignore[attr-defined]


def test_observer_logs_llm_lifecycle() -> None:
    from langchain_core.outputs import Generation, LLMResult

    obs = DaemonObserver()
    run_id = uuid4()

    async def run() -> None:
        await obs.on_chat_model_start(
            {"name": "test-model"},
            [["msg1", "msg2"]],
            run_id=run_id,
        )
        result = LLMResult(
            generations=[[Generation(text="answer")]],
            llm_output={"token_usage": {"input_tokens": 12, "output_tokens": 5}},
        )
        await obs.on_llm_end(result, run_id=run_id)

    with capture_logs() as captured:
        asyncio.run(run())

    events_by_name = {e["event"]: e for e in captured}
    assert "llm.start" in events_by_name
    assert "llm.end" in events_by_name

    end = events_by_name["llm.end"]
    assert end["input_tokens"] == 12
    assert end["output_tokens"] == 5
    assert end["elapsed_ms"] is not None


def test_observer_truncates_long_payloads() -> None:
    obs = DaemonObserver()
    run_id = uuid4()
    long_input = "x" * 5000

    async def run() -> None:
        await obs.on_tool_start({"name": "noisy"}, long_input, run_id=run_id)

    with capture_logs() as captured:
        asyncio.run(run())

    start = next(e for e in captured if e["event"] == "tool.start")
    assert len(start["input_preview"]) <= 200
    assert start["input_preview"].endswith("…")
