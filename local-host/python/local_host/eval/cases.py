"""Seed golden-trajectory cases.

Intentionally small + objective so the heuristic judge gives a dependable
signal. Grow this list as regressions are found — each fixed bug should leave
a case behind. Expectations are deliberately loose where a real LLM's exact
wording varies (substring checks, not equality).
"""

from __future__ import annotations

from .harness import EvalCase, Expectation

CASES: list[EvalCase] = [
    EvalCase(
        id="direct-math",
        goal="请只用一句中文回答:2+2 等于几?",
        mode="fast",
        expect=Expectation(
            answer_contains=["4"],
            # A real provider must answer — never the mock fallback string.
            answer_excludes=["Mock SheJane"],
            max_steps=3,
        ),
        rubric="A correct, concise one-sentence answer stating the sum is 4.",
    ),
    EvalCase(
        id="direct-factual",
        goal="Answer in one short English sentence: what is the capital of Japan?",
        mode="fast",
        expect=Expectation(
            answer_contains=["Tokyo"],
            answer_excludes=["Mock SheJane"],
            max_steps=3,
        ),
        rubric="Names Tokyo as the capital of Japan.",
    ),
    EvalCase(
        id="web-search-news",
        goal="搜索最近关于 AI 的新闻并用要点总结 2-3 条。",
        mode="fast",
        expect=Expectation(
            answer_excludes=["Mock SheJane"],
            tools_used=["web.search"],
            max_steps=8,
        ),
        rubric="Uses web search and summarizes a few recent AI news items with sources.",
    ),
]
