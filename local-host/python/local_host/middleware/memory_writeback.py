"""P6 memory writeback — at the end of a run, persist a short note to the
LangGraph BaseStore so future runs can recall what was done.

Phase 3' picks the trivial implementation: store the final user goal +
final assistant answer + run_id under namespace ("notes", "global"). Phase
4'+ can swap in LangMem (or an LLM-extracted "durable facts" pass).
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from langchain.agents.middleware import AgentMiddleware

log = logging.getLogger("local_host.middleware.memory_writeback")

NAMESPACE = ("notes", "global")


class MemoryWritebackMiddleware(AgentMiddleware):
    async def aafter_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        store = getattr(runtime, "store", None)
        if store is None:
            return None

        messages = state.get("messages") or []
        # Find the first human message and the last AI message with content.
        first_user = next(
            (m for m in messages if getattr(m, "type", None) == "human"),
            None,
        )
        last_ai = None
        for m in reversed(messages):
            if getattr(m, "type", None) == "ai":
                content = getattr(m, "content", "")
                if isinstance(content, str) and content.strip():
                    last_ai = m
                    break
        if first_user is None or last_ai is None:
            return None

        note = {
            "goal": _shorten(getattr(first_user, "content", ""), 280),
            "answer": _shorten(getattr(last_ai, "content", ""), 540),
            "created_at": datetime.now(UTC).isoformat(),
        }
        try:
            await store.aput(NAMESPACE, uuid.uuid4().hex, note)
        except Exception as exc:
            log.warning("memory writeback failed: %s", exc)
            return None
        return None

    # Fallback sync path for the rare in-process invocation.
    def after_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        # Best-effort: only run if the store has a sync `put`.
        store = getattr(runtime, "store", None)
        if store is None or not hasattr(store, "put"):
            return None
        # Mirror the async version's shape.
        messages = state.get("messages") or []
        first_user = next((m for m in messages if getattr(m, "type", None) == "human"), None)
        last_ai = None
        for m in reversed(messages):
            if getattr(m, "type", None) == "ai":
                content = getattr(m, "content", "")
                if isinstance(content, str) and content.strip():
                    last_ai = m
                    break
        if first_user is None or last_ai is None:
            return None
        note = {
            "goal": _shorten(getattr(first_user, "content", ""), 280),
            "answer": _shorten(getattr(last_ai, "content", ""), 540),
            "created_at": datetime.now(UTC).isoformat(),
        }
        try:
            store.put(NAMESPACE, uuid.uuid4().hex, note)
        except Exception as exc:
            log.warning("memory writeback (sync) failed: %s", exc)
        return None


def _shorten(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "…"
