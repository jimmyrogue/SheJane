"""Explicit, workspace-scoped durable memory tools.

Memory is not written as a hidden end-of-run side effect. The model must call
``memory.write`` after the user explicitly asks it to remember a fact; every
write therefore crosses the normal tool review and durable receipt path.

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

import re
import uuid
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Annotated, Any

from langchain.tools import ToolRuntime
from langchain_core.tools import tool
from langgraph.prebuilt import InjectedStore
from langgraph.store.base import BaseStore

from ..auth import LOCAL_OWNER_PRINCIPAL_ID

NAMESPACE = ("notes", "global")
NOTES_NAMESPACE_PREFIX = ("notes",)


def memory_namespace_for_workspace(
    workspace_root: str | None,
    principal_id: str | None,
) -> tuple[str, ...]:
    """Return an opaque namespace owned by one authenticated principal."""
    if not principal_id:
        raise ValueError("memory principal is required")
    principal_hash = sha256(principal_id.encode()).hexdigest()
    if not workspace_root:
        return ("notes", "principal", principal_hash, "global")
    try:
        normalized = str(Path(workspace_root).expanduser().resolve(strict=False))
    except (OSError, RuntimeError, ValueError):
        normalized = str(workspace_root)
    return (
        "notes",
        "principal",
        principal_hash,
        "workspace",
        sha256(normalized.encode()).hexdigest(),
    )


def memory_namespace_prefix(principal_id: str) -> tuple[str, ...]:
    principal_hash = sha256(principal_id.encode()).hexdigest()
    return ("notes", "principal", principal_hash)


def extract_memory_write_facts(
    user_input: str,
    *,
    history: list[dict[str, str]] | None = None,
) -> tuple[str, ...]:
    """Extract explicit positive memory directives from trusted user input.

    Directives must begin a line (optionally with a polite prefix). This keeps
    quoted/model-generated text and negative instructions from minting a write
    capability. The tool must later submit the exact extracted fact.
    """
    current = str(user_input or "").strip()
    for pattern in _MEMORY_NAME_FACT_PATTERNS:
        match = pattern.fullmatch(current)
        if match:
            return (match.group(0).strip(),)
    if _MEMORY_CONFIRMATION.fullmatch(current):
        for message in reversed(history or []):
            if str(message.get("role") or "").lower() != "user":
                continue
            fact = " ".join(str(message.get("content") or "").split())
            return (fact,) if fact and len(fact) <= 2_000 else ()
        return ()

    facts: list[str] = []
    negative = re.compile(
        r"^\s*(?:(?:请|请你|麻烦你?)\s*)?(?:不要|别|无需|不必|禁止).{0,8}"
        r"(?:记住|保存|写入)|^\s*(?:please\s+)?(?:do\s+not|don't|never)\s+"
        r"(?:remember|save|store)\b",
        re.IGNORECASE,
    )
    directives = (
        re.compile(
            r"^\s*(?:(?:请|请你|帮我|麻烦你?)\s*)?"
            r"(?:记住|保存(?:到)?记忆|写入(?:到)?记忆)\s*[：:，,]?\s*(.+?)\s*$",
            re.IGNORECASE,
        ),
        re.compile(
            r"^\s*(?:please\s+)?(?:remember(?:\s+that)?|"
            r"save\s+(?:this|the following)(?:\s+(?:to memory|for later))?|"
            r"store\s+(?:this|the following)(?:\s+(?:in memory|for later))?)"
            r"\s*[：:,\-]?\s+(.+?)\s*$",
            re.IGNORECASE,
        ),
    )
    lines = [line for line in str(user_input or "").splitlines() if line.strip()]
    if not lines or any(line.lstrip().startswith((">", "```", "~~~")) for line in lines):
        return ()
    for line in lines:
        if negative.search(line):
            return ()
        matched = False
        for pattern in directives:
            match = pattern.match(line)
            if match:
                fact = " ".join(match.group(1).split())
                if _MEMORY_NAME_REFERENCE.fullmatch(fact):
                    fact = _resolve_name_reference(history)
                    if not fact:
                        return ()
                if fact and len(fact) <= 2_000 and fact not in facts:
                    facts.append(fact)
                matched = True
                break
        # A capability message contains only direct, positive memory
        # directives. Explanations, examples, quoted passages, or mixed tasks
        # require a separate explicit memory command from the user.
        if not matched:
            return ()
    return tuple(facts)


_MEMORY_CONFIRMATION = re.compile(
    r"\s*(?:(?:是的|好的?|可以|对)[，,。.!！\s]*)?"
    r"(?:记录(?:一下|下来)?|记住(?:吧|这个|它)?|保存(?:一下|吧|这个|它)?|存一下)"
    r"[。.!！\s]*|\s*(?:(?:yes|ok(?:ay)?)[,\s]*)?"
    r"(?:remember|save|record)\s+(?:it|that)[.!\s]*",
    re.IGNORECASE,
)
_MEMORY_NAME_REFERENCE = re.compile(
    r"(?:我的)?(?:名字|姓名|称呼)|my\s+name",
    re.IGNORECASE,
)
_MEMORY_NAME_FACT_PATTERNS = (
    re.compile(
        r"(?:我的(?:名字|姓名|称呼)\s*(?:是|叫|为|[:：])|我叫)\s*[^，。！？,;；\n]+",
        re.IGNORECASE,
    ),
    re.compile(r"my\s+name\s+(?:is|[:])\s*[^,.!?;\n]+", re.IGNORECASE),
)


def _resolve_name_reference(history: list[dict[str, str]] | None) -> str:
    for message in reversed(history or []):
        if str(message.get("role") or "").lower() != "user":
            continue
        content = " ".join(str(message.get("content") or "").split())
        for pattern in _MEMORY_NAME_FACT_PATTERNS:
            match = pattern.search(content)
            if match:
                return match.group(0).strip()
    return ""


def make_memory_search_tool(namespace: tuple[str, ...] | None = None):
    @tool("memory.search")
    async def memory_search(
        query: str,
        limit: int = 5,
        runtime: ToolRuntime[Any] = None,  # type: ignore[assignment]
        store: Annotated[BaseStore, InjectedStore()] = None,  # type: ignore[assignment]
    ) -> dict[str, Any]:
        """Search durable facts explicitly saved for this workspace.

        Args:
            query: Free-text search query (keyword/substring matching).
            limit: Max number of results to return (default 5, clamped 1-20).

        Returns:
            {"ok": "true", "count": "<int>", "results": [{key, value, created_at, updated_at}, ...]}
            On no store: {"ok": "false", "error": "memory store not configured"}.
        """
        if store is None:
            return {"ok": "false", "error": "memory store not configured for this run"}

        context = getattr(runtime, "context", None)
        try:
            active_namespace = namespace or memory_namespace_for_workspace(
                getattr(context, "workspace_root", None),
                getattr(context, "principal_id", None),
            )
        except ValueError as exc:
            return {"ok": "false", "error": str(exc)}
        requested_limit = _clamp_limit(limit)
        try:
            search_namespaces = [active_namespace]
            if namespace is None:
                principal_id = getattr(context, "principal_id", None)
                global_namespace = memory_namespace_for_workspace(
                    None,
                    principal_id,
                )
                if global_namespace not in search_namespaces:
                    search_namespaces.append(global_namespace)
                if principal_id == LOCAL_OWNER_PRINCIPAL_ID:
                    search_namespaces.append(NAMESPACE)
            items = []
            for search_namespace in search_namespaces:
                found = await store.asearch(
                    search_namespace,
                    query=query,
                    limit=_candidate_limit(requested_limit),
                )
                items.extend(
                    item
                    for item in found
                    if search_namespace != NAMESPACE
                    or (isinstance(item.value, dict) and item.value.get("kind") == "user_fact")
                )
        except Exception as exc:
            return {"ok": "false", "error": f"{type(exc).__name__}: {exc}"}

        results: list[dict[str, Any]] = []
        seen_facts: set[str] = set()
        for item in sorted(items, key=_memory_result_sort_key):
            value = item.value if isinstance(item.value, dict) else {}
            fact = value.get("fact") if value.get("kind") == "user_fact" else None
            if isinstance(fact, str):
                if fact in seen_facts:
                    continue
                seen_facts.add(fact)
            results.append(
                {
                    "key": item.key,
                    "value": item.value,
                    "created_at": item.created_at.isoformat() if item.created_at else "",
                    "updated_at": item.updated_at.isoformat() if item.updated_at else "",
                }
            )
            if len(results) >= requested_limit:
                break
        return {"ok": "true", "count": str(len(results)), "results": results}

    return memory_search


@tool("memory.write")
async def memory_write(
    fact: str,
    runtime: ToolRuntime[Any] = None,  # type: ignore[assignment]
    store: Annotated[BaseStore, InjectedStore()] = None,  # type: ignore[assignment]
) -> dict[str, Any]:
    """Save one durable fact only when the user explicitly asks to remember it.

    Copy the authorized fact text from the user's memory directive exactly.
    Do not rephrase it, change its point of view, or add punctuation.
    Do not claim the fact was saved unless this tool returns ok=true.

    Args:
        fact: The exact authorized fact text from the user's memory directive.
            Do not infer, rephrase, or save facts without an explicit user request.
    """
    normalized = " ".join(str(fact or "").split())
    if not normalized:
        return {"ok": False, "error": "fact must not be empty"}
    if len(normalized) > 2_000:
        return {"ok": False, "error": "fact exceeds 2000 characters"}
    if store is None:
        return {"ok": False, "error": "memory store not configured for this run"}
    context = getattr(runtime, "context", None)
    allowed_facts = tuple(getattr(context, "memory_write_facts", ()) or ())
    if normalized not in allowed_facts:
        return {
            "ok": False,
            "error_code": "memory_fact_not_authorized",
            "error": "fact was not authorized by the current user input",
            "recoverable": True,
            "retryable": False,
        }
    try:
        namespace = memory_namespace_for_workspace(
            getattr(context, "workspace_root", None),
            getattr(context, "principal_id", None),
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    try:
        existing = await store.asearch(namespace, query=normalized, limit=50)
        if any(
            isinstance(item.value, dict)
            and item.value.get("kind") == "user_fact"
            and item.value.get("fact") == normalized
            for item in existing
        ):
            return {"ok": True, "saved": False, "reason": "already_exists"}
        key = uuid.uuid4().hex
        await store.aput(
            namespace,
            key,
            {
                "kind": "user_fact",
                "fact": normalized,
                "created_at": datetime.now(UTC).isoformat(),
            },
        )
        return {"ok": True, "saved": True, "key": key}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


memory_search = make_memory_search_tool()
MEMORY_TOOLS = [memory_search, memory_write]


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
