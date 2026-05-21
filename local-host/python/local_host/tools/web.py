"""HTTP-shaped tools.

- `web.search` — TavilySearch (langchain-tavily) thin wrapper that respects
  the daemon's research budget (TAVILY_API_KEY env required).
- `web.fetch` — custom HTTP GET/POST with SSRF guards (no private IPs, no
  link-local, scheme allow-list, response size cap, timeout).
"""

from __future__ import annotations

import ipaddress
import logging
import socket
from typing import Any
from urllib.parse import urlsplit

import httpx
from langchain_core.tools import BaseTool, tool

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
    for family, _type, _proto, _canon, sockaddr in addresses:
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


def make_tavily_search() -> BaseTool | None:
    """Build TavilySearch from langchain-tavily if TAVILY_API_KEY is set.

    Returns None if no key is configured — caller can decide whether to
    surface the absence to the agent (e.g. via tool description) or omit
    the tool entirely.
    """
    import os

    if not os.environ.get("TAVILY_API_KEY"):
        return None

    try:
        from langchain_tavily import TavilySearch
    except ImportError:
        log.warning("langchain_tavily not installed; web.search disabled")
        return None

    # langchain-tavily picks up TAVILY_API_KEY from env automatically.
    return TavilySearch(max_results=5, topic="general")


WEB_TOOLS = [web_fetch]
