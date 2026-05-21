"""memory.search — recall past run notes during the current run.

Closes the long-term memory loop: `MemoryWritebackMiddleware` writes
`{goal, answer}` to `("notes", "global")` after each run; this tool lets
the agent **query** that namespace while it's still running, so a
follow-up question can leverage what was learned in a previous session.

Implementation notes
--------------------
- `Annotated[BaseStore, InjectedStore()]` is the LangGraph mechanism for
  giving a tool the runtime's `store` without exposing it on the LLM-
  visible argument schema.
- `asearch` does keyword/substring matching when no embedding index is
  configured (our current setup). Adding `SqliteIndexConfig` later would
  give it semantic search for free.
- The result list is intentionally compact (key + value + timestamps)
  so the agent doesn't blow context on irrelevant fields.
"""

from __future__ import annotations

from typing import Annotated, Any

from langchain_core.tools import tool
from langgraph.prebuilt import InjectedStore
from langgraph.store.base import BaseStore


NAMESPACE = ("notes", "global")


@tool("memory.search")
async def memory_search(
    query: str,
    limit: int = 5,
    store: Annotated[BaseStore, InjectedStore()] = None,  # type: ignore[assignment]
) -> dict[str, Any]:
    """Search durable notes written by past runs.

    Args:
        query: Free-text search query (keyword/substring matching).
        limit: Max number of results to return (default 5).

    Returns:
        {"ok": "true", "count": "<int>", "results": [{key, value, created_at, updated_at}, ...]}
        On no store: {"ok": "false", "error": "memory store not configured"}.
    """
    if store is None:
        return {"ok": "false", "error": "memory store not configured for this run"}

    try:
        items = await store.asearch(NAMESPACE, query=query, limit=limit)
    except Exception as exc:  # noqa: BLE001 — store implementations vary widely
        return {"ok": "false", "error": f"{type(exc).__name__}: {exc}"}

    results: list[dict[str, Any]] = []
    for item in items:
        results.append(
            {
                "key": item.key,
                "value": item.value,
                "created_at": item.created_at.isoformat() if item.created_at else "",
                "updated_at": item.updated_at.isoformat() if item.updated_at else "",
            }
        )
    return {"ok": "true", "count": str(len(results)), "results": results}


MEMORY_TOOLS = [memory_search]
