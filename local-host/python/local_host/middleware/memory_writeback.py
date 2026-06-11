"""P6 memory writeback — at the end of a run, persist a short note to the
LangGraph BaseStore so future runs can recall what was done.

Phase 3' picked the trivial implementation: store the final user goal +
final assistant answer under namespace ("notes", "global"). The current
version keeps that legacy namespace for no-workspace runs, and isolates
workspace runs under ("notes", "workspace", <workspace-hash>) so one
project does not recall another project's notes. Phase 4'+ can swap in
LangMem (or an LLM-extracted "durable facts" pass).
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any

from langchain.agents.middleware import AgentMiddleware

log = logging.getLogger("local_host.middleware.memory_writeback")

NAMESPACE = ("notes", "global")
NOTES_NAMESPACE_PREFIX = ("notes",)


def memory_namespace_for_workspace(workspace_root: str | None) -> tuple[str, ...]:
    """Return the durable-memory namespace for a run.

    No-workspace runs keep the legacy global namespace for compatibility.
    Workspace runs get a stable hash namespace; the raw local path stays out of
    memory.search results and diagnostics.
    """
    if not workspace_root:
        return NAMESPACE
    try:
        normalized = str(Path(workspace_root).expanduser().resolve(strict=False))
    except (OSError, RuntimeError, ValueError):
        normalized = str(workspace_root)
    digest = sha256(normalized.encode("utf-8")).hexdigest()[:16]
    return ("notes", "workspace", digest)


def coerce_memory_namespace(value: Any) -> tuple[str, ...]:
    if isinstance(value, tuple) and value and all(isinstance(item, str) for item in value):
        namespace = value
    elif isinstance(value, list) and value and all(isinstance(item, str) for item in value):
        namespace = tuple(value)
    else:
        return NAMESPACE
    if namespace[0] != NOTES_NAMESPACE_PREFIX[0]:
        return NAMESPACE
    return namespace


class MemoryWritebackMiddleware(AgentMiddleware):
    def __init__(self, *, enabled: bool = True, namespace: tuple[str, ...] = NAMESPACE) -> None:
        super().__init__()
        self._enabled = enabled
        self._namespace = namespace

    async def aafter_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        if not self._enabled:
            return None
        store = getattr(runtime, "store", None)
        if store is None:
            return None

        messages = state.get("messages") or []
        latest_user = _latest_user_message(messages)
        last_ai = None
        for m in reversed(messages):
            if getattr(m, "type", None) == "ai":
                content = getattr(m, "content", "")
                if isinstance(content, str) and content.strip():
                    last_ai = m
                    break
        if latest_user is None or last_ai is None:
            return None

        note = {
            "kind": "run_note",
            "goal": _shorten(getattr(latest_user, "content", ""), 280),
            "answer": _shorten(getattr(last_ai, "content", ""), 540),
            "created_at": datetime.now(UTC).isoformat(),
        }
        try:
            await store.aput(self._namespace, uuid.uuid4().hex, note)
            for fact in _explicit_user_facts(messages):
                if not await _fact_exists_async(store, self._namespace, fact):
                    await store.aput(self._namespace, uuid.uuid4().hex, _fact_note(fact))
        except Exception as exc:
            log.warning("memory writeback failed: %s", exc)
            return None
        return None

    # Fallback sync path for the rare in-process invocation.
    def after_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        if not self._enabled:
            return None
        # Best-effort: only run if the store has a sync `put`.
        store = getattr(runtime, "store", None)
        if store is None or not hasattr(store, "put"):
            return None
        # Mirror the async version's shape.
        messages = state.get("messages") or []
        latest_user = _latest_user_message(messages)
        last_ai = None
        for m in reversed(messages):
            if getattr(m, "type", None) == "ai":
                content = getattr(m, "content", "")
                if isinstance(content, str) and content.strip():
                    last_ai = m
                    break
        if latest_user is None or last_ai is None:
            return None
        note = {
            "kind": "run_note",
            "goal": _shorten(getattr(latest_user, "content", ""), 280),
            "answer": _shorten(getattr(last_ai, "content", ""), 540),
            "created_at": datetime.now(UTC).isoformat(),
        }
        try:
            store.put(self._namespace, uuid.uuid4().hex, note)
            for fact in _explicit_user_facts(messages):
                if not _fact_exists_sync(store, self._namespace, fact):
                    store.put(self._namespace, uuid.uuid4().hex, _fact_note(fact))
        except Exception as exc:
            log.warning("memory writeback (sync) failed: %s", exc)
        return None


def _shorten(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "…"


def _latest_user_message(messages: list[Any]) -> Any | None:
    for message in reversed(messages):
        if getattr(message, "type", None) == "human":
            return message
    return None


def _explicit_user_facts(messages: list[Any]) -> list[str]:
    facts: list[str] = []
    for message in messages:
        if getattr(message, "type", None) != "human":
            continue
        content = getattr(message, "content", "")
        if not isinstance(content, str):
            continue
        for fact in _extract_explicit_facts(content):
            if fact not in facts:
                facts.append(fact)
    return facts


def _extract_explicit_facts(content: str) -> list[str]:
    facts: list[str] = []
    for line in content.splitlines():
        text = line.strip()
        if not text:
            continue
        for pattern in _EXPLICIT_MEMORY_PATTERNS:
            match = pattern.search(text)
            if not match:
                continue
            fact = _clean_fact(match.group("fact"))
            if fact:
                facts.append(fact)
            break
    return facts


def _clean_fact(value: str) -> str:
    fact = re.sub(r"\s+", " ", value).strip(" \t:-：")
    return _shorten(fact, 360)


def _fact_note(fact: str) -> dict[str, Any]:
    return {
        "kind": "user_fact",
        "fact": fact,
        "source": "explicit_user_request",
        "created_at": datetime.now(UTC).isoformat(),
    }


async def _fact_exists_async(store: Any, namespace: tuple[str, ...], fact: str) -> bool:
    if not hasattr(store, "asearch"):
        return False
    try:
        items = await store.asearch(namespace, query=fact, limit=20)
    except Exception as exc:
        log.debug("memory fact dedupe search failed: %s", exc)
        return False
    return _items_include_fact(items, fact)


def _fact_exists_sync(store: Any, namespace: tuple[str, ...], fact: str) -> bool:
    if not hasattr(store, "search"):
        return False
    try:
        items = store.search(namespace, query=fact, limit=20)
    except Exception as exc:
        log.debug("memory fact dedupe search (sync) failed: %s", exc)
        return False
    return _items_include_fact(items, fact)


def _items_include_fact(items: Any, fact: str) -> bool:
    for item in items or []:
        value = getattr(item, "value", None)
        if (
            isinstance(value, dict)
            and value.get("kind") == "user_fact"
            and value.get("fact") == fact
        ):
            return True
    return False


_EXPLICIT_MEMORY_PATTERNS = [
    re.compile(r"^(?:please\s+)?remember(?:\s+that)?[:：\s]+(?P<fact>.+)$", re.IGNORECASE),
    re.compile(r"^(?:请|帮我)?记住[:：\s]+(?P<fact>.+)$"),
]
