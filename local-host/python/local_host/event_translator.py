"""Translate LangGraph stream events into client-friendly SSE event types.

LangGraph's `astream(stream_mode=[…])` returns `(mode, payload)` tuples
whose payload shape depends on mode:

  * messages → (AIMessageChunk | ToolMessageChunk | …, metadata: dict)
  * updates  → {node_name: state_delta}
  * custom   → whatever the writer pushed

For the SSE protocol the client consumes we want stable, narrow event
names that don't leak LangGraph internals. This module is the single
place that translation happens.

Client SSE event types — names MUST match what the TypeScript
streamTransport.ts and chatStore.ts switch on (see
client/src/shared/streaming/streamTransport.ts:61 and
client/src/features/chat/chatStore.ts):

  llm.delta            — one streamed token of assistant content (was
                         `llm.token` pre-Block-3 — client looks for
                         `llm.delta`)
  llm.tool_call_chunk  — partial JSON args for a tool call being assembled
  llm.reasoning        — DeepSeek-style reasoning content chunk
  tool.requested       — tool about to run (emitted when the model's
                         tool_call_chunk finalizes with a name)
  tool.completed       — tool result observed (was `tool.end` pre-Block-3
                         — client looks for `tool.completed`)
  tool.failed          — tool result observed with status="error"
  graph.node           — generic node transition (catch-all)
  agent.custom         — middleware-emitted custom payload
  subagent.spawned     — deepagents task() tool spawning a subagent
  subagent.completed   — subagent finished
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
        return [{"event": "llm.delta", "data": {"raw": _safe_dump(payload)}}]
    chunk, _metadata = payload

    if isinstance(chunk, AIMessageChunk):
        out: list[dict[str, Any]] = []
        content = chunk.content
        if isinstance(content, str) and content:
            # `llm.delta` is the canonical content-stream event; the
            # client's streamAgentSSE() reads `payload.content` to
            # append to the in-flight assistant message bubble.
            out.append({"event": "llm.delta", "data": {"content": content}})

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

        # `tool.requested` (pre-call signal) is best emitted from a
        # `wrap_tool_call` middleware hook in `agent/builder.py` so we
        # can distinguish the truly final tool_call from partial
        # streaming chunks — AIMessageChunk surfaces `tool_calls` for
        # any chunk where it can parse a name, which floods the wire
        # with spam mid-args. Deferred to a follow-up block; the client
        # falls back to `tool.completed` for the "tool ran" headline.

        backend_error = chunk.additional_kwargs.get("backend_error")
        if backend_error:
            out.append(
                {"event": "llm.error", "data": {"message": str(backend_error)}}
            )

        return out

    if isinstance(chunk, ToolMessage):
        # `tool.completed` is the canonical name the client expects
        # (chatStore.ts:155). Erroring tool messages get split to
        # `tool.failed` so the UI can render them differently.
        status = getattr(chunk, "status", None)
        is_failed = status == "error"
        if chunk.name == "task":
            event_name = "subagent.completed"
        elif is_failed:
            event_name = "tool.failed"
        else:
            event_name = "tool.completed"
        return [
            {
                "event": event_name,
                "data": {
                    "tool_call_id": chunk.tool_call_id,
                    "name": chunk.name,
                    "tool": chunk.name,  # client uses `tool` key for headline
                    "content": _stringify(chunk.content),
                    "status": status or "ok",
                },
            }
        ]

    return [{"event": "llm.delta", "data": {"raw": _safe_dump(chunk)}}]


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
                    m_status = getattr(m, "status", None)
                    out.append(
                        {
                            "event": "tool.failed"
                            if m_status == "error"
                            else "tool.completed",
                            "data": {
                                "tool_call_id": m.tool_call_id,
                                "name": m.name,
                                "tool": m.name,
                                "content": _stringify(m.content),
                                "status": m_status or "ok",
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
