"""HTTP-shaped tools.

- `web.search` — proxies through the cloud `/api/v1/agent/tools/execute`
  gateway. The Tavily key lives in the API's env, never in the
  daemon's; per-search credit cost is debited from the user's wallet.
- `web.fetch` — custom HTTP GET/POST with SSRF guards (no private IPs, no
  link-local, scheme allow-list, response size cap, timeout). Stays
  local — semantically this is "agent reads a URL the user mentioned",
  no platform-paid resource involved.
"""

from __future__ import annotations

import ipaddress
import logging
import socket
from typing import Annotated, Any
from urllib.parse import urlsplit

import httpx
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import InjectedToolCallId, tool

from ._gateway import call_tool_gateway, run_id_from_config

log = logging.getLogger("local_host.tools.web")

ALLOWED_SCHEMES = {"http", "https"}
DEFAULT_TIMEOUT_S = 15.0
MAX_RESPONSE_BYTES = 2_000_000  # ~2 MB cap


def _is_private_ip(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True  # malformed → treat as unsafe
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_unspecified
        or ip.is_reserved
    )


def _resolve_safe(hostname: str) -> tuple[bool, str]:
    try:
        addresses = socket.getaddrinfo(hostname, None)
    except socket.gaierror as exc:
        return False, f"dns resolution failed: {exc}"
    for _family, _type, _proto, _canon, sockaddr in addresses:
        ip = sockaddr[0]
        if _is_private_ip(ip):
            return False, f"refusing private/loopback address {ip} for {hostname}"
    return True, ""


@tool("web.fetch")
async def web_fetch(
    url: str,
    method: str = "GET",
    body: str = "",
    content_type: str = "application/json",
) -> dict[str, Any]:
    """Fetch an http(s) URL. Blocks private/loopback addresses (SSRF guard).

    Args:
        url: Absolute http or https URL.
        method: HTTP method. Only GET and POST are allowed.
        body: Optional request body (string). Sent for POST only.
        content_type: Content-Type header for POST.

    Returns either {ok: "true", status, headers, body} or {ok: "false", error}.
    Response body is truncated at ~2 MB.
    """
    method = method.upper()
    if method not in {"GET", "POST"}:
        return {"ok": "false", "error": f"method {method!r} not allowed"}

    parts = urlsplit(url)
    if parts.scheme not in ALLOWED_SCHEMES:
        return {"ok": "false", "error": f"scheme {parts.scheme!r} not allowed"}
    if not parts.hostname:
        return {"ok": "false", "error": "missing hostname"}

    ok, reason = _resolve_safe(parts.hostname)
    if not ok:
        return {"ok": "false", "error": reason}

    headers = {}
    if method == "POST":
        headers["Content-Type"] = content_type

    try:
        async with httpx.AsyncClient(
            timeout=DEFAULT_TIMEOUT_S,
            follow_redirects=True,
        ) as client:
            if method == "GET":
                resp = await client.get(url, headers=headers)
            else:
                resp = await client.post(url, headers=headers, content=body.encode("utf-8"))
            content = resp.content[:MAX_RESPONSE_BYTES]
            truncated = len(resp.content) > MAX_RESPONSE_BYTES
            return {
                "ok": "true",
                "status": str(resp.status_code),
                "headers": {k: v for k, v in resp.headers.items() if len(v) < 1024},
                "body": content.decode("utf-8", errors="replace"),
                "truncated": "true" if truncated else "false",
            }
    except httpx.HTTPError as exc:
        return {"ok": "false", "error": f"{type(exc).__name__}: {exc}"}


async def _invoke_web_search(
    *,
    query: str,
    max_results: int,
    run_id: str,
    tool_call_id: str,
) -> dict[str, Any]:
    """Test-friendly wrapper around the shared gateway helper. Tests
    target this directly so they don't have to construct a LangChain
    ToolCall envelope just to exercise the proxy."""
    return await call_tool_gateway(
        "web.search",
        # Shared model-facing schema uses `max_results`; the Go gateway also
        # accepts legacy `maxResults` for older clients.
        # Clamp here to [1, 10] so a malformed call doesn't waste the
        # round-trip; the gateway also clamps.
        {"query": query, "max_results": max(1, min(int(max_results), 10))},
        run_id=run_id,
        tool_call_id=tool_call_id,
    )


@tool("web.search")
async def web_search(
    query: str,
    max_results: int = 5,
    tool_call_id: Annotated[str, InjectedToolCallId] = "",
    config: RunnableConfig | None = None,
) -> dict[str, Any]:
    """Search the web via Tavily through the cloud Tool Gateway.

    The user's credits cover the per-search fee (debited only on
    success via the same reserve/settle ledger as image.*). The cloud
    API holds the Tavily key — the daemon never sees it.

    Args:
        query: Free-text search query.
        max_results: Up to 10 results. Defaults to 5.

    Returns: `{ok, content, data?, errorCode?, recoverable?}` matching
    `agentToolExecuteResult`. On success, `content` is a Markdown-ish
    block listing each result with title/URL/snippet plus Tavily's
    one-paragraph synthesized "Answer" at the top; `data.results` (when
    present) carries the structured rows for UI rendering.
    """
    return await _invoke_web_search(
        query=query,
        max_results=max_results,
        run_id=run_id_from_config(config),
        tool_call_id=tool_call_id,
    )


WEB_TOOLS = [web_fetch, web_search]
