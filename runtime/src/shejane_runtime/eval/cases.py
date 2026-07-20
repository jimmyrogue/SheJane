"""Seed golden-trajectory cases.

Intentionally small + objective so the heuristic judge gives a dependable
signal. Grow this list as regressions are found — each fixed bug should leave
a case behind. Expectations are deliberately loose where a real LLM's exact
wording varies (substring checks, not equality).
"""

from __future__ import annotations

from pathlib import Path

from .harness import EvalCase, Expectation

_REPO_ROOT = Path(__file__).resolve().parents[4]

CASES: list[EvalCase] = [
    EvalCase(
        id="direct-math",
        goal="请只用一句中文回答:2+2 等于几?",
        expect=Expectation(
            answer_contains=["4"],
            # A real provider must answer — never the mock fallback string.
            answer_excludes=["Mock SheJane"],
            max_steps=3,
            min_model_calls=1,
            min_input_tokens=1,
            min_output_tokens=1,
        ),
        rubric="A correct, concise one-sentence answer stating the sum is 4.",
    ),
    EvalCase(
        id="direct-factual",
        goal="Answer in one short English sentence: what is the capital of Japan?",
        expect=Expectation(
            answer_contains=["Tokyo"],
            answer_excludes=["Mock SheJane"],
            max_steps=3,
            min_model_calls=1,
            min_input_tokens=1,
            min_output_tokens=1,
        ),
        rubric="Names Tokyo as the capital of Japan.",
    ),
    EvalCase(
        id="workspace-read-tool",
        goal=(
            "必须调用 read_file 工具读取工作区 README.md 的前 20 行，然后用一句中文回答"
            "项目名称和用途；不要凭记忆回答。"
        ),
        workspace_path=str(_REPO_ROOT),
        expect=Expectation(
            answer_contains=["SheJane"],
            answer_excludes=["Mock SheJane"],
            tools_used=["read_file"],
            max_steps=4,
            min_model_calls=2,
            min_input_tokens=1,
            min_output_tokens=1,
        ),
        rubric="Reads README.md with the tool, then identifies SheJane and its purpose.",
    ),
]
