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
import os
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from sse_starlette.sse import EventSourceResponse

from . import __version__
from .agent.builder import open_checkpointer, open_store
from .auth import PairingTokenAuthMiddleware
from .config import Settings, get_settings
from .runs import RunCoordinator
from .store.sqlite import LocalStore

log = logging.getLogger("local_host.server")


def _list_skill_files() -> list[dict[str, str]]:
    """Lightweight skill catalog for the HTTP layer — independent of any
    running agent. Reads md files from JIANDANLY_LOCAL_SKILLS_PATH and
    returns {name, title, description, path}. Skill *invocation* (loading
    full content into prompts) happens via deepagents SkillsMiddleware
    inside a run; this endpoint just answers "what's available?"
    """
    custom = os.environ.get("JIANDANLY_LOCAL_SKILLS_PATH")
    skills_dir = Path(custom) if custom else Path.home() / ".jiandanly" / "skills"
    skills_dir = skills_dir.expanduser()
    if not skills_dir.is_dir():
        return []
    out: list[dict[str, str]] = []
    for md in sorted(skills_dir.glob("*.md")):
        try:
            text = md.read_text(encoding="utf-8")
        except OSError:
            continue
        title, description = _parse_frontmatter_minimal(text)
        out.append(
            {
                "name": md.stem,
                "title": title or md.stem,
                "description": description,
                "path": str(md),
            }
        )
    return out


