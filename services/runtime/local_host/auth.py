"""Pairing token auth.

Compatible shape with the Node daemon:
- `Authorization: Bearer <token>` (preferred)
- `X-SheJane-Local-Token: <token>` (fallback)

`/v1/health` is exempt so Electron can probe readiness without configuring
auth first.
"""

from __future__ import annotations

import secrets

from fastapi import status
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

EXEMPT_PATHS = frozenset({"/local/v1/health", "/v1/health", "/health"})
LOCAL_OWNER_PRINCIPAL_ID = "local:owner"


class PairingTokenAuthMiddleware:
    def __init__(self, app: ASGIApp, token: str) -> None:
        self.app = app
        self.token = token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("path") in EXEMPT_PATHS:
            await self.app(scope, receive, send)
            return

        expected = self.token
        if not expected:
            # Daemon started without a token configured — refuse everything
            # except /health. Lets the Electron host detect "not yet paired".
            response = JSONResponse(
                {"error": "pairing token not configured"},
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
            await response(scope, receive, send)
            return

        provided = _extract_token(Headers(scope=scope))
        if provided is None or not secrets.compare_digest(provided, expected):
            response = JSONResponse(
                {"error": "invalid pairing token"},
                status_code=status.HTTP_401_UNAUTHORIZED,
            )
            await response(scope, receive, send)
            return

        scope.setdefault("state", {})["principal_id"] = LOCAL_OWNER_PRINCIPAL_ID
        await self.app(scope, receive, send)


def _extract_token(headers: Headers) -> str | None:
    auth_header = headers.get("Authorization")
    if auth_header and auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()

    direct = headers.get("X-SheJane-Local-Token")
    if direct:
        return direct.strip()

    return None
