"""Hermetic tests for the eval harness — no live agent, no paid LLM.

Covers the scoring + aggregation + gating logic with a fake driver and a fake
LLM completion fn, so the harness itself is regression-protected even though
the real eval (`python -m local_host.eval`) needs a running daemon.
"""

from __future__ import annotations

import asyncio
import json

import httpx

from local_host.eval import (
    EvalCase,
    Expectation,
    Trajectory,
    evaluate,
    format_report,
    heuristic_judge,
    make_llm_judge,
    parse_judgment,
)
from local_host.eval.driver import HttpDaemonDriver


def _case(**kw) -> EvalCase:
    kw.setdefault("id", "c")
    kw.setdefault("goal", "g")
    return EvalCase(**kw)


def test_heuristic_passes_when_all_expectations_hold() -> None:
    case = _case(
        expect=Expectation(answer_contains=["Tokyo"], tools_used=["web.search"], max_steps=5)
    )
    traj = Trajectory(final_text="The capital is Tokyo.", tool_calls=["web.search"], steps=2)
    j = heuristic_judge(case, traj)
    assert j.passed
    assert j.correctness == 1.0 and j.tool_choice == 1.0 and j.efficiency == 1.0


def test_heuristic_fails_on_missing_substring() -> None:
    case = _case(expect=Expectation(answer_contains=["Tokyo"]))
    j = heuristic_judge(case, Trajectory(final_text="It's Osaka."))
    assert not j.passed
    assert any("Tokyo" in r for r in j.reasons)


def test_heuristic_zero_correctness_on_forbidden_substring() -> None:
    case = _case(expect=Expectation(answer_contains=["4"], answer_excludes=["Mock SheJane"]))
    j = heuristic_judge(case, Trajectory(final_text="Mock SheJane response: 4"))
    assert j.correctness == 0.0
    assert not j.passed


def test_heuristic_flags_missing_tool() -> None:
    case = _case(expect=Expectation(tools_used=["web.search"]))
    j = heuristic_judge(case, Trajectory(final_text="done", tool_calls=["web.fetch"]))
    assert j.tool_choice == 0.0
    assert not j.passed


def test_heuristic_penalizes_over_budget_steps() -> None:
    case = _case(expect=Expectation(max_steps=2))
    j = heuristic_judge(case, Trajectory(final_text="done", steps=9))
    assert j.efficiency == 0.5
    assert any("over budget" in r for r in j.reasons)


def test_heuristic_fails_a_failed_run() -> None:
    j = heuristic_judge(_case(), Trajectory(failed=True, error="boom"))
    assert not j.passed
    assert j.overall == 0.0


def test_evaluate_aggregates_pass_rate() -> None:
    cases = [
        _case(id="a", expect=Expectation(answer_contains=["x"])),
        _case(id="b", expect=Expectation(answer_contains=["y"])),
    ]
    trajs = {"a": Trajectory(final_text="has x"), "b": Trajectory(final_text="missing")}

    class FakeDriver:
        async def run(self, case: EvalCase) -> Trajectory:
            return trajs[case.id]

    report = asyncio.run(evaluate(cases, FakeDriver(), heuristic_judge))
    assert report.pass_rate == 0.5
    assert not report.passed
    assert {r.case_id for r in report.results} == {"a", "b"}


def test_evaluate_captures_driver_crash_as_failed_case() -> None:
    class BoomDriver:
        async def run(self, case: EvalCase) -> Trajectory:
            raise RuntimeError("daemon down")

    report = asyncio.run(evaluate([_case(id="z")], BoomDriver(), heuristic_judge))
    assert not report.passed
    assert report.results[0].trajectory.failed
    assert "daemon down" in report.results[0].trajectory.error


def test_http_driver_sends_the_strict_run_command(monkeypatch) -> None:
    requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            requests.append(json.loads(request.content))
            return httpx.Response(200, json={"id": "run_eval"})
        return httpx.Response(
            200,
            content=b"data: [DONE]\n\n",
            headers={"content-type": "text/event-stream"},
        )

    class PatchedClient(httpx.AsyncClient):
        def __init__(self, **kwargs) -> None:
            super().__init__(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr("local_host.eval.driver.httpx.AsyncClient", PatchedClient)

    asyncio.run(HttpDaemonDriver("http://runtime", "tok").run(_case(mode="auto.smart")))

    assert requests[0]["model"] == "auto.smart"
    assert requests[0]["command_id"].startswith("cmd_eval_")
    assert requests[0]["client_message_id"].startswith("msg_eval_")
    assert "mode" not in requests[0]


def test_parse_judgment_handles_fenced_json() -> None:
    raw = '```json\n{"correctness":0.9,"tool_choice":0.8,"efficiency":1.0,"reasons":["ok"]}\n```'
    j = parse_judgment(raw)
    assert j.correctness == 0.9 and j.tool_choice == 0.8 and j.efficiency == 1.0
    assert j.passed  # overall 0.9 >= 0.7


def test_parse_judgment_handles_garbage() -> None:
    j = parse_judgment("the model rambled with no json")
    assert not j.passed
    assert j.correctness == 0.0


def test_llm_judge_uses_injected_completion() -> None:
    def fake_complete(prompt: str) -> str:
        assert "TASK GOAL" in prompt  # the rubric prompt was built
        return '{"correctness":1,"tool_choice":1,"efficiency":1,"reasons":[]}'

    judge = make_llm_judge(fake_complete)
    j = judge(_case(), Trajectory(final_text="anything"))
    assert j.passed and j.overall == 1.0


def test_format_report_renders_pass_and_fail() -> None:
    cases = [_case(id="ok", expect=Expectation(answer_contains=["x"]))]

    class D:
        async def run(self, case: EvalCase) -> Trajectory:
            return Trajectory(final_text="x")

    report = asyncio.run(evaluate(cases, D(), heuristic_judge))
    out = format_report(report)
    assert "PASS" in out and "pass_rate=100%" in out
