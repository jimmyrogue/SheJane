"""Contract tests for `/local/v1/session` (POST / GET / DELETE).

These lock the response shape to the TypeScript `LocalCloudSession`
interface in `packages/runtime-client/src/client.ts`:

    interface LocalCloudSession {
      connected: boolean
      cloud_base_url?: string
      auth?: 'bearer'
      updated_at?: string
    }

The client gates its "use local agent" feature flag on
`session.connected === true`. If the daemon returns anything else
(historically `{ok: true}`), `session.connected` is `undefined`, the
gate stays closed, and chat silently falls back to the cloud-only path.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from local_host.config import reset_settings_for_tests
from local_host.server import create_app


@pytest.fixture
def client(monkeypatch) -> TestClient:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-session-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://localhost:8080",
        data_dir=tmp,
    )
    app = create_app(settings)
    with TestClient(app) as c:
        yield c


HEADERS = {"Authorization": "Bearer tok"}


def test_get_session_unpaired_returns_connected_false(client: TestClient) -> None:
    resp = client.get("/local/v1/session", headers=HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    # MUST have `connected` key — the client checks `session.connected`
    assert body == {"connected": False}


def test_post_session_returns_localcloudsession_shape(client: TestClient) -> None:
    resp = client.post(
        "/local/v1/session",
        headers=HEADERS,
        json={
            "cloud_base_url": "http://localhost:8080",
            "access_token": "test-jwt-token",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    # All four LocalCloudSession fields must be present + correctly typed.
    assert body["connected"] is True
    assert body["cloud_base_url"] == "http://localhost:8080"
    assert body["auth"] == "bearer"
    assert isinstance(body["updated_at"], str) and body["updated_at"]


def test_post_session_overrides_cloud_base_url(client: TestClient) -> None:
    """The JWT was issued against the supplied cloud — daemon must talk
    to THAT cloud, not whatever SHEJANE_CLOUD_BASE_URL was at boot."""
    resp = client.post(
        "/local/v1/session",
        headers=HEADERS,
        json={
            "cloud_base_url": "https://staging.example.com",
            "access_token": "staging-jwt",
        },
    )
    assert resp.json()["cloud_base_url"] == "https://staging.example.com"

    get_resp = client.get("/local/v1/session", headers=HEADERS).json()
    assert get_resp["connected"] is True
    assert get_resp["cloud_base_url"] == "https://staging.example.com"


def test_post_session_rejects_missing_token(client: TestClient) -> None:
    resp = client.post(
        "/local/v1/session",
        headers=HEADERS,
        json={"cloud_base_url": "http://localhost:8080"},
    )
    # FastAPI returns 422 for pydantic validation errors (missing
    # required field). Client-side both 400 and 422 surface as a
    # thrown error — semantically equivalent for the renderer.
    assert resp.status_code in (400, 422)


def test_get_session_after_pairing_returns_full_payload(client: TestClient) -> None:
    client.post(
        "/local/v1/session",
        headers=HEADERS,
        json={
            "cloud_base_url": "http://localhost:8080",
            "access_token": "test-jwt-token",
        },
    )
    resp = client.get("/local/v1/session", headers=HEADERS)
    body = resp.json()
    assert body["connected"] is True
    assert body["cloud_base_url"] == "http://localhost:8080"
    assert body["auth"] == "bearer"
    assert "updated_at" in body


def test_delete_session_returns_connected_false(client: TestClient) -> None:
    client.post(
        "/local/v1/session",
        headers=HEADERS,
        json={
            "cloud_base_url": "http://localhost:8080",
            "access_token": "test-jwt-token",
        },
    )
    resp = client.delete("/local/v1/session", headers=HEADERS)
    assert resp.status_code == 200
    # Mirrors the TS test in apps/desktop/src/shared/local-host/client.test.ts:239
    assert resp.json() == {"connected": False}

    # GET after DELETE: still must have `connected` key (now false).
    get_resp = client.get("/local/v1/session", headers=HEADERS).json()
    assert get_resp == {"connected": False}


def test_session_endpoints_require_auth(client: TestClient) -> None:
    """Pairing endpoints sit behind the same Bearer auth as the rest of
    /local/v1 — a missing token is 401, not a silent passthrough."""
    assert client.get("/local/v1/session").status_code == 401
    assert (
        client.post(
            "/local/v1/session",
            json={"access_token": "x", "cloud_base_url": "http://x"},
        ).status_code
        == 401
    )
    assert client.delete("/local/v1/session").status_code == 401
