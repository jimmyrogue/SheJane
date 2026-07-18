"""Stateful Streamable HTTP MCP fixture that expires its first Tool session."""

from __future__ import annotations

import argparse
import json
from collections.abc import Awaitable, Callable
from typing import Any

import uvicorn
from mcp.server.fastmcp import FastMCP

server = FastMCP("SheJane HTTP E2E", json_response=True)


@server.tool()
def echo(value: str) -> str:
    """Echo a deterministic value after Runtime establishes a new session."""
    return f"E2E_MCP_HTTP_OK:{value}"


class ExpireFirstToolSession:
    """Return the spec-defined 404 once for a valid stateful Tool request."""

    def __init__(self, app: Callable[..., Awaitable[None]]) -> None:
        self._app = app
        self._expired = False
        self._sessions = 0

    async def __call__(
        self,
        scope: dict[str, Any],
        receive: Callable[[], Awaitable[dict[str, Any]]],
        send: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return
        if scope.get("path") in {"/health", "/status"}:
            payload = json.dumps(
                {"status": "ok", "sessions": self._sessions, "expired": self._expired}
            ).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [(b"content-type", b"application/json")],
                }
            )
            await send({"type": "http.response.body", "body": payload})
            return

        messages: list[dict[str, Any]] = []
        body = bytearray()
        while True:
            message = await receive()
            messages.append(message)
            if message["type"] == "http.request":
                body.extend(message.get("body", b""))
                if not message.get("more_body", False):
                    break
            else:
                break

        async def replay() -> dict[str, Any]:
            if messages:
                return messages.pop(0)
            return {"type": "http.disconnect"}

        try:
            method = json.loads(body).get("method")
        except (json.JSONDecodeError, UnicodeDecodeError, AttributeError):
            method = None
        if method == "initialize":
            self._sessions += 1
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        if method == "tools/call" and b"mcp-session-id" in headers and not self._expired:
            self._expired = True
            await send(
                {
                    "type": "http.response.start",
                    "status": 404,
                    "headers": [(b"content-type", b"text/plain; charset=utf-8")],
                }
            )
            await send({"type": "http.response.body", "body": b"expired MCP session"})
            return
        await self._app(scope, replay, send)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    app = ExpireFirstToolSession(server.streamable_http_app())
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
