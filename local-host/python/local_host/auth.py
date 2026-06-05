"""Pairing token auth.

Compatible shape with the Node daemon:
- `Authorization: Bearer <token>` (preferred)
- `X-SheJane-Local-Token: <token>` (fallback)

`/v1/health` is exempt so Electron can probe readiness without configuring
auth first.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from fastapi import Request, status
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response

from .config import get_settings

EXEMPT_PATHS = frozenset({"/local/v1/health", "/v1/health", "/health"})


class PairingTokenAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if request.url.path in EXEMPT_PATHS:
            return await call_next(request)

        expected = get_settings().pairing_token
        if not expected:
            # Daemon started without a token configured — refuse everything
            # except /health. Lets the Electron host detect "not yet paired".
            return JSONResponse(
                {"error": "pairing token not configured"},
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        provided = _extract_token(request)
        if provided != expected:
            return JSONResponse(
                {"error": "invalid pairing token"},
                status_code=status.HTTP_401_UNAUTHORIZED,
            )

        return await call_next(request)


def _extract_token(request: Request) -> str | None:
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()

    direct = request.headers.get("X-SheJane-Local-Token")
    if direct:
        return direct.strip()

    return None
