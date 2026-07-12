"""task.verify — rule-based verification primitive.

The agent calls this to assert checkpoints during multi-step tasks. Supports
a small set of declarative checks; results aggregate into pass/fail.

Examples:
    {"checks": [{"kind": "file_exists", "path": "./out.json"}]}
    {"checks": [
        {"kind": "file_contains", "path": "./out.txt", "substring": "ok"},
        {"kind": "url_reachable", "url": "http://127.0.0.1:5173"}
    ]}
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx
from langchain_core.runnables import ensure_config
from langchain_core.tools import tool

from .web import MAX_REDIRECTS, _pinned_transport

SUPPORTED_KINDS = {
    "file_exists",
    "file_contains",
    "file_matches_size",
    "url_reachable",
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
    try:
        current_url = url
        for redirect_count in range(MAX_REDIRECTS + 1):
            transport, reason = _pinned_transport(current_url)
            if transport is None:
                return False, reason
            async with httpx.AsyncClient(
                timeout=10.0,
                follow_redirects=False,
                transport=transport,
            ) as client:
                resp = await client.head(current_url)
                location = resp.headers.get("location")
                if resp.status_code in {301, 302, 303, 307, 308} and location:
                    if redirect_count >= MAX_REDIRECTS:
                        return False, "too many redirects"
                    current_url = urljoin(current_url, location)
                    continue
                ok = 200 <= resp.status_code < 400
                return ok, f"HEAD {current_url} → {resp.status_code}"
        return False, "too many redirects"
    except httpx.HTTPError as exc:
        return False, f"HEAD failed: {exc}"


def _resolve_workspace_path(path: str) -> tuple[Path | None, str | None]:
    if not path:
        return None, "missing 'path'"
    config = ensure_config()
    configurable = config.get("configurable") if isinstance(config, dict) else None
    workspace = (
        str(configurable.get("workspace_root") or "").strip()
        if isinstance(configurable, dict)
        else ""
    )
    if not workspace:
        return None, "no workspace open"
    root = Path(os.path.abspath(os.path.expanduser(workspace))).resolve()
    raw_path = Path(os.path.expanduser(path))
    candidate = (raw_path if raw_path.is_absolute() else root / raw_path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None, f"path outside workspace: {candidate}"
    return candidate, None


_DISPATCH = {
    "file_exists": _check_file_exists,
    "file_contains": _check_file_contains,
    "file_matches_size": _check_file_size,
    "url_reachable": _check_url_reachable,
}


@tool("task.verify")
async def task_verify(checks: list[dict[str, Any]]) -> dict[str, Any]:
    """Run a list of declarative verification checks.

    Args:
        checks: list of dicts, each with a `kind` key naming one of:
                file_exists, file_contains, file_matches_size,
                url_reachable. Other keys depend on kind.

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
            results.append({"kind": kind, "ok": False, "detail": f"unsupported kind: {kind}"})
            fail_count += 1
            continue
        bounded_check = dict(check)
        if kind in {"file_exists", "file_contains", "file_matches_size"}:
            resolved, path_error = _resolve_workspace_path(str(check.get("path") or ""))
            if path_error is not None or resolved is None:
                results.append({"kind": kind, "ok": False, "detail": path_error})
                fail_count += 1
                continue
            bounded_check["path"] = str(resolved)
        ok, detail = await _DISPATCH[kind](bounded_check)
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
