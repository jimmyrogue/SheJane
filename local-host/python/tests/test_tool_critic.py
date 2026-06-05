"""Tests for ToolResultCriticMiddleware — mid-loop reflection on tool results."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

from langchain_core.messages import HumanMessage, ToolMessage

from local_host.middleware.tool_critic import (
    DEFAULT_WATCH_TOOLS,
    ToolResultCriticMiddleware,
)

# --- helpers ---


@dataclass
class FakeCriticModel:
    """Returns whatever JSON string is set, records the call."""

    response_text: str
    calls: list = None  # populated lazily

    def __post_init__(self) -> None:
        self.calls = []

    async def ainvoke(self, messages: list) -> SimpleNamespace:
        self.calls.append(messages)
        return SimpleNamespace(content=self.response_text)


def _make_request(
    tool_name: str, args: dict[str, Any] | None = None, user_text: str = "do the task"
) -> Any:
    """Construct a minimal ToolCallRequest-shaped object."""
    return SimpleNamespace(
        tool_call={"name": tool_name, "args": args or {}, "id": "c1"},
        tool=None,
        state={"messages": [HumanMessage(content=user_text)]},
        runtime=None,
    )


async def _handler_returns(result: Any):
    async def _h(_request):
        return result

    return _h


# --- mode parsing ---


def test_mode_off_default(monkeypatch) -> None:
    monkeypatch.delenv("SHEJANE_LOCAL_TOOL_CRITIC", raising=False)
    mw = ToolResultCriticMiddleware()
    assert mw.mode == "off"


def test_mode_resolves_each_supported_value(monkeypatch) -> None:
    for value in ("watch", "nudge", "block"):
        monkeypatch.setenv("SHEJANE_LOCAL_TOOL_CRITIC", value)
        mw = ToolResultCriticMiddleware()
        assert mw.mode == value


def test_invalid_mode_falls_back_to_off(monkeypatch) -> None:
    monkeypatch.setenv("SHEJANE_LOCAL_TOOL_CRITIC", "verbose-shouting")
    mw = ToolResultCriticMiddleware()
    assert mw.mode == "off"


def test_explicit_mode_overrides_env(monkeypatch) -> None:
    monkeypatch.setenv("SHEJANE_LOCAL_TOOL_CRITIC", "off")
    mw = ToolResultCriticMiddleware(mode="block")
    assert mw.mode == "block"


# --- watch list ---


def test_default_watch_list_contains_expected_tools() -> None:
    assert {"web.fetch", "web.search", "task", "browser.task", "execute"}.issubset(
        DEFAULT_WATCH_TOOLS
    )


def test_default_watch_list_excludes_trivial_tools() -> None:
    trivial = {"time.now", "clipboard.read", "clipboard.write", "open.url", "task.verify"}
    assert not (trivial & DEFAULT_WATCH_TOOLS)


# --- off mode short-circuits before critic ---


def test_off_mode_does_not_call_critic() -> None:
    critic = FakeCriticModel(response_text='{"usable": false, "reason": "bad"}')
    mw = ToolResultCriticMiddleware(critic_model=critic, mode="off")
    original = ToolMessage(content="result", tool_call_id="c1", name="web.fetch")

    async def run() -> ToolMessage:
        handler = await _handler_returns(original)
        return await mw.awrap_tool_call(_make_request("web.fetch"), handler)

    out = asyncio.run(run())
    assert out is original
    assert critic.calls == []


# --- trivial (unwatched) tool short-circuits ---


def test_unwatched_tool_skips_critic() -> None:
    critic = FakeCriticModel(response_text='{"usable": false, "reason": "bad"}')
    mw = ToolResultCriticMiddleware(critic_model=critic, mode="nudge")
    original = ToolMessage(content="14:30:00", tool_call_id="c1", name="time.now")

    async def run() -> ToolMessage:
        handler = await _handler_returns(original)
        return await mw.awrap_tool_call(_make_request("time.now"), handler)

    out = asyncio.run(run())
    assert out.content == "14:30:00"
    assert critic.calls == []  # critic never invoked for trivial tool


# --- nudge mode behavior ---


def test_nudge_passes_through_when_usable_true() -> None:
    critic = FakeCriticModel(response_text='{"usable": true, "reason": "looks good"}')
    mw = ToolResultCriticMiddleware(critic_model=critic, mode="nudge")
    original = ToolMessage(content="useful content", tool_call_id="c1", name="web.fetch")

    async def run() -> ToolMessage:
        handler = await _handler_returns(original)
        return await mw.awrap_tool_call(_make_request("web.fetch"), handler)

    out = asyncio.run(run())
    assert out.content == "useful content"
    assert len(critic.calls) == 1  # critic was invoked


def test_nudge_prepends_warning_when_usable_false() -> None:
    critic = FakeCriticModel(
        response_text='{"usable": false, "reason": "page returned a 404 error"}'
    )
    mw = ToolResultCriticMiddleware(critic_model=critic, mode="nudge")
    original = ToolMessage(content="<html>Not Found</html>", tool_call_id="c1", name="web.fetch")

    async def run() -> ToolMessage:
        handler = await _handler_returns(original)
        return await mw.awrap_tool_call(_make_request("web.fetch"), handler)

    out = asyncio.run(run())
    assert "⚠️ MID-LOOP CRITIC" in out.content
    assert "page returned a 404 error" in out.content
    # Original content still present after the divider
    assert "<html>Not Found</html>" in out.content


# --- block mode behavior ---


def test_block_replaces_content_when_usable_false() -> None:
    critic = FakeCriticModel(
        response_text='{"usable": false, "reason": "search results were off-topic"}'
    )
    mw = ToolResultCriticMiddleware(critic_model=critic, mode="block")
    original = ToolMessage(content="garbage results", tool_call_id="c1", name="web.search")

    async def run() -> ToolMessage:
        handler = await _handler_returns(original)
        return await mw.awrap_tool_call(_make_request("web.search"), handler)

    out = asyncio.run(run())
    assert "Tool result rejected" in out.content
    assert "search results were off-topic" in out.content
    # Original NOT preserved in block mode
    assert "garbage results" not in out.content


def test_block_passes_through_when_usable_true() -> None:
    critic = FakeCriticModel(response_text='{"usable": true, "reason": "great"}')
    mw = ToolResultCriticMiddleware(critic_model=critic, mode="block")
    original = ToolMessage(content="good info", tool_call_id="c1", name="web.fetch")

    async def run() -> ToolMessage:
        handler = await _handler_returns(original)
        return await mw.awrap_tool_call(_make_request("web.fetch"), handler)

    out = asyncio.run(run())
    assert out.content == "good info"


# --- watch mode observes only, never mutates ---


def test_watch_mode_does_not_mutate_even_on_unusable() -> None:
    critic = FakeCriticModel(response_text='{"usable": false, "reason": "broken"}')
    mw = ToolResultCriticMiddleware(critic_model=critic, mode="watch")
    original = ToolMessage(content="broken content", tool_call_id="c1", name="web.fetch")

    async def run() -> ToolMessage:
        handler = await _handler_returns(original)
        return await mw.awrap_tool_call(_make_request("web.fetch"), handler)

    out = asyncio.run(run())
    assert out.content == "broken content"  # unchanged
    assert len(critic.calls) == 1  # critic ran (we want the log)


# --- fail-open on critic errors ---


def test_critic_exception_passes_through() -> None:
    class BrokenCritic:
        async def ainvoke(self, msgs):
            raise RuntimeError("rate limit")

    mw = ToolResultCriticMiddleware(critic_model=BrokenCritic(), mode="nudge")
    original = ToolMessage(content="content", tool_call_id="c1", name="web.fetch")

    async def run() -> ToolMessage:
        handler = await _handler_returns(original)
        return await mw.awrap_tool_call(_make_request("web.fetch"), handler)

    out = asyncio.run(run())
    # Fail-open: original passes through unchanged
    assert out.content == "content"


def test_critic_non_json_response_passes_through() -> None:
    critic = FakeCriticModel(response_text="this is not json")
    mw = ToolResultCriticMiddleware(critic_model=critic, mode="nudge")
    original = ToolMessage(content="content", tool_call_id="c1", name="web.fetch")

    async def run() -> ToolMessage:
        handler = await _handler_returns(original)
        return await mw.awrap_tool_call(_make_request("web.fetch"), handler)

    out = asyncio.run(run())
    assert out.content == "content"


def test_critic_missing_model_passes_through() -> None:
    mw = ToolResultCriticMiddleware(critic_model=None, mode="nudge")
    original = ToolMessage(content="content", tool_call_id="c1", name="web.fetch")

    async def run() -> ToolMessage:
        handler = await _handler_returns(original)
        return await mw.awrap_tool_call(_make_request("web.fetch"), handler)

    out = asyncio.run(run())
    assert out.content == "content"


# --- prompt construction ---


def test_critic_receives_task_args_and_result() -> None:
    """Verify the critic gets the original user task, tool name, args, and result
    — not just a blob — so it can judge usability properly."""
    critic = FakeCriticModel(response_text='{"usable": true, "reason": "ok"}')
    mw = ToolResultCriticMiddleware(critic_model=critic, mode="watch")
    original = ToolMessage(content="page content", tool_call_id="c1", name="web.fetch")
    request = _make_request(
        "web.fetch",
        args={"url": "https://example.com/x"},
        user_text="summarize this article for me",
    )

    async def run() -> None:
        handler = await _handler_returns(original)
        await mw.awrap_tool_call(request, handler)

    asyncio.run(run())
    assert len(critic.calls) == 1
    sent_to_critic = critic.calls[0]
    # SystemMessage at [0], HumanMessage at [1]
    user_msg_content = sent_to_critic[1].content
    assert "summarize this article" in user_msg_content
    assert "web.fetch" in user_msg_content
    assert "https://example.com/x" in user_msg_content
    assert "page content" in user_msg_content


# --- truncation guard ---


def test_critic_input_truncated_when_result_huge() -> None:
    """A 100KB result should not blow critic context. The middleware
    truncates to max_input_chars (default 2000)."""
    critic = FakeCriticModel(response_text='{"usable": true, "reason": "ok"}')
    mw = ToolResultCriticMiddleware(critic_model=critic, mode="watch", max_input_chars=500)
    huge = "x" * 100_000
    original = ToolMessage(content=huge, tool_call_id="c1", name="web.fetch")

    async def run() -> None:
        handler = await _handler_returns(original)
        await mw.awrap_tool_call(_make_request("web.fetch"), handler)

    asyncio.run(run())
    sent_to_critic = critic.calls[0][1].content  # HumanMessage content
    # The full 100k should NOT appear in the prompt
    assert sent_to_critic.count("x") < 1000  # < 500 truncated + a few prompt chars
    # truncation marker present
    assert "truncated" in sent_to_critic.lower()
