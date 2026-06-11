"""Shared proxy to the cloud Tool Gateway (`/api/v1/agent/tools/execute`).

Tools that consume platform-paid services (image generation, web search,
…) MUST go through this gateway so:

  • the OpenAI/Tavily/etc. provider keys live in the API's model
    registry, NOT in every user's daemon environment;
  • the per-tool credit price is debited from the user's wallet by the
    same ledger that backs other billed operations (reserve → settle
    → release with idempotency keys);
  • the result + cost is auditable from the admin panel.

The Go handler this targets is `httpapi.agentToolExecute`
(`api/internal/httpapi/tool_gateway.go`). Request body matches
`agentToolExecuteRequest`; response is the `apiResponse<agentToolExecuteResult>`
envelope (`{code, message, data: {ok, content, data?, errorCode?, recoverable?}}`).
We unwrap `data` and return it to the LLM directly.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx
from langchain_core.runnables import RunnableConfig

from ..failure_policy import build_retry_decision

log = logging.getLogger("local_host.tools.gateway")

# Image generation can take ~60s; budget 2x. Web search is much faster
# but reusing the same timeout keeps the code path simple.
DEFAULT_TIMEOUT_S = 120.0
MAX_GATEWAY_TRANSPORT_RETRIES = 3
TRANSIENT_GATEWAY_STATUS_CODES = {429, 500, 502, 503, 504}


async def call_tool_gateway(
    tool_name: str,
    arguments: dict[str, Any],
    *,
    run_id: str,
    tool_call_id: str,
) -> dict[str, Any]:
    """POST to the cloud `/api/v1/agent/tools/execute` and return the
    unwrapped `agentToolExecuteResult` (`{ok, content, data?, errorCode?, recoverable?}`).

    Never raises to the model — every failure (no session, network,
    gateway error, bad JSON) is converted to a tool-shaped error
    envelope. Transient transport errors and unstructured transient
    gateway responses are retried first with the same idempotency key
    so a network flap does not double-bill.

    Args:
        tool_name: Tool identifier, e.g. "image.generate", "web.search".
        arguments: Tool-specific args. Must be JSON-serializable; the
                   Go handler validates per-tool.
        run_id: The current agent run id, used by the API for billing
                attribution. Empty string is accepted but means the
                billing ledger entry won't be reconcilable on error.
        tool_call_id: The current tool_call_id from the AIMessage, used
                      as the idempotency key so retries inside the agent
                      loop don't double-bill.
    """
    from ..config import get_settings

    settings = get_settings()
    cloud_base_url = settings.cloud_base_url.rstrip("/")
    cloud_token = settings.cloud_token
    if not cloud_token:
        return {
            "ok": False,
            "content": (
                f"{tool_name} requires a paired cloud session. Please log "
                "in to the Electron app first, then retry."
            ),
            "errorCode": "cloud_session_missing",
            "recoverable": True,
        }

    body = {
        "run_id": run_id,
        "tool_call_id": tool_call_id,
        "tool": tool_name,
        "arguments": arguments,
        "idempotency_key": tool_call_id or run_id,
    }

    url = f"{cloud_base_url}/api/v1/agent/tools/execute"
    headers = {
        "Authorization": f"Bearer {cloud_token}",
        "Content-Type": "application/json",
    }
    try:
        resp = await _post_gateway_with_retries(
            url,
            headers=headers,
            body=body,
            max_retries=settings.max_tool_retries,
            tool_name=tool_name,
        )
    except httpx.HTTPError as exc:
        log.warning("%s: gateway transport error: %s", tool_name, exc)
        return {
            "ok": False,
            "content": f"{tool_name} unreachable: {exc}",
            "errorCode": "gateway_unreachable",
            "recoverable": True,
        }

    try:
        envelope = resp.json()
    except ValueError:
        recoverable = _is_transient_gateway_status(resp.status_code)
        return {
            "ok": False,
            "content": f"{tool_name}: gateway returned non-JSON ({resp.status_code})",
            "errorCode": "gateway_transient_response" if recoverable else "gateway_bad_response",
            "recoverable": recoverable,
        }

    data = envelope.get("data") if isinstance(envelope, dict) else None
    if not isinstance(data, dict):
        recoverable = _is_transient_gateway_status(resp.status_code)
        return {
            "ok": False,
            "content": str(envelope.get("message") if isinstance(envelope, dict) else envelope)
            or f"{tool_name}: gateway HTTP {resp.status_code}",
            "errorCode": "gateway_envelope_missing",
            "recoverable": recoverable,
        }
    return _normalize_structured_gateway_result(data)


async def _post_gateway_with_retries(
    url: str,
    *,
    headers: dict[str, str],
    body: dict[str, Any],
    max_retries: int,
    tool_name: str,
) -> httpx.Response:
    retries = max(0, min(int(max_retries), MAX_GATEWAY_TRANSPORT_RETRIES))
    for attempt in range(retries + 1):
        try:
            async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_S) as client:
                resp = await client.post(url, headers=headers, json=body)
        except httpx.HTTPError:
            decision = _gateway_retry_decision(
                "gateway_unreachable",
                f"{tool_name} gateway transport error",
                attempt=attempt,
                max_retries=retries,
            )
            if not decision["should_retry"]:
                raise
            delay = float(decision["delay_s"])
            log.info(
                "%s: gateway transport retry %d/%d after %.2fs",
                tool_name,
                attempt + 1,
                retries,
                delay,
            )
            await asyncio.sleep(delay)
            continue
        if not _should_retry_gateway_response(resp):
            return resp
        decision = _gateway_retry_decision(
            "gateway_transient_response",
            f"{tool_name} gateway returned HTTP {resp.status_code}",
            attempt=attempt,
            max_retries=retries,
        )
        if not decision["should_retry"]:
            return resp
        delay = float(decision["delay_s"])
        log.info(
            "%s: gateway HTTP %d retry %d/%d after %.2fs",
            tool_name,
            resp.status_code,
            attempt + 1,
            retries,
            delay,
        )
        await asyncio.sleep(delay)
    raise RuntimeError("unreachable gateway retry state")


def _should_retry_gateway_response(resp: httpx.Response) -> bool:
    if not _is_transient_gateway_status(resp.status_code):
        return False
    try:
        resp.json()
    except ValueError:
        return True
    return False


def _is_transient_gateway_status(status_code: int) -> bool:
    return status_code in TRANSIENT_GATEWAY_STATUS_CODES


def _normalize_structured_gateway_result(data: dict[str, Any]) -> dict[str, Any]:
    result = dict(data)
    if not _truthy(result.get("ok")) and "retryable" not in result:
        result["retryable"] = False
    return result


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "ok", "passed"}
    if isinstance(value, (int, float)):
        return value != 0
    return bool(value)


def _gateway_retry_decision(
    error_code: str,
    message: str,
    *,
    attempt: int,
    max_retries: int,
) -> dict[str, Any]:
    return build_retry_decision(
        "tool.failed",
        {
            "error_code": error_code,
            "message": message,
            "retryable": True,
        },
        attempt=attempt,
        max_attempts=max_retries,
        initial_delay=0.25,
        backoff_factor=2,
        max_delay=2.0,
    )


def run_id_from_config(config: RunnableConfig | None) -> str:
    """LangGraph sets `configurable.thread_id` = run_id. Default to ""
    if absent so tools degrade gracefully when called outside an agent
    (e.g. ad-hoc curl)."""
    if config is None:
        return ""
    configurable = config.get("configurable") or {}
    return str(configurable.get("thread_id") or "")
