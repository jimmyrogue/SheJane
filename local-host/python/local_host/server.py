"""FastAPI application + HTTP route surface.

Phase 2' deliverables:
- `/v1/health` (no auth)
- `/v1/tools` (list available tools — placeholder for now)
- `/v1/workspaces` (CRUD authorization records)
- `/v1/runs` (placeholder: real impl lands in Phase 3')
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI

from . import __version__
from .auth import PairingTokenAuthMiddleware
from .config import Settings, get_settings
from .store.sqlite import LocalStore

log = logging.getLogger("local_host.server")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.ensure_data_dir()
    store = await LocalStore.open(settings.local_db_path)
    app.state.store = store
    app.state.settings = settings
    log.info(
        "local-host started host=%s port=%s data=%s",
        settings.host,
        settings.port,
        settings.data_dir,
    )
    try:
        yield
    finally:
        await store.close()
        log.info("local-host shutdown clean")


def create_app(settings: Settings | None = None) -> FastAPI:
    if settings is None:
        settings = get_settings()

    app = FastAPI(
        title="Jiandanly Local Host",
        version=__version__,
        lifespan=lifespan,
    )
    app.add_middleware(PairingTokenAuthMiddleware)

    @app.get("/v1/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "version": __version__,
            "pairing_configured": bool(settings.pairing_token),
        }

    @app.get("/v1/tools")
    async def list_tools() -> dict[str, Any]:
        # Phase 2': real tool list will be populated when registry is built.
        # We return the registry's view (currently empty).
        from .tools.registry import describe_tools

        return {"tools": describe_tools()}

    @app.get("/v1/workspaces")
    async def list_workspaces() -> dict[str, Any]:
        store: LocalStore = app.state.store
        return {"workspaces": await store.list_workspaces()}

    @app.post("/v1/workspaces")
    async def add_workspace(body: dict[str, Any]) -> dict[str, Any]:
        store: LocalStore = app.state.store
        path = str(body.get("path", "")).strip()
        label = str(body.get("label", "")).strip()
        if not path:
            return {"error": "path required", "code": 40201}
        ws = await store.create_workspace(path=path, label=label or path)
        return {"workspace": ws}

    @app.delete("/v1/workspaces/{workspace_id}")
    async def remove_workspace(workspace_id: str) -> dict[str, Any]:
        store: LocalStore = app.state.store
        deleted = await store.delete_workspace(workspace_id)
        return {"deleted": deleted}

    return app


app = create_app()
