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

import logging
from typing import Any

import httpx
from langchain_core.runnables import RunnableConfig

log = logging.getLogger("local_host.tools.gateway")

# Image generation can take ~60s; budget 2x. Web search is much faster
# but reusing the same timeout keeps the code path simple.
DEFAULT_TIMEOUT_S = 120.0


async def call_tool_gateway(
    tool_name: str,
    arguments: dict[str, Any],
    *,
    run_id: str,
    tool_call_id: str,
) -> dict[str, Any]:
    """POST to the cloud `/api/v1/agent/tools/execute` and return the
    unwrapped `agentToolExecuteResult` (`{ok, content, data?, errorCode?, recoverable?}`).

    Never raises — every failure (no session, network, gateway error,
    bad JSON) is converted to a tool-shaped error envelope so the agent
    can decide whether to retry or surface to the user.

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
    try:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_S) as client:
            resp = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {cloud_token}",
                    "Content-Type": "application/json",
                },
                json=body,
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
        return {
            "ok": False,
            "content": f"{tool_name}: gateway returned non-JSON ({resp.status_code})",
            "errorCode": "gateway_bad_response",
            "recoverable": False,
        }

    data = envelope.get("data") if isinstance(envelope, dict) else None
    if not isinstance(data, dict):
        return {
            "ok": False,
            "content": str(envelope.get("message") if isinstance(envelope, dict) else envelope)
                       or f"{tool_name}: gateway HTTP {resp.status_code}",
            "errorCode": "gateway_envelope_missing",
            "recoverable": False,
        }
    return data


def run_id_from_config(config: RunnableConfig | None) -> str:
    """LangGraph sets `configurable.thread_id` = run_id. Default to ""
    if absent so tools degrade gracefully when called outside an agent
    (e.g. ad-hoc curl)."""
    if config is None:
        return ""
    configurable = config.get("configurable") or {}
    return str(configurable.get("thread_id") or "")
