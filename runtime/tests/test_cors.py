"""Contract tests for CORS on `/v1/*`.

The Electron renderer loads from the Vite dev server at
`http://127.0.0.1:55173` (or `file://` in production). The runtime binds
loopback at `:17371` — different origin. Without proper CORS headers,
every browser-side fetch fails at the preflight step and the Client
cannot reach its Runtime.

These tests lock the default CORS allow-list to "any loopback origin +
file:// (`null`)" and verify the SHEJANE_RUNTIME_CORS_ORIGINS env
override.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

from shejane_runtime.config import reset_settings_for_tests
from shejane_runtime.server import create_app


def _build_client(monkeypatch, **env: str) -> TestClient:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-cors-"))
    os.environ["SHEJANE_RUNTIME_TOKEN"] = "tok"
    monkeypatch.delenv("SHEJANE_RUNTIME_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    settings = reset_settings_for_tests(
        SHEJANE_RUNTIME_HOST="127.0.0.1",
        SHEJANE_RUNTIME_PORT=17371,
        SHEJANE_RUNTIME_TOKEN="tok",
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
            "/v1/health",
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
            "/v1/health",
            headers={"Origin": "http://127.0.0.1:55173"},
        )
        assert resp.headers.get("access-control-allow-origin") == "http://127.0.0.1:55173"


def test_cors_allows_localhost_origin(monkeypatch) -> None:
    """Both `127.0.0.1` and `localhost` are valid loopback aliases —
    Electron / browsers may pick either depending on platform."""
    with _build_client(monkeypatch) as client:
        resp = client.get(
            "/v1/health",
            headers={"Origin": "http://localhost:55173"},
        )
        assert resp.headers.get("access-control-allow-origin") == "http://localhost:55173"


def test_cors_allows_file_origin_for_production_electron(monkeypatch) -> None:
    """Production Electron loads the renderer over `file://`, which
    browsers serialize to the literal string `null` in the Origin
    header."""
    with _build_client(monkeypatch) as client:
        resp = client.get(
            "/v1/health",
            headers={"Origin": "null"},
        )
        assert resp.headers.get("access-control-allow-origin") == "null"


def test_cors_blocks_non_loopback_origin(monkeypatch) -> None:
    """An attacker hosting a malicious page on the public internet must
    NOT be able to coax the user's browser into talking to their local
    runtime — even with the pairing token leaked, CORS is defence in
    depth."""
    with _build_client(monkeypatch) as client:
        resp = client.get(
            "/v1/health",
            headers={"Origin": "https://attacker.example.com"},
        )
        # Body is returned (CORS is enforced client-side), but the header
        # must NOT echo the disallowed origin.
        assert resp.headers.get("access-control-allow-origin") != "https://attacker.example.com"


def test_cors_env_override(monkeypatch) -> None:
    """An operator fronting the runtime behind a custom reverse proxy can
    pin the allow-list via SHEJANE_RUNTIME_CORS_ORIGINS."""
    with _build_client(
        monkeypatch,
        SHEJANE_RUNTIME_CORS_ORIGINS="https://my-proxy.example.com,https://other.example.com",
    ) as client:
        resp = client.get(
            "/v1/health",
            headers={"Origin": "https://my-proxy.example.com"},
        )
        assert resp.headers.get("access-control-allow-origin") == "https://my-proxy.example.com"

        # Loopback is no longer allowed once the operator pins the list.
        resp = client.get(
            "/v1/health",
            headers={"Origin": "http://127.0.0.1:55173"},
        )
        assert resp.headers.get("access-control-allow-origin") != "http://127.0.0.1:55173"


def test_cors_allows_authorization_header(monkeypatch) -> None:
    """Every /v1 endpoint sits behind Bearer auth — the preflight
    MUST whitelist the `Authorization` request header or browsers strip
    it and the runtime 401s."""
    with _build_client(monkeypatch) as client:
        resp = client.options(
            "/v1/runtime",
            headers={
                "Origin": "http://127.0.0.1:55173",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        )
        allowed = (resp.headers.get("access-control-allow-headers") or "").lower()
        assert "authorization" in allowed or allowed == "*"
