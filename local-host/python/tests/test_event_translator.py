"""Tests for the LangGraph -> client SSE event translation layer."""

from __future__ import annotations

from langchain_core.messages import AIMessageChunk, ToolMessage

from local_host.event_translator import translate


def test_messages_mode_emits_llm_token() -> None:
    chunk = AIMessageChunk(content="Hello")
    events = translate("messages", (chunk, {}))
    assert events == [{"event": "llm.delta", "data": {"content": "Hello"}}]


def test_messages_mode_emits_reasoning_separately() -> None:
    chunk = AIMessageChunk(
        content="answer",
        additional_kwargs={"reasoning_content": "thinking..."},
    )
    events = translate("messages", (chunk, {}))
    names = [e["event"] for e in events]
    assert "llm.delta" in names
    assert "llm.reasoning" in names


def test_messages_mode_emits_tool_call_chunks() -> None:
    chunk = AIMessageChunk(
        content="",
        tool_call_chunks=[
            {"id": "c1", "name": "fs.read", "args": '{"path":', "index": 0},
        ],
    )
    events = translate("messages", (chunk, {}))
    assert events == [
        {
            "event": "llm.tool_call_chunk",
            "data": {
                "id": "c1",
                "name": "fs.read",
                "args_delta": '{"path":',
                "index": 0,
            },
        }
    ]


def test_messages_mode_surfaces_backend_error() -> None:
    chunk = AIMessageChunk(
        content="",
        additional_kwargs={"backend_error": "rate limit exceeded"},
    )
    events = translate("messages", (chunk, {}))
    assert {"event": "llm.error", "data": {"message": "rate limit exceeded"}} in events


def test_messages_mode_emits_tool_completed_for_tool_message() -> None:
    tm = ToolMessage(content="42", tool_call_id="c1", name="time.now")
    events = translate("messages", (tm, {}))
    # `tool.completed` is the canonical name the client looks for; the
    # event also carries a `tool` alias of `name` so the renderer can
    # show a "completed time.now" headline without re-keying.
    assert events[0]["event"] == "tool.completed"
    assert events[0]["data"]["tool_call_id"] == "c1"
    assert events[0]["data"]["name"] == "time.now"
    assert events[0]["data"]["content"] == "42"


def test_updates_mode_emits_per_node_graph_node_event() -> None:
    payload = {"router": {"mode_route": "fast"}}
    events = translate("updates", payload)
    assert len(events) == 1
    assert events[0]["event"] == "graph.node"
    assert events[0]["data"]["node"] == "router"


def test_updates_mode_detects_tool_completed_inside_tools_node() -> None:
    tm = ToolMessage(content="ok", tool_call_id="c1", name="time.now")
    payload = {"tools": {"messages": [tm]}}
    events = translate("updates", payload)
    names = [e["event"] for e in events]
    assert "tool.completed" in names
    assert "graph.node" in names


def test_custom_mode_emits_agent_custom() -> None:
    events = translate("custom", {"phase": "planning", "step": 1})
    assert events == [{"event": "agent.custom", "data": {"phase": "planning", "step": 1}}]


def test_unknown_mode_falls_back_to_graph_node() -> None:
    events = translate("weird_new_mode", {"x": 1})
    assert events[0]["event"] == "graph.node"
    assert events[0]["data"]["kind"] == "weird_new_mode"
