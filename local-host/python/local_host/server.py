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
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sse_starlette.sse import EventSourceResponse

from . import __version__
from .agent.builder import open_checkpointer, open_store
from .api_schemas import (
    AnswerQuestionRequest,
    CancelRunResponse,
    ClearMemoryResponse,
    CreateRunRequest,
    CreateWorkspaceRequest,
    DiagnoseWorkspaceRequest,
    HealthResponse,
    ListRunsResponse,
    ListWorkspacesResponse,
    LocalArtifact,
    LocalCloudSession,
    LocalRun,
    LocalRunDiagnostics,
    LocalWorkspaceAuthorization,
    LocalWorkspaceDiagnosis,
    McpServerCatalog,
    McpServerInfo,
    PermissionResolution,
    QuestionAnswer,
    ResolvePermissionRequest,
    ResumeRunResponse,
    SetCloudSessionRequest,
)
from .auth import PairingTokenAuthMiddleware
from .config import Settings, get_settings
from .runs import RunCoordinator
from .store.sqlite import LocalStore

log = logging.getLogger("local_host.server")


def _list_skill_files() -> list[dict[str, str]]:
    """Lightweight skill catalog for the HTTP layer — independent of any
    running agent. Walks every roots `_resolve_skills_dirs` returns and
    finds skills in the Anthropic / skills.sh format: each skill is a
    directory containing `SKILL.md` with YAML frontmatter. Returns
    `{name, title, description, path, source}` where `source` is the
    last component of the root (`shejane`, `claude`, …) so the UI can
    group entries by provenance.

    Skill *invocation* (loading full content into prompts) happens via
    deepagents SkillsMiddleware inside a run; this endpoint just answers
    "what's available?". Only the SKILL.md directory format is listed
    because deepagents only loads that format — a flat `.md` would show
    up here but never reach the model.
    """
    from .agent.builder import _resolve_skills_dirs

    out: list[dict[str, str]] = []
    seen_names: set[str] = set()
    for root in _resolve_skills_dirs():
        # `source` is the parent's name stripped of any leading dot, so
        # `~/.shejane/skills/` reports `shejane`, `~/.claude/skills/`
        # reports `claude`, and a custom env override like
        # `/abs/foo/skills/` reports `foo`. This is what the renderer
        # groups by — `root.name` itself is always literally "skills"
        # so it's useless as a label.
        source = (root.parent.name or root.name).lstrip(".")
        for entry in sorted(root.iterdir()):
            if not entry.is_dir() or entry.name.startswith(("_", ".")):
                continue
            skill_md = entry / "SKILL.md"
            if not skill_md.is_file():
                continue
            try:
                text = skill_md.read_text(encoding="utf-8")
            except OSError:
                continue
            # Use frontmatter `name` over directory name when present;
            # fall back to dir name. Dedupe across roots — first source
            # wins, matching deepagents' "later sources override earlier"
            # convention in reverse (we list shejane first so it's the
            # canonical name when both roots have the same skill).
            title, description = _parse_frontmatter_minimal(text)
            display_name = entry.name
            if display_name in seen_names:
                continue
            seen_names.add(display_name)
            out.append(
                {
                    "name": display_name,
                    "title": title or display_name,
                    "description": description,
                    "path": str(skill_md),
                    "source": source,
                    "root_path": str(root),
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
    # Make sure the canonical user-managed skills dir exists from boot —
    # otherwise it's invisible to the UI until the user manually creates
    # it, and the "Personal" section silently disappears from the list.
    (Path.home() / ".shejane" / "skills").mkdir(parents=True, exist_ok=True)
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
    # Reconcile runs the previous process left non-terminal (the daemon is
    # SIGKILLed on every `make dev-electron` restart): fail dead queued/running
    # runs, leave waiting_permission runs resumable. Without this they sit
    # `running` forever and the client never sees a terminal state.
    await coordinator.recover_orphans()
    # Filled by POST /local/v1/session; cleared by DELETE. Surfaces in the
    # GET response so the client can show "paired Xs ago".
    app.state.cloud_session_updated_at = None
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
        title="SheJane Local Host",
        version=__version__,
        lifespan=lifespan,
    )

    # Order matters: middleware added LAST runs FIRST on the request path
    # (Starlette wraps outward). PairingTokenAuthMiddleware must sit
    # behind CORSMiddleware so that:
    #   1. CORS preflight (OPTIONS) is answered by CORSMiddleware without
    #      ever hitting auth — preflight by spec carries no credentials,
    #      so rejecting it with 401 makes every browser fetch fail.
    #   2. Even authenticated-but-401 responses still ship the
    #      Access-Control-Allow-Origin header, otherwise the browser
    #      hides the error body from the JS layer.
    app.add_middleware(PairingTokenAuthMiddleware)

    # CORS — the daemon binds loopback only, but the Vite dev server (and
    # the production Electron renderer when loaded over file://) live on a
    # different origin than `:17371`. Without these headers, every
    # browser-side fetch fails preflight and the pairing handshake
    # (`POST /local/v1/session`) never reaches us. Bearer-token auth
    # (PairingTokenAuthMiddleware above) is the real gate; CORS is just
    # plumbing.
    #
    # Override via env if you front the daemon with a custom reverse proxy.
    cors_origins_env = os.environ.get("SHEJANE_LOCAL_CORS_ORIGINS", "").strip()
    if cors_origins_env:
        allow_origins = [o.strip() for o in cors_origins_env.split(",") if o.strip()]
        allow_origin_regex = None
    else:
        # Permit any localhost/loopback origin (dev Vite at 55173, prod
        # Electron file:// shows up as `null`, plus any 5173/5174/etc.).
        allow_origins = ["null"]
        allow_origin_regex = r"^(?:https?://)?(?:127\.0\.0\.1|localhost)(?::\d+)?$"
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allow_origins,
        allow_origin_regex=allow_origin_regex,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/local/v1/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        # Two consumers, two contracts — both must be satisfied:
        #   • scripts/smoke-local-host.sh checks `ok == true`
        #   • client/src/shared/local-host/client.ts:probeLocalHost
        #     checks `status === "ok"` and reads mode/worker
        # The HealthResponse defaults already encode `ok=True status="ok"`
        # mode="ready" worker="python-langgraph" — only `version` and
        # `pairing_configured` need to be filled per-request.
        return HealthResponse(
            version=__version__,
            pairing_configured=bool(settings.pairing_token),
        )

    @app.get("/local/v1/tools")
    async def list_tools() -> dict[str, Any]:
        from .tools.registry import describe_tools

        # Phase 2': describe with the current store. workspace_root is
        # None at this layer because fs tools are bound per-run by the
        # agent builder (Phase 3'). Callers wanting the per-run view will
        # use a different endpoint then.
        store = getattr(app.state, "store", None)
        return {"tools": describe_tools(store=store, workspace_root=None)}

    @app.get("/local/v1/workspaces", response_model=ListWorkspacesResponse)
    async def list_workspaces() -> dict[str, Any]:
        store: LocalStore = app.state.store
        return {"workspaces": await store.list_workspaces()}

    @app.post("/local/v1/workspaces", response_model=LocalWorkspaceAuthorization)
    async def add_workspace(body: CreateWorkspaceRequest) -> dict[str, Any]:
        """Authorize a workspace path. Returns the flat row — the TS
        `authorizeLocalWorkspace` reads `.id / .path / .label` directly
        (no wrapper)."""
        store: LocalStore = app.state.store
        path = body.path.strip()
        if not path:
            raise HTTPException(status_code=400, detail="path required")
        return await store.create_workspace(path=path, label=body.label.strip() or path)

    @app.delete(
        "/local/v1/workspaces/{workspace_id}",
        response_model=LocalWorkspaceAuthorization,
    )
    async def remove_workspace(workspace_id: str) -> dict[str, Any]:
        """Revoke a workspace authorization. Returns the deleted row
        matching the TS `revokeLocalWorkspace` →
        `Promise<LocalWorkspaceAuthorization>` signature."""
        store: LocalStore = app.state.store
        # Fetch before delete so we can return the record. If it didn't
        # exist, surface a 404 — client `decodeLocalResponse` throws
        # which the renderer catches and shows to the user.
        existing = None
        for ws in await store.list_workspaces():
            if ws["id"] == workspace_id:
                existing = ws
                break
        if existing is None:
            raise HTTPException(status_code=404, detail="workspace not found")
        await store.delete_workspace(workspace_id)
        return existing

    @app.get("/local/v1/runs", response_model=ListRunsResponse)
    async def list_runs() -> dict[str, Any]:
        """Recent runs newest-first.

        Client `listLocalRuns()` (client/src/shared/local-host/client.ts:283)
        reads `{runs: LocalRun[]}` on every boot. Previously this route
        didn't exist — every Electron launch silently 404'd here and
        the conversation history sidebar came up empty.
        """
        store: LocalStore = app.state.store
        runs = await store.list_runs()
        return {"runs": runs}

    @app.post("/local/v1/runs", response_model=LocalRun)
    async def create_run(body: CreateRunRequest) -> dict[str, Any]:
        """Create a new run. Returns the flat `LocalRun` shape (NOT
        `{run: {...}}`) — that's the contract `client.test.ts:63-92`
        pins and what TypeScript's `createLocalRun` reads via
        `decodeLocalResponse<LocalRun>`."""
        goal = body.goal.strip()
        if not goal:
            raise HTTPException(status_code=400, detail="goal required")
        coordinator: RunCoordinator = app.state.coordinator
        return await coordinator.start_run(
            goal=goal,
            workspace_path=body.workspace_path,
            # The daemon's internal `mode` plumbing now carries the model id
            # (or "auto"); resolution happens cloud-side.
            mode=body.model,
            history=body.history or [],
            parent_run_id=body.parent_run_id,
            settings=body.settings,
        )

    @app.get("/local/v1/runs/{run_id}", response_model=LocalRun)
    async def get_run(run_id: str) -> dict[str, Any]:
        """Return the flat run record (same shape as POST /runs)."""
        store: LocalStore = app.state.store
        run = await store.get_run(run_id)
        if not run:
            raise HTTPException(status_code=404, detail="run not found")
        return run

    @app.get("/local/v1/runs/{run_id}/stream")
    async def stream_run(run_id: str) -> EventSourceResponse:
        coordinator: RunCoordinator = app.state.coordinator

        async def gen():
            # The client's `parseAgentSSEChunk` (sse.ts) reads
            #   data: {"event_type": "...", "payload": {...}, "id":...}
            # and recognizes only `data: [DONE]` as the completion mark.
            # So we must:
            #   • dump the whole envelope into `data:` (not the bare
            #     payload like the old shape — that made event_type
            #     undefined on the client and the entire UI silently
            #     no-op'd);
            #   • end with `data: [DONE]` so the stream resolves.
            try:
                async for event in coordinator.stream(run_id):
                    yield {
                        "event": event["event_type"],
                        "data": json.dumps(event, default=str, ensure_ascii=False),
                    }
            finally:
                yield {"data": "[DONE]"}

        # `sep="\n"` (LF) — matches the cloud Go SSE endpoint at
        # /api/v1/agent/runs/:id/stream AND what the client's
        # parseAgentSSEBuffer expects (it splits on `/\n\n/`, which does
        # NOT match CRLF). sse-starlette's default `\r\n` is technically
        # spec-correct but breaks this client.
        return EventSourceResponse(gen(), sep="\n")

    @app.post("/local/v1/runs/{run_id}/cancel", response_model=CancelRunResponse)
    async def cancel_run(run_id: str) -> dict[str, Any]:
        coordinator: RunCoordinator = app.state.coordinator
        ok = await coordinator.cancel_run(run_id)
        return {"canceled": ok}

    @app.post("/local/v1/runs/{run_id}/resume", response_model=ResumeRunResponse)
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

    @app.post("/local/v1/permissions/{permission_id}", response_model=PermissionResolution)
    async def resolve_permission(
        permission_id: str, body: ResolvePermissionRequest
    ) -> dict[str, Any]:
        """Approve / deny a pending tool-permission request.

        Translates the client's `{decision, scope}` body into the
        `{"decisions": [{"type": "approve"|"reject", ...}]}` shape
        that `HumanInTheLoopMiddleware` expects on resume (the
        middleware does `interrupt(...)["decisions"]` and KeyError's
        on anything else).

        When `scope=run`, the coordinator caches the tool name so the
        auto-approve loop in `_drive_run` skips re-prompting on
        subsequent gates for the same tool in the same run.
        """
        decision_text = body.decision
        scope = body.scope
        store: LocalStore = app.state.store
        record = await store.get_permission(permission_id)
        if record is None:
            raise HTTPException(status_code=404, detail="permission not found")
        await store.resolve_permission(
            permission_id,
            status="approved" if decision_text == "approve" else "denied",
            scope=str(scope),
        )
        # Build the HITL decision list. The middleware expects N
        # decisions for N interrupted tool calls (one HITLRequest can
        # bundle several). For now we assume one tool call per
        # interrupt — the common case. Multi-tool batches would need
        # the client to collect all approvals before posting.
        hitl_decision: dict[str, Any]
        if decision_text == "approve":
            hitl_decision = {"type": "approve"}
        else:
            hitl_decision = {
                "type": "reject",
                "message": "Tool execution denied by user.",
            }
        coordinator: RunCoordinator = app.state.coordinator
        # If the user picked "Always allow for this run", cache the
        # tool name in the coordinator so the auto-approve loop in
        # `_drive_run` skips re-prompting on subsequent gates for the
        # same tool. Without this the agent runs into HITL again every
        # turn and the user has to click approve repeatedly.
        if decision_text == "approve" and scope == "run":
            coordinator.grant_tool_scope(record["run_id"], record["tool_name"])
        resume_payload = {"decisions": [hitl_decision]}
        ok = await coordinator.resume_run(run_id=record["run_id"], decision=resume_payload)
        # Emit `permission.resolved` onto the run's SSE queue so the
        # client's `hasPendingPermission` check (App.tsx:1339) clears
        # the in-flight approval card. Without this the card stays
        # rendered after the user clicks approve, even though the run
        # has already moved on.
        await coordinator.emit_for_run(
            record["run_id"],
            "permission.resolved",
            {
                "request_id": permission_id,
                "tool": record["tool_name"],
                "tool_name": record["tool_name"],
                "decision": decision_text,
                "scope": str(scope),
            },
        )
        return {
            "permission_id": permission_id,
            "resolved": True,
            "decision": decision_text,
            "scope": scope,
            "resumed": ok,
        }

    @app.post("/local/v1/questions/{question_id}", response_model=QuestionAnswer)
    async def answer_question(question_id: str, body: AnswerQuestionRequest) -> dict[str, Any]:
        """Submit answers to a paused user.ask interrupt.

        Body shape (per `client.ts:answerLocalQuestion`):
        `{answers: Record<string, string[]>}`. We look up the question
        by id to find its run_id, persist the answers, then resume.
        """
        answers = body.answers
        store: LocalStore = app.state.store
        record = await store.get_question(question_id)
        if record is None:
            raise HTTPException(status_code=404, detail="question not found")
        await store.answer_question(question_id, answers=answers)
        coordinator: RunCoordinator = app.state.coordinator
        # user.ask reads `answers` directly (see tools/user.py) — pass
        # both shapes for maximum compatibility.
        resume_payload = {"answers": answers, "question_id": question_id}
        ok = await coordinator.resume_run(run_id=record["run_id"], decision=resume_payload)
        # Mirror the permission flow: emit `question.answered` onto the
        # run's stream so the client's `hasPendingQuestion` check
        # (App.tsx:1352) clears the answer prompt UI.
        await coordinator.emit_for_run(
            record["run_id"],
            "question.answered",
            {
                "request_id": question_id,
                "answers": answers,
            },
        )
        return {
            "question_id": question_id,
            "answered": True,
            "resumed": ok,
        }

    @app.get("/local/v1/artifacts/{artifact_id}", response_model=LocalArtifact)
    async def get_artifact(artifact_id: str) -> dict[str, Any]:
        """Return a single artifact record.

        Shape matches the TS `LocalArtifact` interface
        (`client.ts:38-44`): `{id, title, content, tool_name?, created_at?}`.
        """
        store: LocalStore = app.state.store
        record = await store.get_artifact(artifact_id)
        if record is None:
            raise HTTPException(status_code=404, detail="artifact not found")
        return {
            "id": record["id"],
            "title": record["title"],
            "content": record["content"],
            "tool_name": record.get("tool_name"),
            "created_at": record["created_at"],
        }

    @app.get("/local/v1/workspace-files")
    async def get_workspace_file(
        path: str = Query(..., description="Absolute file path inside an authorized workspace"),
    ):
        """Stream a file's bytes back to the renderer.

        Gated by `local_workspaces` — the file's parent chain must be inside
        a path the user previously authorized via `workspace.open`. We do
        NOT serve arbitrary paths; that would let a compromised renderer
        exfiltrate the entire disk.

        Used by the right-side DocPreviewPanel to fetch .docx / .xlsx
        bytes for in-browser rendering (docx-preview, exceljs). No
        response_model — this is a binary stream, not a JSON shape, so
        it stays out of api_schemas.py / openapi.json by design.
        """
        if not path:
            raise HTTPException(status_code=400, detail="path required")
        resolved = Path(os.path.abspath(os.path.expanduser(path))).resolve()
        try:
            if not resolved.is_file():
                raise HTTPException(status_code=404, detail="file not found")
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"invalid path: {exc}") from exc
        store: LocalStore = app.state.store
        workspaces = await store.list_workspaces()
        # `is_relative_to` walks the parent chain; we need the file to live
        # under *some* authorized workspace root.
        roots = [
            Path(os.path.abspath(os.path.expanduser(ws["path"]))).resolve() for ws in workspaces
        ]
        if not any(resolved == root or resolved.is_relative_to(root) for root in roots):
            raise HTTPException(
                status_code=403,
                detail="path is not inside any authorized workspace; call workspace.open first",
            )
        # Let FileResponse pick the right Content-Type from the extension.
        # docx → application/vnd.openxmlformats-officedocument.wordprocessingml.document
        # xlsx → application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
        #
        # Do NOT override `Content-Disposition`. Starlette's FileResponse
        # already emits an RFC-5987-compliant header (`filename*=utf-8''…`)
        # when `filename=` contains non-ASCII characters; setting a custom
        # header with raw CJK in the value triggers an ASGI latin-1
        # encoding error and the renderer sees "Failed to fetch". The
        # fetch() consumer doesn't care about the disposition anyway —
        # it reads response.arrayBuffer() directly.
        return FileResponse(resolved, filename=resolved.name)

    @app.get("/local/v1/pptx-outline")
    async def get_pptx_outline(
        path: str = Query(..., description="Absolute .pptx path inside an authorized workspace"),
    ) -> dict[str, Any]:
        """Return the slide outline JSON for a .pptx file.

        Used by the right-side DocPreviewPanel's PptxPreview component
        — pptx has no mature pure-browser renderer, so the panel renders
        a structured outline (title + bullets + notes per slide) here
        rather than embedding a viewer in iframe.

        Gated by `local_workspaces`, same as `/workspace-files`. The
        path's parent chain must be inside a previously-authorized
        workspace. Calls the shared `_outline_pptx` helper that
        `office.outline` and `office.read_slides` also use, so the
        JSON shape is identical to those tools.
        """
        if not path:
            raise HTTPException(status_code=400, detail="path required")
        resolved = Path(os.path.abspath(os.path.expanduser(path))).resolve()
        try:
            if not resolved.is_file():
                raise HTTPException(status_code=404, detail="file not found")
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"invalid path: {exc}") from exc
        if resolved.suffix.lower() != ".pptx":
            raise HTTPException(status_code=400, detail="path must point to a .pptx file")
        store: LocalStore = app.state.store
        workspaces = await store.list_workspaces()
        roots = [
            Path(os.path.abspath(os.path.expanduser(ws["path"]))).resolve() for ws in workspaces
        ]
        if not any(resolved == root or resolved.is_relative_to(root) for root in roots):
            raise HTTPException(
                status_code=403,
                detail="path is not inside any authorized workspace; call workspace.open first",
            )
        # Defer the import so the daemon boot path doesn't pay for
        # python-pptx unless someone actually previews a deck.
        from .tools.office import _outline_pptx

        try:
            return _outline_pptx(str(resolved))
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"failed to outline .pptx: {exc.__class__.__name__}: {exc}",
            ) from exc

    @app.get("/local/v1/runs/{run_id}/diagnostics", response_model=LocalRunDiagnostics)
    async def run_diagnostics(run_id: str) -> dict[str, Any]:
        """Return the full `LocalRunDiagnostics` payload.

        Shape (per TS interface `client/src/shared/local-host/client.ts:63-100`):
            { schema_version: 1, exported_at, local_host_version?,
              run, events, permissions, artifacts, latest_checkpoint }

        Phase 5'+ used to return only `{run, events}`, so the
        `DiagnosticsPanel` rendered NaN counts (permissions.length on
        undefined) and the "latest checkpoint" tab was always missing.
        """
        store: LocalStore = app.state.store
        run = await store.get_run(run_id)
        if not run:
            raise HTTPException(status_code=404, detail="run not found")
        raw_events = await store.events_since(run_id, after_seq=0)
        events = [
            {
                "id": e["id"],
                "run_id": e["run_id"],
                "seq": e["seq"],
                "event_type": e["event_type"],
                "payload": json.loads(e.get("payload_json") or "{}"),
                "created_at": e["created_at"],
            }
            for e in raw_events
        ]
        permissions = await store.list_permissions_for_run(run_id)
        artifacts = await store.list_artifacts_for_run(run_id)
        return {
            "schema_version": 1,
            "exported_at": datetime.now(UTC).isoformat(),
            "local_host_version": __version__,
            "run": run,
            "events": events,
            "permissions": permissions,
            "artifacts": artifacts,
            "latest_checkpoint": None,  # TODO Block 5: pull from AsyncSqliteSaver
        }

    @app.post(
        "/local/v1/session",
        response_model=LocalCloudSession,
        response_model_exclude_none=True,
    )
    async def set_cloud_session(body: SetCloudSessionRequest) -> dict[str, Any]:
        """Stash a cloud bearer token (+ base URL) for outbound LLM calls.

        Response shape MUST match the client's `LocalCloudSession` TypeScript
        interface — the client gates its "use local agent" feature flag on
        `session.connected === true`. The pydantic model + response_model
        now enforce that.
        """
        token = body.access_token.strip()
        if not token:
            raise HTTPException(status_code=400, detail="token required")
        settings = app.state.settings
        settings.cloud_token = token  # type: ignore[misc]
        # Allow the client to override the daemon's default cloud base URL —
        # the JWT was issued against THAT cloud, so we must talk to the
        # same one.
        incoming_base = body.cloud_base_url.strip()
        if incoming_base:
            settings.cloud_base_url = incoming_base  # type: ignore[misc]
        updated_at = datetime.now(UTC).isoformat()
        app.state.cloud_session_updated_at = updated_at
        return {
            "connected": True,
            "cloud_base_url": settings.cloud_base_url,
            "auth": "bearer",
            "updated_at": updated_at,
        }

    @app.delete(
        "/local/v1/session",
        response_model=LocalCloudSession,
        response_model_exclude_none=True,
    )
    async def clear_cloud_session() -> dict[str, Any]:
        settings = app.state.settings
        settings.cloud_token = ""  # type: ignore[misc]
        app.state.cloud_session_updated_at = None
        return {"connected": False}

    @app.get(
        "/local/v1/session",
        response_model=LocalCloudSession,
        response_model_exclude_none=True,
    )
    async def get_cloud_session() -> dict[str, Any]:
        settings = app.state.settings
        connected = bool(getattr(settings, "cloud_token", ""))
        payload: dict[str, Any] = {"connected": connected}
        if connected:
            payload["cloud_base_url"] = settings.cloud_base_url
            payload["auth"] = "bearer"
            updated_at = getattr(app.state, "cloud_session_updated_at", None)
            if updated_at:
                payload["updated_at"] = updated_at
        return payload

    @app.post(
        "/local/v1/workspaces/diagnose",
        response_model=LocalWorkspaceDiagnosis,
        response_model_exclude_none=True,
    )
    async def diagnose_workspace(body: DiagnoseWorkspaceRequest) -> dict[str, Any]:
        """Inspect a candidate path against the authorization registry.

        Response matches the TS `LocalWorkspaceDiagnosis` shape — the
        `reason` enum drives the workspace-picker's "why disabled?"
        copy, keep it stable.
        """
        import os as _os
        from pathlib import Path as _Path

        store: LocalStore = app.state.store
        path = body.path.strip()
        if not path:
            raise HTTPException(status_code=400, detail="path required")
        resolved = _os.path.abspath(_os.path.expanduser(path))
        path_obj = _Path(resolved)
        exists = path_obj.exists()
        is_directory = path_obj.is_dir()
        workspace = await store.workspace_by_path(resolved)
        authorized = workspace is not None
        if not exists:
            reason = "not_found"
        elif not is_directory:
            reason = "not_directory"
        elif authorized:
            reason = "authorized"
        else:
            reason = "not_authorized"
        payload: dict[str, Any] = {
            "path": resolved,
            "exists": exists,
            "is_directory": is_directory,
            "authorized": authorized,
            "reason": reason,
        }
        if workspace is not None:
            payload["workspace"] = workspace
        return payload

    @app.delete("/local/v1/memory", response_model=ClearMemoryResponse)
    async def clear_memory() -> dict[str, Any]:
        """Wipe every note from the long-term memory namespace.

        Backs the "清空记忆 / Clear memory" button in the agent settings
        dialog. Walks ("notes", "global") in pages of 200 (matches the
        BaseStore default search limit ceiling for SQLite stores) and
        deletes each key. Returns the total count so the UI can render
        an accurate "cleared N memories" toast.

        Idempotent: calling it on an empty store returns
        `deleted_count: 0` without error.
        """
        from .middleware.memory_writeback import NAMESPACE

        agent_store = getattr(app.state, "agent_store", None)
        if agent_store is None:
            raise HTTPException(status_code=503, detail="memory store not initialized")
        deleted = 0
        # `asearch(query=None)` returns everything in the namespace
        # (no semantic ranking needed — we just want the keys).
        # Loop until a page comes back smaller than `limit` so we don't
        # over-fetch on a single-item store.
        page_size = 200
        while True:
            items = await agent_store.asearch(NAMESPACE, limit=page_size)
            if not items:
                break
            for item in items:
                try:
                    await agent_store.adelete(NAMESPACE, item.key)
                    deleted += 1
                except Exception as exc:
                    log.warning("memory delete failed key=%s: %s", item.key, exc)
            if len(items) < page_size:
                break
        return {"cleared": True, "deleted_count": deleted}

    @app.get("/local/v1/mcp-servers", response_model=McpServerCatalog)
    async def list_mcp_servers() -> McpServerCatalog:
        """Catalog of every MCP server we discovered across the user's
        machine. Pure read — we never start, install, or modify these
        servers. The user manages them through whatever tool they
        prefer (Claude Desktop, Cursor, Codex, or our own
        `~/.shejane/mcp-servers.json`), and the daemon picks them up
        on the next agent boot.

        `sources_scanned` reports the source labels we attempted to
        read (regardless of whether the file existed or had servers),
        so the UI can render section headers like "Cursor — no
        config found at ~/.cursor/mcp.json" instead of silently
        hiding the section.
        """
        from .config import get_settings
        from .tools.mcp import _candidate_source_files, discover_servers

        settings = get_settings()
        discovered = discover_servers(settings.data_dir)
        # `_candidate_source_files` returns the full ordered list of
        # sources we'd look at — perfect for "what did we try?". We
        # always include "env" so the UI can call it out when the user
        # has SHEJANE_LOCAL_MCP_SERVERS set.
        sources_scanned: list[str] = ["env"]
        for src in _candidate_source_files(settings.data_dir):
            if src.source not in sources_scanned:
                sources_scanned.append(src.source)
        servers = [
            McpServerInfo(
                name=srv.name,
                transport=srv.config.get("transport", "stdio"),
                source=srv.source,
                source_path=srv.source_path,
                command=srv.config.get("command"),
                args=list(srv.config.get("args", []) or []),
                url=srv.config.get("url"),
                # Never leak env *values* — only the keys, so the UI
                # can show "needs API_KEY, TAVILY_KEY" without exposing
                # secrets that were copy-pasted in.
                env_keys=sorted(list((srv.config.get("env") or {}).keys())),
                cwd=srv.config.get("cwd"),
            )
            for srv in discovered
        ]
        return McpServerCatalog(servers=servers, sources_scanned=sources_scanned)

    @app.get("/local/v1/skills")
    async def list_local_skills() -> dict[str, Any]:
        """Catalog of every SKILL.md the daemon can see across all
        configured skill roots (`~/.shejane/skills/`, `~/.claude/skills/`,
        or `SHEJANE_LOCAL_SKILLS_PATH` overrides). Skills are managed
        out-of-band — the user drops directories into a root themselves
        (or installs via the skills.sh CLI into `~/.claude/skills/`) and
        the daemon picks them up on next scan.

        Also surfaces the roots themselves under `roots` so the UI can
        render section headers (e.g. "Personal" for shejane) even when
        a root is empty — otherwise the user has no idea where to drop
        their SKILL.md directories.
        """
        from .agent.builder import _resolve_skills_dirs

        roots = [
            {
                "source": (d.parent.name or d.name).lstrip("."),
                "path": str(d),
            }
            for d in _resolve_skills_dirs()
        ]
        return {"skills": _list_skill_files(), "roots": roots}

    return app


app = create_app()
