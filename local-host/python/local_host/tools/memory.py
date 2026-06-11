"""memory.search — recall past run notes during the current run.

Closes the long-term memory loop: `MemoryWritebackMiddleware` writes
`{goal, answer}` to the current run's memory namespace after each run; this
tool lets the agent **query** that namespace while it's still running, so a
follow-up question can leverage what was learned in a previous session without
crossing workspace boundaries.

Implementation notes
--------------------
- `make_memory_search_tool()` binds the run's namespace in a closure so the
  model cannot choose or even see a namespace argument.
- `Annotated[BaseStore, InjectedStore()]` is the LangGraph mechanism for
  giving a tool the runtime's `store` without exposing it on the LLM-
  visible argument schema.
- `asearch` does keyword/substring matching when no embedding index is
  configured (our current setup). Adding `SqliteIndexConfig` later would
  give it semantic search for free.
- We overfetch a bounded candidate set before local re-ranking. Otherwise a
  small model-supplied limit can cut explicit user facts out of the candidate
  list before `kind=user_fact` priority has a chance to apply.
- Within the same memory kind, newer records rank first. This is a cheap
  stale-fact mitigation until we add semantic fact merging / verification.
- The result list is intentionally compact (key + value + timestamps)
  so the agent doesn't blow context on irrelevant fields.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

from langchain_core.tools import tool
from langgraph.prebuilt import InjectedStore
from langgraph.store.base import BaseStore

from ..middleware.memory_writeback import NAMESPACE


def make_memory_search_tool(namespace: tuple[str, ...] = NAMESPACE):
    @tool("memory.search")
    async def memory_search(
        query: str,
        limit: int = 5,
        store: Annotated[BaseStore, InjectedStore()] = None,  # type: ignore[assignment]
    ) -> dict[str, Any]:
        """Search durable notes written by past runs in this workspace.

        Args:
            query: Free-text search query (keyword/substring matching).
            limit: Max number of results to return (default 5, clamped 1-20).

        Returns:
            {"ok": "true", "count": "<int>", "results": [{key, value, created_at, updated_at}, ...]}
            On no store: {"ok": "false", "error": "memory store not configured"}.
        """
        if store is None:
            return {"ok": "false", "error": "memory store not configured for this run"}

        requested_limit = _clamp_limit(limit)
        try:
            items = await store.asearch(
                namespace, query=query, limit=_candidate_limit(requested_limit)
            )
        except Exception as exc:
            return {"ok": "false", "error": f"{type(exc).__name__}: {exc}"}

        results: list[dict[str, Any]] = []
        for item in sorted(items, key=_memory_result_sort_key)[:requested_limit]:
            results.append(
                {
                    "key": item.key,
                    "value": item.value,
                    "created_at": item.created_at.isoformat() if item.created_at else "",
                    "updated_at": item.updated_at.isoformat() if item.updated_at else "",
                }
            )
        return {"ok": "true", "count": str(len(results)), "results": results}

    return memory_search


memory_search = make_memory_search_tool(NAMESPACE)
MEMORY_TOOLS = [memory_search]


def _clamp_limit(value: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = 5
    return max(1, min(parsed, 20))


def _candidate_limit(requested_limit: int) -> int:
    requested = max(1, min(int(requested_limit), 20))
    return max(20, min(requested * 4, 50))


def _memory_result_sort_key(item: Any) -> tuple[int, float]:
    value = getattr(item, "value", None)
    if isinstance(value, dict) and value.get("kind") == "user_fact":
        return (0, -_memory_item_timestamp(item))
    return (1, -_memory_item_timestamp(item))


def _memory_item_timestamp(item: Any) -> float:
    raw = getattr(item, "updated_at", None) or getattr(item, "created_at", None)
    if isinstance(raw, datetime):
        dt = raw
    else:
        dt = _parse_memory_datetime(raw)
        value = getattr(item, "value", None)
        if dt is None and isinstance(value, dict):
            raw = value.get("updated_at") or value.get("created_at")
            dt = _parse_memory_datetime(raw)
    if dt is None:
        return 0.0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.timestamp()


def _parse_memory_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None
