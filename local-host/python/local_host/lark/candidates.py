from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

TodoPriority = Literal["now", "today", "later", "fyi"]


@dataclass(frozen=True)
class LarkCandidateClassification:
    is_actionable: bool
    priority: TodoPriority
    suggested_action: Literal["reply", "schedule", "create_task", "review", "none"]
    confidence: float
    reasons: list[str] = field(default_factory=list)


_REQUEST_RE = re.compile(
    r"(请|麻烦|帮忙|需要|确认|处理|回复|发一下|补一下|看一下|交一份|交付|提交|完成|写一份|整理|出一份|review|approve|confirm|send|reply|update|decide)",
    re.IGNORECASE,
)
_DEADLINE_NOW_RE = re.compile(
    r"(今天|今晚|上午|下午|下班前|中午前|before noon|eod|today|tonight)",
    re.IGNORECASE,
)
_DEADLINE_LATER_RE = re.compile(r"(明天|本周|这周|tomorrow|this week|week)", re.IGNORECASE)
_QUESTION_RE = re.compile(r"[?？]")
_REVIEW_RE = re.compile(r"(review|PR|审批|审核)", re.IGNORECASE)
_SCHEDULE_RE = re.compile(r"(会议|日程|calendar|schedule|meeting)", re.IGNORECASE)
_FYI_RE = re.compile(r"^\s*(FYI|仅同步|仅供参考|通知一下)", re.IGNORECASE)


def classify_lark_candidate(
    text: str,
    *,
    source_type: str,
    mentions_user: bool,
    high_priority_source: bool,
) -> LarkCandidateClassification:
    normalized = text.strip()
    reasons: list[str] = []
    if not normalized or _FYI_RE.search(normalized):
        return LarkCandidateClassification(
            is_actionable=False,
            priority="fyi",
            suggested_action="none",
            confidence=0,
            reasons=["fyi"] if normalized else [],
        )

    request = bool(_REQUEST_RE.search(normalized))
    deadline_now = bool(_DEADLINE_NOW_RE.search(normalized))
    deadline_later = bool(_DEADLINE_LATER_RE.search(normalized))
    question = bool(_QUESTION_RE.search(normalized))
    direct = source_type == "p2p"

    if direct:
        reasons.append("direct")
    if mentions_user:
        reasons.append("mention")
    if request:
        reasons.append("request")
    if deadline_now or deadline_later:
        reasons.append("deadline")
    if question:
        reasons.append("question")
    if high_priority_source:
        reasons.append("high_priority_source")

    actionable = request and (
        direct or mentions_user or deadline_now or high_priority_source or question
    )
    if not actionable:
        return LarkCandidateClassification(
            is_actionable=False,
            priority="fyi",
            suggested_action="none",
            confidence=0.15 if reasons else 0,
            reasons=reasons,
        )

    priority: TodoPriority
    if deadline_later:
        priority = "later"
    elif deadline_now and (direct or mentions_user):
        priority = "now"
    elif deadline_now or mentions_user or direct:
        priority = "today"
    elif deadline_later or high_priority_source:
        priority = "later"
    else:
        priority = "fyi"

    return LarkCandidateClassification(
        is_actionable=True,
        priority=priority,
        suggested_action=_suggested_action(normalized),
        confidence=_confidence(reasons),
        reasons=reasons,
    )


def _suggested_action(text: str) -> Literal["reply", "schedule", "create_task", "review", "none"]:
    if _REVIEW_RE.search(text):
        return "review"
    if _SCHEDULE_RE.search(text):
        return "schedule"
    if _REQUEST_RE.search(text) or _QUESTION_RE.search(text):
        return "reply"
    return "none"


def _confidence(reasons: list[str]) -> float:
    score = 0.35 + 0.1 * len(set(reasons))
    return min(0.9, round(score, 2))
