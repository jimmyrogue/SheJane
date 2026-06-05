"""HTTP tests for GET /local/v1/workspace-files.

The endpoint streams file bytes back to the React renderer for the
right-side DocPreviewPanel. It must:
  • require the path to live inside a previously-authorized workspace
  • 404 cleanly on missing files
  • 403 on paths outside any workspace
  • return the file bytes for the happy path
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import httpx
import pytest
from docx import Document
from fastapi.testclient import TestClient

from local_host.config import reset_settings_for_tests
from local_host.server import create_app


def _make_docx(path: Path) -> None:
    doc = Document()
    doc.add_paragraph("hello workspace-files")
    doc.save(path)


@pytest.fixture
def client(monkeypatch) -> TestClient:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-wsfiles-"))
    monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)

    # Mock backend AsyncClient so RunCoordinator startup doesn't try to
    # phone home during lifespan setup (it doesn't here, but stays
    # defensive — matches test_runs_http.py).
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="")

    class _Patched(httpx.AsyncClient):
        def __init__(self, **kw):
            super().__init__(
                transport=httpx.MockTransport(handler),
                **{k: v for k, v in kw.items() if k != "transport"},
            )

    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _Patched)
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp,
    )
    app = create_app(settings)
    with TestClient(app) as c:
        yield c


_AUTH = {"Authorization": "Bearer tok"}


def test_workspace_files_serves_authorized_file(client: TestClient, tmp_path: Path) -> None:
    """Happy path — file inside an authorized workspace returns the bytes."""
    _make_docx(tmp_path / "report.docx")
    auth = client.post(
        "/local/v1/workspaces",
        headers=_AUTH,
        json={"path": str(tmp_path), "label": "demo"},
    )
    assert auth.status_code == 200, auth.text
    r = client.get(
        "/local/v1/workspace-files",
        headers=_AUTH,
        params={"path": str(tmp_path / "report.docx")},
    )
    assert r.status_code == 200, r.text
    # Bytes should start with the PK ZIP magic that all OOXML files have.
    assert r.content[:2] == b"PK"
    # Server should set a Content-Disposition with the filename (Starlette
    # emits `attachment; filename="report.docx"` by default; we don't
    # care which disposition type, just that it survived).
    cd = r.headers.get("content-disposition", "")
    assert "report.docx" in cd


def test_workspace_files_serves_non_ascii_filename(client: TestClient, tmp_path: Path) -> None:
    """Regression: filenames with CJK characters must survive the header
    encoding. Browsers can't send raw non-ASCII in HTTP header values
    (latin-1 only over ASGI); the response Content-Disposition needs
    RFC 5987 `filename*=utf-8''...` encoding. Starlette's FileResponse
    does this when you pass `filename=` and don't override the header.
    A previous version of this handler set a custom inline header that
    contained raw CJK, which crashed the response and surfaced as
    "Failed to fetch" in the renderer.
    """
    cjk_name = "副本软件开发合同模板.docx"
    _make_docx(tmp_path / cjk_name)
    auth = client.post(
        "/local/v1/workspaces",
        headers=_AUTH,
        json={"path": str(tmp_path), "label": "demo"},
    )
    assert auth.status_code == 200, auth.text
    r = client.get(
        "/local/v1/workspace-files",
        headers=_AUTH,
        params={"path": str(tmp_path / cjk_name)},
    )
    assert r.status_code == 200, r.text
    assert r.content[:2] == b"PK"
    cd = r.headers.get("content-disposition", "")
    # RFC 5987 percent-encoded filename — "副" → "%E5%89%AF", etc.
    assert "filename*" in cd.lower()
    assert "utf-8" in cd.lower()


def test_workspace_files_rejects_path_outside_workspace(client: TestClient, tmp_path: Path) -> None:
    """A file that exists but lives outside any workspace → 403, not 200."""
    _make_docx(tmp_path / "report.docx")
    # Note: no workspace registered for tmp_path. Expect 403 from the
    # path-scope check.
    r = client.get(
        "/local/v1/workspace-files",
        headers=_AUTH,
        params={"path": str(tmp_path / "report.docx")},
    )
    assert r.status_code == 403
    assert "workspace" in r.text


def test_workspace_files_returns_404_for_missing_file(client: TestClient, tmp_path: Path) -> None:
    """Authorized workspace but the file doesn't exist → 404."""
    auth = client.post(
        "/local/v1/workspaces",
        headers=_AUTH,
        json={"path": str(tmp_path), "label": "demo"},
    )
    assert auth.status_code == 200, auth.text
    r = client.get(
        "/local/v1/workspace-files",
        headers=_AUTH,
        params={"path": str(tmp_path / "missing.docx")},
    )
    assert r.status_code == 404


def test_workspace_files_requires_path_param(client: TestClient) -> None:
    """Empty path → 422 from FastAPI's required-param validation."""
    r = client.get("/local/v1/workspace-files", headers=_AUTH)
    # FastAPI surfaces missing required Query params as 422 (validation
    # error), not 400. Both signal "client gave us nonsense".
    assert r.status_code in {400, 422}
