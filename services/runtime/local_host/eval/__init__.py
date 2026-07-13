"""Agent eval harness — golden trajectories + heuristic / LLM-judge scoring.

See harness.py for the design. `python -m local_host.eval` runs the seed cases
against a live daemon (heuristic judge); the harness pieces are unit-tested
hermetically in tests/test_eval_harness.py.
"""

from .harness import (
    CaseResult,
    Driver,
    EvalCase,
    EvalReport,
    Expectation,
    Judge,
    Judgment,
    Trajectory,
    evaluate,
    format_report,
    heuristic_judge,
    make_llm_judge,
    parse_judgment,
)

__all__ = [
    "CaseResult",
    "Driver",
    "EvalCase",
    "EvalReport",
    "Expectation",
    "Judge",
    "Judgment",
    "Trajectory",
    "evaluate",
    "format_report",
    "heuristic_judge",
    "make_llm_judge",
    "parse_judgment",
]
