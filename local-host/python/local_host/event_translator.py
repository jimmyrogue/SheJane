"""Translate LangGraph stream events into client-friendly SSE event types.

LangGraph's `astream(stream_mode=[…])` returns `(mode, payload)` tuples
whose payload shape depends on mode:

  * messages → (AIMessageChunk | ToolMessageChunk | …, metadata: dict)
  * updates  → {node_name: state_delta}
  * custom   → whatever the writer pushed

For the SSE protocol the client consumes we want stable, narrow event
names that don't leak LangGraph internals. This module is the single
place that translation happens.

Client SSE event types (see docs/client-sse-protocol.md):

  llm.token            — one streamed token of assistant content
  llm.tool_call_chunk  — partial JSON args for a tool call being assembled
  llm.reasoning        — DeepSeek-style reasoning content chunk
  tool.start           — tool execution beginning (best-effort detection)
  tool.end             — tool execution result observed
  graph.node           — generic node transition (catch-all)
  agent.custom         — middleware-emitted custom payload
"""

from __future__ import annotations

import json
from typing import Any, Iterable

from langchain_core.load.dump import dumps as lc_dumps
from langchain_core.messages import AIMessageChunk, ToolMessage


def translate(kind: str, payload: Any) -> list[dict[str, Any]]:
    """Return zero or more `{event, data}` dicts for a single stream tuple.

    The translator never raises — anything it can't classify becomes a
    `graph.node` event with the raw serialized payload, so the daemon's
    event log stays complete even when an unknown mode is added by
    LangGraph in the future.
    """
    if kind == "messages":
        return _translate_messages(payload)
    if kind == "updates":
        return _translate_updates(payload)
    if kind == "custom":
        return [
            {"event": "agent.custom", "data": _safe_dump(payload)},
        ]
    return [{"event": "graph.node", "data": {"kind": kind, "payload": _safe_dump(payload)}}]


# ---- messages mode ----


def _translate_messages(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, tuple) or len(payload) != 2:
        return [{"event": "llm.token", "data": {"raw": _safe_dump(payload)}}]
    chunk, _metadata = payload

    if isinstance(chunk, AIMessageChunk):
        out: list[dict[str, Any]] = []
        content = chunk.content
        if isinstance(content, str) and content:
            out.append({"event": "llm.token", "data": {"content": content}})

        reasoning = chunk.additional_kwargs.get("reasoning_content")
        if reasoning:
            out.append({"event": "llm.reasoning", "data": {"content": reasoning}})

        for tc in chunk.tool_call_chunks or []:
            tool_name = tc.get("name")
            # Surface task() spawns (deepagents SubAgentMiddleware) as a
            # narrower client-facing event so the UI can render a subagent
            # tree without having to inspect tool_call schemas.
            if tool_name == "task":
                out.append(
                    {
                        "event": "subagent.spawned",
                        "data": {
                            "id": tc.get("id"),
                            "args_delta": tc.get("args"),
                            "index": tc.get("index"),
                        },
                    }
                )
            else:
                out.append(
                    {
                        "event": "llm.tool_call_chunk",
                        "data": {
                            "id": tc.get("id"),
                            "name": tool_name,
                            "args_delta": tc.get("args"),
                            "index": tc.get("index"),
                        },
                    }
                )

        backend_error = chunk.additional_kwargs.get("backend_error")
        if backend_error:
            out.append(
                {"event": "llm.error", "data": {"message": str(backend_error)}}
            )

        return out

    if isinstance(chunk, ToolMessage):
        event_name = "subagent.completed" if chunk.name == "task" else "tool.end"
        return [
            {
                "event": event_name,
                "data": {
                    "tool_call_id": chunk.tool_call_id,
                    "name": chunk.name,
                    "content": _stringify(chunk.content),
                },
            }
        ]

    return [{"event": "llm.token", "data": {"raw": _safe_dump(chunk)}}]


# ---- updates mode ----

#  Updates payload is roughly `{node_name: {state_field: value, …}}`. We
#  emit one `graph.node` per node, with the most common fields lifted to
#  the top level so clients don't have to dig.

_NODE_NAME_TOOLS = {"tools", "ToolNode"}


def _translate_updates(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return [{"event": "graph.node", "data": _safe_dump(payload)}]

    out: list[dict[str, Any]] = []
    for node, delta in payload.items():
        delta_dict = delta if isinstance(delta, dict) else {"value": delta}
        # Best-effort tool start detection: ToolNode's updates carry the
        # tool message(s) it just produced. We surface them as tool.end
        # only — there's no "start" hook in `updates` mode (would need
        # before/after callback or wrap_tool_call middleware for that).
        if node in _NODE_NAME_TOOLS and "messages" in delta_dict:
            for m in delta_dict["messages"] or []:
                if isinstance(m, ToolMessage):
                    out.append(
                        {
                            "event": "tool.end",
                            "data": {
                                "tool_call_id": m.tool_call_id,
                                "name": m.name,
                                "content": _stringify(m.content),
                            },
                        }
                    )
            # Still also emit a generic graph.node for completeness
        out.append(
            {
                "event": "graph.node",
                "data": {"node": node, "delta": _safe_dump(delta)},
            }
        )
    return out


# ---- helpers ----


def _safe_dump(payload: Any) -> Any:
    try:
        return json.loads(lc_dumps(payload))
    except Exception:
        try:
            return json.loads(json.dumps(payload, default=str))
        except Exception:
            return {"repr": str(payload)}


def _stringify(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                parts.append(str(part.get("text", "")))
            else:
                parts.append(str(part))
        return "".join(parts)
    return str(content)


def translate_many(events: Iterable[tuple[str, Any]]) -> list[dict[str, Any]]:
    """Convenience: translate a batch of (mode, payload) tuples."""
    out: list[dict[str, Any]] = []
    for kind, payload in events:
        out.extend(translate(kind, payload))
    return out
