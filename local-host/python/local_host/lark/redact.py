from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class RedactionResult:
    text: str
    counts: dict[str, int]


_PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    (
        "secret",
        re.compile(
            r"(?i)\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;，。]+"
        ),
        r"\1=[secret]",
    ),
    ("url", re.compile(r"https?://[^\s,，。；;]+", re.IGNORECASE), "[url]"),
    ("email", re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE), "[email]"),
    ("ip", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "[ip]"),
    ("lark_id", re.compile(r"\b(?:ou|oc|om|on|cli)_[A-Za-z0-9_-]{8,}\b"), "[lark_id]"),
    (
        "token",
        re.compile(
            r"(?i)\bBearer\s+[A-Za-z0-9._-]{20,}|\b(?:sk|pk|rk|gh[pousr]|xox[baprs])_[A-Za-z0-9_-]{16,}\b|\beyJ[A-Za-z0-9._-]{20,}\b"
        ),
        "[token]",
    ),
    ("long_number", re.compile(r"\b\d{12,}\b"), "[long_number]"),
    ("phone", re.compile(r"(?<!\w)(?:\+?\d[\d\s-]{8,}\d)(?!\w)"), "[phone]"),
]


def redact_lark_text(text: str) -> RedactionResult:
    redacted = text
    counts: dict[str, int] = {}
    for name, pattern, replacement in _PATTERNS:
        redacted, count = pattern.subn(replacement, redacted)
        if count:
            counts[name] = count
    return RedactionResult(text=redacted, counts=counts)
