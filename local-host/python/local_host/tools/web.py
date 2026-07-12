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
from urllib.parse import urljoin, urlsplit

import httpcore
import httpx
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import InjectedToolCallId, tool

from ._gateway import call_tool_gateway, run_id_from_config

log = logging.getLogger("local_host.tools.web")

ALLOWED_SCHEMES = {"http", "https"}
DEFAULT_TIMEOUT_S = 15.0
MAX_RESPONSE_BYTES = 2_000_000  # ~2 MB cap
MAX_REDIRECTS = 5


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
    ok, reason, _address = _resolve_pinned(hostname)
    return ok, reason


def _resolve_pinned(hostname: str) -> tuple[bool, str, str | None]:
    try:
        addresses = socket.getaddrinfo(hostname, None)
    except socket.gaierror as exc:
        return False, f"dns resolution failed: {exc}", None
    pinned: str | None = None
    for _family, _type, _proto, _canon, sockaddr in addresses:
        ip = sockaddr[0]
        if _is_private_ip(ip):
            return False, f"refusing private/loopback address {ip} for {hostname}", None
        if pinned is None:
            pinned = ip
    if pinned is None:
        return False, f"dns resolution returned no addresses for {hostname}", None
    return True, "", pinned


def _validate_fetch_url(url: str) -> tuple[bool, str]:
    parts = urlsplit(url)
    if parts.scheme not in ALLOWED_SCHEMES:
        return False, f"scheme {parts.scheme!r} not allowed"
    if not parts.hostname:
        return False, "missing hostname"
    if parts.username is not None or parts.password is not None:
        return False, "URL credentials are not allowed"
    return _resolve_safe(parts.hostname)


class _PinnedNetworkBackend(httpcore.AsyncNetworkBackend):
    """Connect to the already-validated IP while preserving hostname TLS/SNI."""

    def __init__(self, hostname: str, address: str) -> None:
        self.hostname = hostname.lower()
        self.address = address
        self.delegate = httpcore.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,  # noqa: ASYNC109 - httpcore protocol signature
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        if host.lower() != self.hostname:
            raise httpcore.ConnectError(f"unvalidated hostname: {host}")
        return await self.delegate.connect_tcp(
            self.address,
            port,
            timeout=timeout,
            local_address=local_address,
            socket_options=socket_options,
        )

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,  # noqa: ASYNC109 - httpcore protocol signature
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        raise httpcore.ConnectError("unix sockets are not allowed")

    async def sleep(self, seconds: float) -> None:
        await self.delegate.sleep(seconds)


def _pinned_transport(url: str) -> tuple[httpx.AsyncHTTPTransport | None, str]:
    parts = urlsplit(url)
    if parts.scheme not in ALLOWED_SCHEMES:
        return None, f"scheme {parts.scheme!r} not allowed"
    if not parts.hostname:
        return None, "missing hostname"
    if parts.username is not None or parts.password is not None:
        return None, "URL credentials are not allowed"
    ok, reason, address = _resolve_pinned(parts.hostname)
    if not ok or address is None:
        return None, reason
    transport = httpx.AsyncHTTPTransport()
    transport._pool = httpcore.AsyncConnectionPool(
        ssl_context=httpx.create_ssl_context(),
        network_backend=_PinnedNetworkBackend(parts.hostname, address),
    )
    return transport, ""


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

    try:
        current_url = url
        current_method = method
        current_body = body
        for redirect_count in range(MAX_REDIRECTS + 1):
            transport, reason = _pinned_transport(current_url)
            if transport is None:
                return {"ok": "false", "error": reason}
            async with httpx.AsyncClient(
                timeout=DEFAULT_TIMEOUT_S,
                follow_redirects=False,
                transport=transport,
            ) as client:
                headers = {}
                content = None
                if current_method == "POST":
                    headers["Content-Type"] = content_type
                    content = current_body.encode("utf-8")

                resp = await client.request(
                    current_method,
                    current_url,
                    headers=headers,
                    content=content,
                )
                location = resp.headers.get("location")
                if resp.status_code in {301, 302, 303, 307, 308} and location:
                    if redirect_count >= MAX_REDIRECTS:
                        return {"ok": "false", "error": "too many redirects"}
                    current_url = urljoin(current_url, location)
                    if resp.status_code in {301, 302, 303}:
                        current_method = "GET"
                        current_body = ""
                    continue
                response_content = resp.content[:MAX_RESPONSE_BYTES]
                truncated = len(resp.content) > MAX_RESPONSE_BYTES
                return {
                    "ok": "true",
                    "status": str(resp.status_code),
                    "headers": {k: v for k, v in resp.headers.items() if len(v) < 1024},
                    "body": response_content.decode("utf-8", errors="replace"),
                    "truncated": "true" if truncated else "false",
                }
        return {"ok": "false", "error": "too many redirects"}
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
