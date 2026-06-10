"""Cloud-side Auto model resolution.

When the user picks "Auto", the CLOUD owns the decision (one task-aware
classifier turn over the model catalog — see the Go side's
`POST /api/v1/models/resolve`). The daemon calls this once at run start,
emits `model.selected` so the UI can badge "Auto → <label>", and forwards
the concrete model id on every LLM turn of the run.

Failure here is non-fatal by design: returning None leaves the run on
"auto", which the cloud LLM endpoint maps to the default model per turn —
the run still works, the user just doesn't get the badge.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger("local_host.llm.resolve")


async def resolve_auto_model(
    goal: str,
    *,
    cloud_base_url: str,
    cloud_token: str,
    run_id: str = "",
    timeout_s: float = 15.0,
) -> dict[str, Any] | None:
    """Resolve "auto" → `{model_id, label, reason}` via the cloud, or None.

    The classifier call is unbilled cloud-side; the daemon's only job is to
    not block the run on it (bounded timeout, swallow-and-log errors).
    """
    url = f"{cloud_base_url.rstrip('/')}/api/v1/models/resolve"
    headers = {}
    if cloud_token:
        headers["Authorization"] = f"Bearer {cloud_token}"
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.post(url, json={"goal": goal}, headers=headers)
        if resp.status_code != 200:
            log.warning("model resolve failed (%s) for run %s", resp.status_code, run_id)
            return None
        data = resp.json().get("data") or {}
        model_id = str(data.get("model_id") or "").strip()
        if not model_id:
            return None
        return {
            "model_id": model_id,
            "label": str(data.get("label") or ""),
            "reason": str(data.get("reason") or ""),
        }
    except Exception as exc:  # network/timeout/JSON — all non-fatal
        log.warning("model resolve error for run %s: %s", run_id, exc)
        return None
