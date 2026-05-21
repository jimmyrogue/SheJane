"""task.verify — rule-based verification primitive.

The agent calls this to assert checkpoints during multi-step tasks. Supports
a small set of declarative checks; results aggregate into pass/fail.

Examples:
    {"checks": [{"kind": "file_exists", "path": "./out.json"}]}
    {"checks": [
        {"kind": "file_contains", "path": "./out.txt", "substring": "ok"},
        {"kind": "shell_exit_code", "command": "ls /tmp", "expected": 0}
    ]}
"""

from __future__ import annotations

import asyncio
import os
import shlex
from pathlib import Path
from typing import Any

import httpx
from langchain_core.tools import tool

SUPPORTED_KINDS = {
    "file_exists",
    "file_contains",
    "file_matches_size",
    "url_reachable",
    "shell_exit_code",
}


async def _check_file_exists(check: dict[str, Any]) -> tuple[bool, str]:
    path = check.get("path", "")
    if not path:
        return False, "missing 'path'"
    exists = Path(os.path.expanduser(path)).exists()
    return exists, f"file {'exists' if exists else 'missing'}: {path}"


async def _check_file_contains(check: dict[str, Any]) -> tuple[bool, str]:
    path = check.get("path", "")
    needle = check.get("substring", "")
    if not path or needle == "":
        return False, "missing 'path' or 'substring'"
    p = Path(os.path.expanduser(path))
    if not p.exists():
        return False, f"file missing: {path}"
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return False, f"read failed: {exc}"
    found = needle in text
    return found, f"substring {'found' if found else 'absent'} in {path}"


async def _check_file_size(check: dict[str, Any]) -> tuple[bool, str]:
    path = check.get("path", "")
    expected_min = int(check.get("min_bytes", 0))
    expected_max = int(check.get("max_bytes", 10**12))
    p = Path(os.path.expanduser(path))
    if not p.exists():
        return False, f"file missing: {path}"
    size = p.stat().st_size
    ok = expected_min <= size <= expected_max
    return ok, f"size {size} bytes (range {expected_min}-{expected_max})"


async def _check_url_reachable(check: dict[str, Any]) -> tuple[bool, str]:
    url = check.get("url", "")
    if not url:
        return False, "missing 'url'"
    if not (url.startswith("http://") or url.startswith("https://")):
        return False, "url must be http(s)"
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.head(url)
            ok = 200 <= resp.status_code < 400
            return ok, f"HEAD {url} → {resp.status_code}"
    except httpx.HTTPError as exc:
        return False, f"HEAD failed: {exc}"


async def _check_shell_exit(check: dict[str, Any]) -> tuple[bool, str]:
    command = check.get("command", "")
    expected = int(check.get("expected", 0))
    if not command:
        return False, "missing 'command'"
    try:
        proc = await asyncio.create_subprocess_exec(
            *shlex.split(command),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        rc = await asyncio.wait_for(proc.wait(), timeout=10.0)
    except (FileNotFoundError, ValueError, asyncio.TimeoutError) as exc:
        return False, f"{type(exc).__name__}: {exc}"
    ok = rc == expected
    return ok, f"`{command}` exited {rc} (expected {expected})"


_DISPATCH = {
    "file_exists": _check_file_exists,
    "file_contains": _check_file_contains,
    "file_matches_size": _check_file_size,
    "url_reachable": _check_url_reachable,
    "shell_exit_code": _check_shell_exit,
}


@tool("task.verify")
async def task_verify(checks: list[dict[str, Any]]) -> dict[str, Any]:
    """Run a list of declarative verification checks.

    Args:
        checks: list of dicts, each with a `kind` key naming one of:
                file_exists, file_contains, file_matches_size,
                url_reachable, shell_exit_code. Other keys depend on kind.

    Returns:
        {ok: "true"|"false", results: [{kind, ok, detail}, ...], pass_count, fail_count}
    """
    if not isinstance(checks, list) or not checks:
        return {"ok": "false", "error": "checks must be a non-empty list"}

    results: list[dict[str, Any]] = []
    pass_count = 0
    fail_count = 0
    for check in checks:
        kind = check.get("kind")
        if kind not in _DISPATCH:
            results.append(
                {"kind": kind, "ok": False, "detail": f"unsupported kind: {kind}"}
            )
            fail_count += 1
            continue
        ok, detail = await _DISPATCH[kind](check)
        results.append({"kind": kind, "ok": ok, "detail": detail})
        if ok:
            pass_count += 1
        else:
            fail_count += 1

    return {
        "ok": "true" if fail_count == 0 else "false",
        "results": results,
        "pass_count": str(pass_count),
        "fail_count": str(fail_count),
    }


VERIFY_TOOLS = [task_verify]
