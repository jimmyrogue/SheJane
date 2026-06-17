from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class NormalizedLarkMessage:
    message_type: str
    text: str


_MEDIA_MARKERS = {
    "audio",
    "file",
    "folder",
    "image",
    "media",
    "merge_forward",
    "share_calendar_event",
    "sticker",
    "video",
}


def normalize_lark_message(raw: dict[str, Any]) -> NormalizedLarkMessage:
    message_type = str(raw.get("message_type") or raw.get("msg_type") or "text")
    content = _body_content(raw)
    if message_type == "text":
        return NormalizedLarkMessage(
            message_type=message_type, text=_normalize_text_content(content)
        )
    if message_type == "post":
        return NormalizedLarkMessage(
            message_type=message_type, text=_normalize_post_content(content)
        )
    if message_type == "interactive":
        return NormalizedLarkMessage(
            message_type=message_type, text=_normalize_interactive_content(content)
        )
    if message_type in _MEDIA_MARKERS:
        return NormalizedLarkMessage(message_type=message_type, text=f"[{message_type}]")
    return NormalizedLarkMessage(message_type=message_type, text=_stringify(content).strip())


def _body_content(raw: dict[str, Any]) -> Any:
    body = raw.get("body")
    if isinstance(body, dict) and "content" in body:
        return _jsonish(body.get("content"))
    if "content" in raw:
        return _jsonish(raw.get("content"))
    return raw


def _jsonish(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    text = value.strip()
    if not text:
        return ""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return value


def _normalize_text_content(content: Any) -> str:
    if isinstance(content, dict):
        value = content.get("text") or content.get("content")
        if isinstance(value, str):
            return value.strip()
    return _stringify(content).strip()


def _normalize_post_content(content: Any) -> str:
    if not isinstance(content, dict):
        return _stringify(content).strip()
    locale_payload = _first_dict(content, "zh_cn", "en_us", "ja_jp") or content
    parts: list[str] = []
    title = locale_payload.get("title") if isinstance(locale_payload, dict) else None
    if isinstance(title, str) and title.strip():
        parts.append(title.strip())
    block_rows = locale_payload.get("content") if isinstance(locale_payload, dict) else None
    if isinstance(block_rows, list):
        for row in block_rows:
            row_text = " ".join(_iter_text(row)).strip()
            if row_text:
                parts.append(row_text)
    return "\n".join(parts).strip()


def _normalize_interactive_content(content: Any) -> str:
    if not isinstance(content, dict):
        return _stringify(content).strip()
    parts: list[str] = []
    header = content.get("header")
    if isinstance(header, dict):
        title = header.get("title")
        parts.extend(_iter_text(title))
    elements = content.get("elements")
    if isinstance(elements, list):
        for element in elements:
            element_text = " ".join(_iter_text(element)).strip()
            if element_text:
                parts.append(element_text)
    return "\n".join(part for part in parts if part).strip()


def _first_dict(mapping: dict[str, Any], *keys: str) -> dict[str, Any] | None:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, dict):
            return value
    return None


def _iter_text(value: Any) -> list[str]:
    out: list[str] = []
    if isinstance(value, str):
        if value.strip():
            out.append(value.strip())
    elif isinstance(value, dict):
        for key in ("text", "content", "title"):
            child = value.get(key)
            if child is not None:
                out.extend(_iter_text(child))
    elif isinstance(value, list):
        for item in value:
            out.extend(_iter_text(item))
    return out


def _stringify(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False, default=str)
