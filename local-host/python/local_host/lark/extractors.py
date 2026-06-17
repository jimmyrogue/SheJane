from __future__ import annotations

import locale
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

import httpx

TodoPriority = Literal["now", "today", "later", "fyi"]
TodoSuggestedAction = Literal["reply", "schedule", "create_task", "review", "none"]
TodoExtractionProvider = Literal["rules", "cloud_redacted", "local_model"]

log = logging.getLogger("local_host.lark.extractors")


@dataclass(frozen=True)
class TodoExtractionCandidate:
    message_id: str
    source_id: str
    source_label: str
    source_type: str
    raw_text: str
    redacted_text: str
    priority_hint: TodoPriority
    suggested_action: TodoSuggestedAction
    confidence: float
    created_at: str = ""


@dataclass(frozen=True)
class ExtractedTodo:
    candidate_id: str
    title: str
    summary: str
    priority: TodoPriority
    suggested_action: TodoSuggestedAction
    confidence: float
    due_at: str | None = None


@dataclass(frozen=True)
class TodoExtractionResult:
    provider: TodoExtractionProvider
    todos: list[ExtractedTodo]
    error_code: str | None = None


class RuleTodoExtractor:
    provider: TodoExtractionProvider = "rules"

    async def extract(self, candidates: list[TodoExtractionCandidate]) -> TodoExtractionResult:
        return TodoExtractionResult(
            provider=self.provider,
            todos=[
                ExtractedTodo(
                    candidate_id=candidate.message_id,
                    title=_clip(candidate.raw_text or candidate.redacted_text, 120),
                    summary=f"来自 {candidate.source_label or 'Lark'} 的待处理消息",
                    priority=candidate.priority_hint,
                    suggested_action=candidate.suggested_action,
                    confidence=candidate.confidence,
                    due_at=infer_lark_due_at(
                        candidate.raw_text or candidate.redacted_text,
                        candidate.created_at,
                    ),
                )
                for candidate in candidates
            ],
        )


