"""Progress-ledger handoff helpers shared by diagnostics and run pauses."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

LEDGER_DIRTY_EVENT_TYPES = {
    "tool.requested",
    "tool.completed",
    "tool.failed",
    "permission.resolved",
    "permission.auto_approved",
    "run.failed",
    "run.canceled",
    "run.budget_warning",
}
LEDGER_NEUTRAL_TOOL_NAMES = {"task.progress", "user.ask"}


def build_handoff_snapshot(
    events: list[dict[str, Any]], artifacts: list[dict[str, Any]]
) -> dict[str, Any]:
    """Return the compact progress-ledger slice safe to put on run events."""
    ledger_state, ledger_message = progress_ledger_state(events, artifacts)
    return {
        "ledger_state": ledger_state,
        "ledger_message": ledger_message,
        "feature_ledger": latest_feature_ledger(artifacts),
    }


def latest_feature_ledger(artifacts: list[dict[str, Any]]) -> dict[str, Any] | None:
    for artifact in reversed(artifacts):
        if artifact.get("kind") != "progress_ledger":
            continue
        payload = artifact.get("metadata")
        if not isinstance(payload, dict) or not payload.get("summary"):
            try:
                payload = json.loads(str(artifact.get("content") or "{}"))
            except json.JSONDecodeError:
                payload = {}
        if not isinstance(payload, dict) or not payload.get("summary"):
            return None
        return {
            "summary": str(payload.get("summary") or ""),
            "status": str(payload.get("status") or "in_progress"),
            "acceptance_criteria": _string_list(payload.get("acceptance_criteria")),
            "decisions": _string_list(payload.get("decisions")),
            "files_touched": _string_list(payload.get("files_touched")),
            "validation_commands": _string_list(payload.get("validation_commands")),
            "unresolved_risks": _string_list(payload.get("unresolved_risks")),
            "next_actions": _string_list(payload.get("next_actions")),
            "artifact_id": artifact.get("id"),
            "created_at": artifact.get("created_at"),
        }
    return None


def progress_ledger_state(
    events: list[dict[str, Any]], artifacts: list[dict[str, Any]]
) -> tuple[str, str | None]:
    ledger = latest_feature_ledger(artifacts)
    if ledger is None:
        if _progress_ledger_required(events, artifacts):
            return "missing", "Progress ledger missing for handoff."
        return "not_required", None

    ledger_at = _parse_iso_datetime(ledger.get("created_at"))
    if ledger_at is None:
        return "stale", "Progress ledger timestamp is missing; freshness cannot be verified."

    dirty = _latest_dirty_event_after(events, ledger_at)
    if dirty is not None:
        event_type = str(dirty.get("event_type") or "event")
        return "stale", f"Progress ledger stale after {event_type}."

    return "fresh", None


def _progress_ledger_required(
    events: list[dict[str, Any]], artifacts: list[dict[str, Any]]
) -> bool:
    if any(str(artifact.get("kind") or "") != "progress_ledger" for artifact in artifacts):
        return True
    return any(_is_ledger_dirty_event(event) for event in events)


def _latest_dirty_event_after(
    events: list[dict[str, Any]], ledger_at: datetime
) -> dict[str, Any] | None:
    for event in reversed(events):
        if not _is_ledger_dirty_event(event):
            continue
        event_at = _parse_iso_datetime(event.get("created_at"))
        if event_at is not None and event_at > ledger_at:
            return event
    return None


def _is_ledger_dirty_event(event: dict[str, Any]) -> bool:
    event_type = str(event.get("event_type") or "")
    if event_type not in LEDGER_DIRTY_EVENT_TYPES:
        return False
    if event_type.startswith("tool."):
        payload = event.get("payload")
        if isinstance(payload, dict):
            tool_name = str(payload.get("tool") or payload.get("name") or "")
            if tool_name in LEDGER_NEUTRAL_TOOL_NAMES:
                return False
    return True


def _parse_iso_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if str(item).strip()]
