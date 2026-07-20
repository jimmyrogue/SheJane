"""Shared semantic outcome helpers for structured Tool results."""

from __future__ import annotations

import json
from typing import Any


def tool_result_envelope(content: Any) -> dict[str, Any] | None:
    if isinstance(content, dict):
        return content
    if isinstance(content, str):
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            return None
        if isinstance(parsed, dict):
            return parsed
    return None


def tool_result_envelope_failed(envelope: dict[str, Any] | None) -> bool:
    if not isinstance(envelope, dict) or "ok" not in envelope:
        return False
    return not _truthy(envelope.get("ok"))


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "ok", "passed"}
    if isinstance(value, (int, float)):
        return value != 0
    return bool(value)
