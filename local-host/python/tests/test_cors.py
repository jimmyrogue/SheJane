"""Contract tests for CORS on `/local/v1/*`.

The Electron renderer loads from the Vite dev server at
`http://127.0.0.1:55173` (or `file://` in production). The daemon binds
loopback at `:17371` — different origin. Without proper CORS headers,
every browser-side fetch fails at the preflight step and the pairing
handshake (`POST /local/v1/session`) never reaches the server, leaving
chat silently routed through the cloud-only path.

These tests lock the default CORS allow-list to "any loopback origin +
file:// (`null`)" and verify the JIANDANLY_LOCAL_CORS_ORIGINS env
override.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from local_host.config import reset_settings_for_tests
from local_host.server import create_app


def _build_client(monkeypatch, **env: str) -> TestClient:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-cors-"))
    os.environ["JIANDANLY_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.delenv("JIANDANLY_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    settings = reset_settings_for_tests(
        JIANDANLY_LOCAL_HOST_ADDR="127.0.0.1",
        JIANDANLY_LOCAL_HOST_PORT=17371,
        JIANDANLY_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp,
    )
    app = create_app(settings)
    return TestClient(app)


def test_cors_allows_vite_dev_origin(monkeypatch) -> None:
    """The Vite dev port is the primary failure case — the user's actual
    bug was the bridge probe getting CORS-blocked at this origin."""
    with _build_client(monkeypatch) as client:
        # Preflight (OPTIONS) before the actual fetch.
        resp = client.options(
            "/local/v1/health",
            headers={
                "Origin": "http://127.0.0.1:55173",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert resp.status_code == 200
        assert resp.headers.get("access-control-allow-origin") == "http://127.0.0.1:55173"

        # Actual GET should also carry the header so the browser exposes
        # the body to JS.
        resp = client.get(
            "/local/v1/health",
            headers={"Origin": "http://127.0.0.1:55173"},
        )
        assert resp.headers.get("access-control-allow-origin") == "http://127.0.0.1:55173"


def test_cors_allows_localhost_origin(monkeypatch) -> None:
    """Both `127.0.0.1` and `localhost` are valid loopback aliases —
    Electron / browsers may pick either depending on platform."""
    with _build_client(monkeypatch) as client:
        resp = client.get(
            "/local/v1/health",
            headers={"Origin": "http://localhost:55173"},
        )
        assert resp.headers.get("access-control-allow-origin") == "http://localhost:55173"


def test_cors_allows_file_origin_for_production_electron(monkeypatch) -> None:
    """Production Electron loads the renderer over `file://`, which
    browsers serialize to the literal string `null` in the Origin
    header."""
    with _build_client(monkeypatch) as client:
        resp = client.get(
            "/local/v1/health",
            headers={"Origin": "null"},
        )
        assert resp.headers.get("access-control-allow-origin") == "null"


def test_cors_blocks_non_loopback_origin(monkeypatch) -> None:
    """An attacker hosting a malicious page on the public internet must
    NOT be able to coax the user's browser into talking to their local
    daemon — even with the pairing token leaked, CORS is defence in
    depth."""
    with _build_client(monkeypatch) as client:
        resp = client.get(
            "/local/v1/health",
            headers={"Origin": "https://attacker.example.com"},
        )
        # Body is returned (CORS is enforced client-side), but the header
        # must NOT echo the disallowed origin.
        assert resp.headers.get("access-control-allow-origin") != "https://attacker.example.com"


def test_cors_env_override(monkeypatch) -> None:
    """An operator fronting the daemon behind a custom reverse proxy can
    pin the allow-list via JIANDANLY_LOCAL_CORS_ORIGINS."""
    with _build_client(
        monkeypatch,
        JIANDANLY_LOCAL_CORS_ORIGINS="https://my-proxy.example.com,https://other.example.com",
    ) as client:
        resp = client.get(
            "/local/v1/health",
            headers={"Origin": "https://my-proxy.example.com"},
        )
        assert (
            resp.headers.get("access-control-allow-origin")
            == "https://my-proxy.example.com"
        )

        # Loopback is no longer allowed once the operator pins the list.
        resp = client.get(
            "/local/v1/health",
            headers={"Origin": "http://127.0.0.1:55173"},
        )
        assert resp.headers.get("access-control-allow-origin") != "http://127.0.0.1:55173"


def test_cors_allows_authorization_header(monkeypatch) -> None:
    """Every /local/v1 endpoint sits behind Bearer auth — the preflight
    MUST whitelist the `Authorization` request header or browsers strip
    it and the daemon 401s."""
    with _build_client(monkeypatch) as client:
        resp = client.options(
            "/local/v1/session",
            headers={
                "Origin": "http://127.0.0.1:55173",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )
        allowed = (resp.headers.get("access-control-allow-headers") or "").lower()
        assert "authorization" in allowed or allowed == "*"