def _parse_frontmatter_minimal(text: str) -> tuple[str, str]:
    """Extract title + description from a `--- key: value ---` YAML-lite
    prefix without pulling in a full yaml parser."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return "", ""
    title = description = ""
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if ":" in line:
            key, _, value = line.partition(":")
            k = key.strip().lower()
            v = value.strip()
            if k == "title":
                title = v
            elif k == "description":
                description = v
    return title, description


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    settings.ensure_data_dir()
    store = await LocalStore.open(settings.local_db_path)
    checkpointer, ck_stack = await open_checkpointer(settings)
    agent_store, store_stack = await open_store(settings)
    coordinator = RunCoordinator(
        store=store,
        checkpointer=checkpointer,
        agent_store=agent_store,
    )
    app.state.store = store
    app.state.settings = settings
    app.state.checkpointer = checkpointer
    app.state.agent_store = agent_store
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
        await store_stack.aclose()
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

    @app.get("/local/v1/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "version": __version__,
            "pairing_configured": bool(settings.pairing_token),
        }

    @app.get("/local/v1/tools")
    async def list_tools() -> dict[str, Any]:
        from .tools.registry import describe_tools

        # Phase 2': describe with the current store. workspace_root is
        # None at this layer because fs tools are bound per-run by the
        # agent builder (Phase 3'). Callers wanting the per-run view will
        # use a different endpoint then.
        store = getattr(app.state, "store", None)
        return {"tools": describe_tools(store=store, workspace_root=None)}

    @app.get("/local/v1/workspaces")
    async def list_workspaces() -> dict[str, Any]:
        store: LocalStore = app.state.store
        return {"workspaces": await store.list_workspaces()}

    @app.post("/local/v1/workspaces")
    async def add_workspace(body: dict[str, Any]) -> dict[str, Any]:
        store: LocalStore = app.state.store
        path = str(body.get("path", "")).strip()
        label = str(body.get("label", "")).strip()
        if not path:
            return {"error": "path required", "code": 40201}
        ws = await store.create_workspace(path=path, label=label or path)
        return {"workspace": ws}

    @app.delete("/local/v1/workspaces/{workspace_id}")
    async def remove_workspace(workspace_id: str) -> dict[str, Any]:
        store: LocalStore = app.state.store
        deleted = await store.delete_workspace(workspace_id)
        return {"deleted": deleted}

    @app.post("/local/v1/runs")
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

    @app.get("/local/v1/runs/{run_id}")
    async def get_run(run_id: str) -> dict[str, Any]:
        store: LocalStore = app.state.store
        run = await store.get_run(run_id)
        if not run:
            raise HTTPException(status_code=404, detail="run not found")
        return {"run": run}

    @app.get("/local/v1/runs/{run_id}/stream")
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

    @app.post("/local/v1/runs/{run_id}/cancel")
    async def cancel_run(run_id: str) -> dict[str, Any]:
        coordinator: RunCoordinator = app.state.coordinator
        ok = await coordinator.cancel_run(run_id)
        return {"canceled": ok}

    @app.post("/local/v1/runs/{run_id}/resume")
    async def resume_run(run_id: str, body: dict[str, Any]) -> dict[str, Any]:
        coordinator: RunCoordinator = app.state.coordinator
        decision = body or {"action": "approve"}
        ok = await coordinator.resume_run(run_id=run_id, decision=decision)
        if not ok:
            raise HTTPException(status_code=409, detail="run not paused")
        return {"resumed": True}

    # ---- compatibility shims the client expects (pre-existing Node API) ----
    #
    # Some of these are full features that didn't make it into Phase 3'/4'
    # yet. They return safe defaults / 501 so the client can boot without
    # crashing on missing routes. Implementations land in Phase 6'+.

    @app.post("/local/v1/permissions/{permission_id}")
    async def resolve_permission(permission_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Alias for resume_run — clients address the permission, we look
        up its run and resume that.

        Phase 5' stub: today we don't persist a permission→run index from
        the HumanInTheLoopMiddleware path, so the body is expected to also
        contain `run_id`. Phase 6'+ replaces this with the proper lookup.
        """
        run_id = body.get("run_id")
        if not run_id:
            raise HTTPException(
                status_code=400,
                detail="phase 5' stub: please include run_id in body",
            )
        coordinator: RunCoordinator = app.state.coordinator
        ok = await coordinator.resume_run(run_id=run_id, decision=body)
        if not ok:
            raise HTTPException(status_code=409, detail="run not paused")
        return {"permission_id": permission_id, "resolved": True}

    @app.post("/local/v1/questions/{question_id}")
    async def answer_question(question_id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Same shape as permissions — Phase 6'+ will route via a question
        registry. For now, route to resume_run if the caller knows run_id."""
        run_id = body.get("run_id")
        if not run_id:
            raise HTTPException(
                status_code=400,
                detail="phase 5' stub: please include run_id in body",
            )
        coordinator: RunCoordinator = app.state.coordinator
        ok = await coordinator.resume_run(run_id=run_id, decision=body)
        if not ok:
            raise HTTPException(status_code=409, detail="run not paused")
        return {"question_id": question_id, "answered": True}

    @app.get("/local/v1/artifacts/{artifact_id}")
    async def get_artifact(artifact_id: str) -> dict[str, Any]:
        """Stub: artifact persistence not yet ported from Node daemon."""
        raise HTTPException(
            status_code=404,
            detail=f"artifact {artifact_id} not found (phase 5' stub)",
        )

    @app.get("/local/v1/runs/{run_id}/diagnostics")
    async def run_diagnostics(run_id: str) -> dict[str, Any]:
        """Bundle a run's metadata + event tail for client-side debugging."""
        store: LocalStore = app.state.store
        run = await store.get_run(run_id)
        if not run:
            raise HTTPException(status_code=404, detail="run not found")
        events = await store.events_since(run_id, after_seq=0)
        return {"run": run, "events": events}

    @app.post("/local/v1/session")
    async def set_cloud_session(body: dict[str, Any]) -> dict[str, Any]:
        """Stash a cloud bearer token for outbound LLM calls.

        Today the token comes from env (JIANDANLY_CLOUD_TOKEN). The client
        endpoint exists so users can refresh tokens at runtime; Phase 6'+
        wires this into Settings live.
        """
        token = str(body.get("access_token") or body.get("token") or "")
        if not token:
            raise HTTPException(status_code=400, detail="token required")
        settings = app.state.settings
        settings.cloud_token = token  # type: ignore[misc]
        return {"ok": True}

    @app.delete("/local/v1/session")
    async def clear_cloud_session() -> dict[str, Any]:
        settings = app.state.settings
        settings.cloud_token = ""  # type: ignore[misc]
        return {"ok": True}

    @app.get("/local/v1/session")
    async def get_cloud_session() -> dict[str, Any]:
        settings = app.state.settings
        return {"configured": bool(getattr(settings, "cloud_token", ""))}

    @app.post("/local/v1/workspaces/diagnose")
    async def diagnose_workspace(body: dict[str, Any]) -> dict[str, Any]:
        """Check whether a candidate path is acceptable for workspace.open."""
        import os as _os
        from pathlib import Path as _Path

        path = str(body.get("path", "")).strip()
        if not path:
            raise HTTPException(status_code=400, detail="path required")
        resolved = _os.path.abspath(_os.path.expanduser(path))
        ok = _Path(resolved).is_dir()
        return {
            "ok": ok,
            "resolved_path": resolved,
            "reason": "" if ok else "not a directory",
        }

    @app.get("/local/v1/skills")
    async def list_local_skills() -> dict[str, Any]:
        return {"skills": _list_skill_files()}

    @app.get("/local/v1/skills/registry")
    async def search_skill_registry(q: str = "") -> dict[str, Any]:
        """Phase 5' stub: no external skill registry wired yet."""
        return {"q": q, "skills": []}

    @app.post("/local/v1/skills/install")
    async def install_skill(body: dict[str, Any]) -> dict[str, Any]:
        raise HTTPException(
            status_code=501,
            detail="skill install not implemented (phase 6'+ feature)",
        )

    return app


app = create_app()
