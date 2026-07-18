"""CLI: run the seed eval cases against a RUNNING local daemon.

    SHEJANE_EVAL_DAEMON_URL  (default http://127.0.0.1:17371)
    SHEJANE_EVAL_TOKEN       (or SHEJANE_LOCAL_HOST_TOKEN) — daemon bearer token
    SHEJANE_EVAL_MODEL       concrete local:<provider>:<model> selection

Exits non-zero if any case fails, so it gates CI / `make eval`. Uses the
heuristic judge (objective, no extra LLM cost). For a meaningful score the
Runtime must run against a real configured provider — otherwise the
mock-provider tell trips the `answer_excludes` check and cases fail loudly.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
from dataclasses import replace

from local_host.api_schemas import RUNTIME_MODEL_PATTERN

from .cases import CASES
from .driver import HttpDaemonDriver
from .harness import evaluate, format_report, heuristic_judge


def _required_model() -> str:
    model = os.environ.get("SHEJANE_EVAL_MODEL", "").strip()
    if len(model) > 128 or re.fullmatch(RUNTIME_MODEL_PATTERN, model) is None:
        raise ValueError("set SHEJANE_EVAL_MODEL to a concrete local:<provider>:<model> selection")
    return model


def main() -> int:
    base_url = os.environ.get("SHEJANE_EVAL_DAEMON_URL", "http://127.0.0.1:17371")
    token = os.environ.get("SHEJANE_EVAL_TOKEN") or os.environ.get("SHEJANE_LOCAL_HOST_TOKEN", "")
    if not token:
        print(
            "error: set SHEJANE_EVAL_TOKEN (or SHEJANE_LOCAL_HOST_TOKEN) to the daemon bearer token",
            file=sys.stderr,
        )
        return 2

    try:
        model = _required_model()
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    driver = HttpDaemonDriver(base_url, token)
    cases = [replace(case, model=model) for case in CASES]
    report = asyncio.run(evaluate(cases, driver, heuristic_judge))
    print(format_report(report))
    return 0 if report.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
