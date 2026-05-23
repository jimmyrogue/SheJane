"""Tests for the LangGraph -> client SSE event translation layer."""

from __future__ import annotations

from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage

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


def test_updates_mode_does_not_double_emit_tool_completed() -> None:
    """Regression: updates mode used to scan the `tools` node delta for
    ToolMessages and emit a `tool.completed` per message. But messages
    mode already emits the same tool.completed for that ToolMessage,
    so every tool ended up reported twice with different event IDs.
    Client-side dedupe is keyed on event ID, so the duplicates leaked
    into agentEvents and caused operationCountsLabel to double-count
    ("搜索 8 次" instead of "搜索 4 次"). Updates mode is now graph.node-
    only; messages mode is the single source of truth for tool events.
    """
    tm = ToolMessage(content="ok", tool_call_id="c1", name="time.now")
    payload = {"tools": {"messages": [tm]}}
    events = translate("updates", payload)
    names = [e["event"] for e in events]
    assert "tool.completed" not in names
    assert "tool.failed" not in names
    assert names == ["graph.node"]


def test_custom_mode_emits_agent_custom() -> None:
    events = translate("custom", {"phase": "planning", "step": 1})
    assert events == [{"event": "agent.custom", "data": {"phase": "planning", "step": 1}}]


def test_unknown_mode_falls_back_to_graph_node() -> None:
    events = translate("weird_new_mode", {"x": 1})
    assert events[0]["event"] == "graph.node"
    assert events[0]["data"]["kind"] == "weird_new_mode"


def test_messages_mode_non_ai_chunk_becomes_graph_node_not_llm_delta() -> None:
    """Regression: any non-AI/Tool chunk streamed in messages mode used
    to be wrapped as `llm.delta`. That meant a middleware appending a
    HumanMessage to state (OutputGuard retry-nudge regression) showed
    up on the client as if the model had streamed it. The fall-through
    is now `graph.node` so the client never confuses internal state
    with assistant content."""
    from langchain_core.messages import HumanMessage

    nudge = HumanMessage(content="Your last response was empty.")
    events = translate("messages", (nudge, {}))
    assert events[0]["event"] == "graph.node"
    assert events[0]["event"] != "llm.delta"
    assert events[0]["data"]["chunk_type"] == "HumanMessage"


def test_messages_mode_malformed_payload_becomes_graph_node() -> None:
    """Same fall-through for the payload-shape guard at the top — a
    malformed payload (not a 2-tuple) was previously emitted as
    llm.delta with a raw blob. Now it's graph.node so the client
    can't render junk as model output."""
    events = translate("messages", "not a tuple")
    assert events[0]["event"] == "graph.node"
    assert events[0]["data"]["kind"] == "messages"


def test_updates_mode_emits_tool_requested_with_assembled_args() -> None:
    """When the model node finishes a turn with tool_calls, the
    updates-mode payload carries the AIMessage with FULL assembled
    args. We emit one tool.requested per tool_call so the client can
    render rich per-tool info (`搜索 · 普吉岛雨季天气`). This is the
    single source of truth for tool args reaching the client —
    AIMessageChunk in messages mode floods on every chunk."""
    msg = AIMessage(
        content="",
        tool_calls=[
            {
                "id": "call_001",
                "name": "web.search",
                "args": {"query": "普吉岛雨季天气", "max_results": 5},
                "type": "tool_call",
            }
        ],
    )
    payload = {"model": {"messages": [msg]}}
    events = translate("updates", payload)
    requested = [e for e in events if e["event"] == "tool.requested"]
    assert len(requested) == 1
    assert requested[0]["data"] == {
        "tool_call_id": "call_001",
        "name": "web.search",
        "tool": "web.search",
        "arguments": {"query": "普吉岛雨季天气", "max_results": 5},
    }
    # And the catch-all graph.node still fires so nothing in the
    # existing event stream changes shape.
    assert any(e["event"] == "graph.node" for e in events)


def test_updates_mode_emits_one_tool_requested_per_parallel_call() -> None:
    """Parallel tool calls in a single model turn must each get their
    own tool.requested event. Regression target: the user.ask
    parallel-batch bug we fixed earlier — same shape of bundle,
    different downstream consumer."""
    msg = AIMessage(
        content="",
        tool_calls=[
            {"id": "c1", "name": "web.search", "args": {"query": "a"}, "type": "tool_call"},
            {"id": "c2", "name": "read_file", "args": {"path": "/tmp/x.txt"}, "type": "tool_call"},
            {"id": "c3", "name": "user.ask", "args": {"question": "?"}, "type": "tool_call"},
        ],
    )
    events = translate("updates", {"model": {"messages": [msg]}})
    requested = [e for e in events if e["event"] == "tool.requested"]
    assert [e["data"]["tool_call_id"] for e in requested] == ["c1", "c2", "c3"]
    assert [e["data"]["name"] for e in requested] == ["web.search", "read_file", "user.ask"]


def test_updates_mode_no_tool_requested_when_no_tool_calls() -> None:
    """An AIMessage with no tool_calls (just final text) must NOT
    produce a tool.requested. Otherwise every model turn would emit
    a spurious empty event."""
    msg = AIMessage(content="plain answer, no tools")
    events = translate("updates", {"model": {"messages": [msg]}})
    assert all(e["event"] != "tool.requested" for e in events)


def test_updates_mode_handles_non_ai_messages_in_delta_safely() -> None:
    """Tool messages, human nudges, etc. flow through updates mode
    without producing tool.requested events."""
    tm = ToolMessage(content="ok", tool_call_id="c1", name="time.now")
    events = translate("updates", {"tools": {"messages": [tm]}})
    assert all(e["event"] != "tool.requested" for e in events)
