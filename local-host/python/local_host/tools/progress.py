"""task.progress — durable feature ledger for long-running work."""

from __future__ import annotations

import json
from typing import Any

from langchain.tools import ToolRuntime
from langchain_core.tools import tool

from ..store.sqlite import LocalStore

_ALLOWED_STATUS = {"planned", "in_progress", "blocked", "complete", "verified"}


def make_progress_tool(store: LocalStore | None = None, run_id: str | None = None):
    """Bind task.progress to one run's local artifact store."""

    @tool("task.progress")
    async def task_progress(
        summary: str,
        runtime: ToolRuntime[Any] = None,  # type: ignore[assignment]
        status: str = "in_progress",
        acceptance_criteria: list[str] | None = None,
        decisions: list[str] | None = None,
        files_touched: list[str] | None = None,
        validation_commands: list[str] | None = None,
        unresolved_risks: list[str] | None = None,
        next_actions: list[str] | None = None,
    ) -> dict[str, Any]:
        """Record a durable progress ledger entry for this run.

        Use this after planning, after important design decisions, before
        pausing, and after validation. Keep entries concise and factual.
        """
        context = getattr(runtime, "context", None)
        active_store = store or getattr(context, "store", None)
        active_run_id = run_id or getattr(context, "run_id", None)
        if active_store is None or not active_run_id:
            return {"ok": "false", "error": "progress ledger is not bound to a run"}
        summary_text = summary.strip()
        if not summary_text:
            return {"ok": "false", "error": "summary required"}
        normalized_status = status.strip().lower() or "in_progress"
        if normalized_status not in _ALLOWED_STATUS:
            normalized_status = "in_progress"

        payload = {
            "summary": summary_text,
            "status": normalized_status,
            "acceptance_criteria": _clean_list(acceptance_criteria),
            "decisions": _clean_list(decisions),
            "files_touched": _clean_list(files_touched),
            "validation_commands": _clean_list(validation_commands),
            "unresolved_risks": _clean_list(unresolved_risks),
            "next_actions": _clean_list(next_actions),
        }
        artifact = await active_store.create_artifact(
            run_id=active_run_id,
            kind="progress_ledger",
            title="Progress ledger",
            content=json.dumps(payload, ensure_ascii=False),
            content_type="application/json",
            tool_name="task.progress",
            metadata=payload,
        )
        return {
            "ok": "true",
            "artifact_id": artifact["id"],
            "status": normalized_status,
            "summary": summary_text,
        }

    return task_progress


def _clean_list(values: list[str] | None) -> list[str]:
    if not values:
        return []
    out: list[str] = []
    for value in values:
        text = str(value).strip()
        if text:
            out.append(text[:500])
    return out[:20]


PROGRESS_TOOLS = [make_progress_tool()]
