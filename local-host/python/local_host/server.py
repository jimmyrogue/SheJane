"""FastAPI application + HTTP route surface.

Phase 2' deliverables:
- `/v1/health` (no auth)
- `/v1/tools` (list available tools — placeholder for now)
- `/v1/workspaces` (CRUD authorization records)
- `/v1/runs` (placeholder: real impl lands in Phase 3')
"""

from __future__ import annotations

import json
import logging
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from sse_starlette.sse import EventSourceResponse

from . import __version__
from .agent.builder import open_checkpointer
from .auth import PairingTokenAuthMiddleware
from .config import Settings, get_settings
from .runs import RunCoordinator
from .store.sqlite import LocalStore

log = logging.getLogger("local_host.server")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.ensure_data_dir()
    store = await LocalStore.open(settings.local_db_path)
    checkpointer, ck_stack = await open_checkpointer(settings)
    coordinator = RunCoordinator(store=store, checkpointer=checkpointer)
    app.state.store = store
    app.state.settings = settings
    app.state.checkpointer = checkpointer
    app.state.coordinator = coordinator
    log.info(
        "local-host started host=%s port=%s data=%s",
        settings.host,
        settings.port,
        settings.data_dir,
    )
    try:
        yield
    finally:
        await ck_stack.aclose()
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
        from .tools.registry import describe_tools

        # Phase 2': describe with the current store. workspace_root is
        # None at this layer because fs tools are bound per-run by the
        # agent builder (Phase 3'). Callers wanting the per-run view will
        # use a different endpoint then.
        store = getattr(app.state, "store", None)
        return {"tools": describe_tools(store=store, workspace_root=None)}

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

    @app.post("/v1/runs")
    async def create_run(body: dict[str, Any]) -> dict[str, Any]:
        goal = str(body.get("goal", "")).strip()
        if not goal:
            raise HTTPException(status_code=400, detail="goal required")
        coordinator: RunCoordinator = app.state.coordinator
        run = await coordinator.start_run(
            goal=goal,
            workspace_path=body.get("workspace_path"),
            mode=str(body.get("mode", "fast")),
        )
        return {"run": run}

    @app.get("/v1/runs/{run_id}")
    async def get_run(run_id: str) -> dict[str, Any]:
        store: LocalStore = app.state.store
        run = await store.get_run(run_id)
        if not run:
            raise HTTPException(status_code=404, detail="run not found")
        return {"run": run}

    @app.get("/v1/runs/{run_id}/stream")
    async def stream_run(run_id: str) -> EventSourceResponse:
        coordinator: RunCoordinator = app.state.coordinator

        async def gen():
            async for item in coordinator.stream(run_id):
                yield {
                    "event": item["event"],
                    "data": json.dumps(item["data"], default=str, ensure_ascii=False),
                }
            yield {"event": "stream.end", "data": "{}"}

        return EventSourceResponse(gen())

    @app.post("/v1/runs/{run_id}/cancel")
    async def cancel_run(run_id: str) -> dict[str, Any]:
        coordinator: RunCoordinator = app.state.coordinator
        ok = await coordinator.cancel_run(run_id)
        return {"canceled": ok}

    @app.post("/v1/runs/{run_id}/resume")
    async def resume_run(run_id: str, body: dict[str, Any]) -> dict[str, Any]:
        coordinator: RunCoordinator = app.state.coordinator
        decision = body or {"action": "approve"}
        ok = await coordinator.resume_run(run_id=run_id, decision=decision)
        if not ok:
            raise HTTPException(status_code=409, detail="run not paused")
        return {"resumed": True}

    return app


app = create_app()