class CloudRedactedTodoExtractor:
    provider: TodoExtractionProvider = "cloud_redacted"

    def __init__(
        self,
        *,
        cloud_base_url: str,
        cloud_token: str,
        model: str = "auto",
        timeout_s: float = 45.0,
    ) -> None:
        self.cloud_base_url = cloud_base_url.rstrip("/")
        self.cloud_token = cloud_token.strip()
        self.model = model or "auto"
        self.timeout_s = timeout_s

    async def extract(self, candidates: list[TodoExtractionCandidate]) -> TodoExtractionResult:
        if not self.cloud_token:
            return TodoExtractionResult(
                provider=self.provider,
                todos=[],
                error_code="cloud_session_missing",
            )
        source_aliases: dict[str, str] = {}
        safe_candidates = [
            {
                "id": candidate.message_id,
                "text": candidate.redacted_text,
                "evidence_preview": _clip(candidate.redacted_text, 240),
                "redacted": True,
                "source_label": _source_alias(candidate, source_aliases),
                "source_type": candidate.source_type,
                "created_at": _coarse_minute_timestamp(candidate.created_at),
                "due_at_hint": infer_lark_due_at(
                    candidate.raw_text or candidate.redacted_text,
                    candidate.created_at,
                )
                or "",
                "priority_hint": candidate.priority_hint,
                "suggested_action": candidate.suggested_action,
                "confidence": candidate.confidence,
            }
            for candidate in candidates
            if candidate.redacted_text.strip()
        ]
        if not safe_candidates:
            return TodoExtractionResult(provider=self.provider, todos=[])

        url = f"{self.cloud_base_url}/api/v1/agent/extract-todos"
        headers = {
            "Authorization": f"Bearer {self.cloud_token}",
            "Content-Type": "application/json",
        }
        body = {
            "provider": self.provider,
            "model": self.model,
            "source": "lark",
            "timezone": _local_timezone_name(),
            "locale": _local_locale_name(),
            "schema_version": "lark_todo_extract.v1",
            "candidates": safe_candidates,
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                resp = await client.post(url, headers=headers, json=body)
        except httpx.HTTPError as exc:
            log.warning("cloud redacted todo extraction transport failed: %s", exc)
            return TodoExtractionResult(
                provider=self.provider,
                todos=[],
                error_code="gateway_unreachable",
            )
        if resp.status_code != 200:
            log.warning("cloud redacted todo extraction failed with HTTP %s", resp.status_code)
            return TodoExtractionResult(
                provider=self.provider,
                todos=[],
                error_code="gateway_http_error",
            )
        try:
            envelope = resp.json()
        except ValueError:
            return TodoExtractionResult(
                provider=self.provider,
                todos=[],
                error_code="gateway_bad_response",
            )
        data = envelope.get("data") if isinstance(envelope, dict) else None
        if not isinstance(data, dict):
            return TodoExtractionResult(
                provider=self.provider,
                todos=[],
                error_code="gateway_bad_response",
            )
        return TodoExtractionResult(
            provider=self.provider,
            todos=[
                _decode_cloud_todo(item)
                for item in data.get("todos") or []
                if isinstance(item, dict)
            ],
        )


def _decode_cloud_todo(item: dict) -> ExtractedTodo:
    return ExtractedTodo(
        candidate_id=str(item.get("candidateId") or item.get("candidate_id") or "").strip(),
        title=_clip(str(item.get("title") or "").strip(), 120),
        summary=_clip(str(item.get("summary") or "").strip(), 300),
        priority=_normalize_priority(str(item.get("priority") or "")),
        suggested_action=_normalize_action(
            str(item.get("suggestedAction") or item.get("suggested_action") or "")
        ),
        confidence=_clamp_confidence(item.get("confidence")),
        due_at=_normalize_due_at(str(item.get("dueAt") or item.get("due_at") or "")),
    )


def infer_lark_due_at(text: str, created_at: str) -> str | None:
    normalized = text.strip().lower()
    if not normalized:
        return None
    has_deadline = any(
        marker in normalized
        for marker in (
            "今天",
            "今晚",
            "明天",
            "后天",
            "上午",
            "中午",
            "下午",
            "下班前",
            "之前",
            "截止",
            "today",
            "tonight",
            "tomorrow",
            "eod",
            "before noon",
        )
    )
    if not has_deadline:
        return None
    base = _parse_candidate_datetime(created_at) or datetime.now().astimezone()
    day_offset = 0
    if "后天" in normalized:
        day_offset = 2
    elif "明天" in normalized or "tomorrow" in normalized:
        day_offset = 1
    due_day = base + timedelta(days=day_offset)
    hour, minute = _infer_due_clock(normalized)
    explicit_time = _explicit_clock(normalized)
    if explicit_time is not None:
        hour, minute = explicit_time
    return due_day.replace(hour=hour, minute=minute, second=0, microsecond=0).isoformat()


def _parse_candidate_datetime(value: str) -> datetime | None:
    value = value.strip()
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.astimezone()
    return parsed


def _infer_due_clock(text: str) -> tuple[int, int]:
    if "上午" in text or "中午" in text or "before noon" in text:
        return 12, 0
    if "今晚" in text or "晚上" in text or "tonight" in text:
        return 22, 0
    if "下午" in text or "下班前" in text or "eod" in text:
        return 18, 0
    return 18, 0


def _explicit_clock(text: str) -> tuple[int, int] | None:
    import re

    match = re.search(r"(?<!\d)([01]?\d|2[0-3])[:：]([0-5]\d)(?!\d)", text)
    if match:
        return int(match.group(1)), int(match.group(2))
    cn_match = re.search(r"(上午|下午|晚上|今晚)?\s*([0-2]?\d)\s*点(?:\s*([0-5]?\d)\s*分?)?", text)
    if not cn_match:
        return None
    hour = int(cn_match.group(2))
    minute = int(cn_match.group(3) or 0)
    period = cn_match.group(1) or ""
    if period in {"下午", "晚上", "今晚"} and hour < 12:
        hour += 12
    return min(hour, 23), min(minute, 59)


def _normalize_due_at(value: str) -> str | None:
    value = value.strip()
    if not value:
        return None
    parsed = _parse_candidate_datetime(value)
    if parsed is None:
        return None
    return parsed.replace(second=0, microsecond=0).isoformat()


def _source_alias(candidate: TodoExtractionCandidate, aliases: dict[str, str]) -> str:
    key = candidate.source_id or candidate.source_label or candidate.message_id
    if key not in aliases:
        aliases[key] = f"chat_{len(aliases) + 1}"
    return aliases[key]


def _coarse_minute_timestamp(value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value[:16] if len(value) >= 16 else value
    return parsed.replace(second=0, microsecond=0).isoformat()


def _local_timezone_name() -> str:
    try:
        offset = datetime.now().astimezone().utcoffset()
    except (OSError, ValueError):
        return "UTC"
    if offset is None:
        return "UTC"
    total_minutes = int(offset.total_seconds() // 60)
    sign = "+" if total_minutes >= 0 else "-"
    total_minutes = abs(total_minutes)
    hours, minutes = divmod(total_minutes, 60)
    return f"UTC{sign}{hours:02d}:{minutes:02d}"


def _local_locale_name() -> str:
    current = locale.getlocale()[0]
    return current or "zh-CN"


def _normalize_priority(value: str) -> TodoPriority:
    normalized = value.strip().lower()
    if normalized in {"now", "today", "later", "fyi"}:
        return normalized  # type: ignore[return-value]
    return "today"


def _normalize_action(value: str) -> TodoSuggestedAction:
    normalized = value.strip().lower()
    if normalized in {"reply", "schedule", "create_task", "review", "none"}:
        return normalized  # type: ignore[return-value]
    return "none"


def _clamp_confidence(value: object) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    return min(1, max(0, number))


def _clip(text: str, limit: int) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[:limit]
