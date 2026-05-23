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
from collections.abc import Iterable
from typing import Any

from langchain_core.load.dump import dumps as lc_dumps
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage


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
        # Malformed payload — surface as a generic graph.node so the
        # client doesn't render arbitrary state as model output. (See
        # the trailing fall-through at the end of this function for
        # the same rationale.)
        return [{"event": "graph.node", "data": {"kind": "messages", "raw": _safe_dump(payload)}}]
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
            out.append({"event": "llm.error", "data": {"message": str(backend_error)}})

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

    # Catch-all for any other chunk type LangGraph streams in messages
    # mode (HumanMessageChunk, SystemMessage, or middleware-injected
    # custom types). Previously we wrapped these as `llm.delta`, which
    # meant a middleware appending e.g. a HumanMessage to state would
    # surface as if the assistant had streamed its content — caused the
    # OutputGuard retry-nudge regression where "Your last response was
    # empty…" was emitted both as an llm.delta and persisted on the
    # message. Anything not from the model is now a graph.node event so
    # the client never confuses it with assistant content.
    return [
        {
            "event": "graph.node",
            "data": {
                "kind": "messages",
                "chunk_type": type(chunk).__name__,
                "payload": _safe_dump(chunk),
            },
        }
    ]


# ---- updates mode ----

#  Updates payload is roughly `{node_name: {state_field: value, …}}`. We
#  emit one `graph.node` per node — tool completions are sourced from
#  `messages` mode only so we don't double-emit (see docstring below).


def _translate_updates(payload: Any) -> list[dict[str, Any]]:
    """Emit one `graph.node` per node update.

    Important: do NOT also emit per-ToolMessage `tool.completed` events
    here. An earlier version of this function inspected the `tools` node
    update and emitted one tool.completed per ToolMessage inside —
    intended as best-effort tool observation. But LangGraph's `messages`
    stream mode already yields the same ToolMessage (handled in
    `_translate_messages`), so every tool ended up reported twice with
    different daemon-side event IDs. Client-side dedupe is keyed on
    event ID, so the duplicates leaked into `message.agentEvents` and
    caused `operationCountsLabel` to double-count ("搜索 8 次" instead
    of "搜索 4 次"). messages-mode is the single source of truth.
    """
    if not isinstance(payload, dict):
        return [{"event": "graph.node", "data": _safe_dump(payload)}]

    out: list[dict[str, Any]] = []
    for node, delta in payload.items():
        # When the model node finishes a turn, its delta carries an
        # AIMessage with the fully assembled `tool_calls` list. Emit one
        # `tool.requested` event per tool_call so the client renderer can
        # show rich per-tool info ("搜索 · 普吉岛雨季天气", "读取 · App.tsx").
        #
        # Why here and not in `_translate_messages`: AIMessageChunk
        # surfaces tool_calls for any chunk where it can parse a name,
        # which floods the wire with spam mid-args. The updates-mode
        # delta fires once per model turn with the assembled tool_calls
        # — a clean single-emit point. Same "single source of truth"
        # discipline that fixed the duplicate-tool.completed bug.
        out.extend(_tool_requested_events_from_update(delta))
        out.append(
            {
                "event": "graph.node",
                "data": {"node": node, "delta": _safe_dump(delta)},
            }
        )
    return out


def _tool_requested_events_from_update(delta: Any) -> list[dict[str, Any]]:
    """Pull `tool.requested` events out of an update delta. Each event
    carries `{tool_call_id, name, tool, args}` for one finalized tool
    call. Returns [] when the delta has no AIMessage with tool_calls."""
    if not isinstance(delta, dict):
        return []
    messages = delta.get("messages")
    if not isinstance(messages, list):
        return []
    out: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, AIMessage):
            continue
        for tool_call in getattr(message, "tool_calls", None) or []:
            if not isinstance(tool_call, dict):
                continue
            name = str(tool_call.get("name") or "")
            if not name:
                continue
            args = tool_call.get("args")
            if not isinstance(args, dict):
                args = {}
            out.append(
                {
                    "event": "tool.requested",
                    # Field name `arguments` (not `args`) matches the wire
                    # convention used by the existing HITL permission flow
                    # — the client renderer reads payload.arguments in
                    # chatStore.ts:toolDetail. Keeping one field name
                    # across paths saves the client from having to
                    # normalize.
                    "data": {
                        "tool_call_id": str(tool_call.get("id") or ""),
                        "name": name,
                        "tool": name,  # alias the renderer uses for headlines
                        "arguments": args,
                    },
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
