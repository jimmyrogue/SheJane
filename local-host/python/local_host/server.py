"""FastAPI application + HTTP route surface.

Phase 2' deliverables:
- `/v1/health` (no auth)
- `/v1/tools` (list available tools — placeholder for now)
- `/v1/workspaces` (CRUD authorization records)
- `/v1/runs` (placeholder: real impl lands in Phase 3')
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from hashlib import sha256
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
    ClearLocalLarkCacheResponse,
    ClearMemoryResponse,
    CreateRunRequest,
    CreateScheduledRunRequest,
    CreateWorkspaceRequest,
    DiagnoseWorkspaceRequest,
    ForkRunRequest,
    HealthResponse,
    InjectRunInstructionRequest,
    InjectRunInstructionResponse,
    ListLocalLarkSourcesResponse,
    ListLocalTodosResponse,
    ListRunsResponse,
    ListScheduledRunsResponse,
    ListWorkspacesResponse,
    LocalArtifact,
    LocalCloudSession,
    LocalLarkConnection,
    LocalLarkConnectResponse,
    LocalLarkSource,
    LocalLarkStatus,
    LocalRun,
    LocalRunDiagnostics,
    LocalScheduledRun,
    LocalTodoItem,
    LocalWorkspaceAuthorization,
    LocalWorkspaceDiagnosis,
    McpServerCatalog,
    McpServerDeleteResponse,
    McpServerInfo,
    McpServerWriteRequest,
    McpServerWriteResponse,
    PermissionResolution,
    PlanApprovalResolution,
    PreviewLocalLarkRequest,
    PreviewLocalLarkResponse,
    QuestionAnswer,
    QuoteLocalTodoRequest,
    QuoteLocalTodoResponse,
    ResolvePermissionRequest,
    ResolvePlanApprovalRequest,
    ResumeRunResponse,
    SetCloudSessionRequest,
    SkillDeleteResponse,
    SkillFile,
    SkillWriteRequest,
    SkillWriteResponse,
    SyncLocalLarkRequest,
    SyncLocalLarkResponse,
    UpdateLocalLarkConnectionRequest,
    UpdateLocalLarkSourceRequest,
    UpdateLocalTodoItemRequest,
)
from .auth import PairingTokenAuthMiddleware
from .config import Settings, get_settings
from .failure_policy import classify_failure_payload
from .lark.candidates import classify_lark_candidate
from .lark.connector import (
    LarkAuthRequiredError,
    LarkConnector,
    LarkFetchedSource,
    LarkMessageSnapshot,
)
from .lark.extractors import (
    CloudRedactedTodoExtractor,
    RuleTodoExtractor,
    TodoExtractionCandidate,
)
from .lark.normalize import normalize_lark_message
from .lark.redact import redact_lark_text
from .progress_ledger import (
    latest_feature_ledger as _latest_feature_ledger,
)
from .progress_ledger import (
    progress_ledger_state as _progress_ledger_state,
)
from .runs import CheckpointNotFoundError, RunCoordinator, RunNotFoundError
from .scheduler import ScheduledRunDispatcher
from .store.sqlite import LocalStore

log = logging.getLogger("local_host.server")

_HANDOFF_STATUSES = {"completed", "failed", "canceled", "waiting_permission", "waiting_input"}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


class LarkAutoSyncDispatcher:
    """Local-only polling loop for desktop Lark sync.

    It intentionally uses the rules extractor only. Cloud-redacted extraction
    still requires an explicit preview + manual sync in the renderer.
    """

    def __init__(
        self,
        app: FastAPI,
        *,
        poll_interval_seconds: float = 30.0,
    ) -> None:
        self.app = app
        self.poll_interval_seconds = poll_interval_seconds
        self._task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run_loop(), name="lark-auto-sync")

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        finally:
            self._task = None

    async def tick(self, *, now: datetime | None = None) -> bool:
        store: LocalStore = self.app.state.store
        connection = await store.ensure_lark_connection()
        if not connection.get("auto_sync_enabled"):
            return False
        if connection.get("status") != "connected":
            return False
        now = (now or datetime.now(UTC)).astimezone(UTC)
        interval_minutes = int(connection.get("auto_sync_interval_minutes") or 5)
        last_auto_synced_at = _parse_datetime(str(connection.get("last_auto_synced_at") or ""))
        if last_auto_synced_at is not None and now - last_auto_synced_at < timedelta(
            minutes=interval_minutes
        ):
            return False
        if self._lock.locked():
            return False
        async with self._lock:
            try:
                await _sync_lark_once(
                    self.app,
                    SyncLocalLarkRequest(
                        limit=100,
                        extraction_provider="cloud_redacted",
                        model="auto",
                    ),
                )
            except HTTPException as exc:
                await store.update_lark_connection(
                    last_error_code=str(exc.detail or "lark_auto_sync_failed")
                )
                return False
            except Exception:
                log.exception("lark auto sync tick failed")
                await store.update_lark_connection(last_error_code="lark_auto_sync_failed")
                return False
            await store.update_lark_connection(
                last_auto_synced_at=now.isoformat(),
                last_error_code="",
            )
            return True

    async def _run_loop(self) -> None:
        try:
            while True:
                try:
                    await self.tick()
                except Exception:
                    log.exception("lark auto sync loop failed")
                await asyncio.sleep(self.poll_interval_seconds)
        except asyncio.CancelledError:
            raise


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


_SAFE_CATALOG_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")


def _safe_catalog_name(raw: str | None) -> str:
    name = (raw or "").strip()
    if not _SAFE_CATALOG_NAME_RE.fullmatch(name):
        raise HTTPException(
            status_code=400,
            detail="name must start with a letter or number and contain only letters, numbers, '.', '_' or '-'",
        )
    return name


def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp")
    tmp.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    tmp.replace(path)


def _normalize_schedule_time(raw: str) -> str:
    value = raw.strip()
    if not value:
        raise HTTPException(status_code=400, detail="run_at required")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="run_at must be an ISO timestamp") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).isoformat()


def _shejane_mcp_config_path() -> Path:
    return Path.home() / ".shejane" / "mcp-servers.json"


def _read_shejane_mcp_config() -> dict[str, Any]:
    path = _shejane_mcp_config_path()
    if not path.exists():
        return {"mcpServers": {}}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=400, detail=f"shejane MCP config is not readable JSON: {exc}"
        ) from exc
    if not isinstance(raw, dict):
        return {"mcpServers": {}}
    servers = raw.get("mcpServers")
    if isinstance(servers, dict):
        return raw
    if all(isinstance(v, dict) and ("command" in v or "url" in v) for v in raw.values()):
        return {"mcpServers": raw}
    raw["mcpServers"] = {}
    return raw


def _mcp_info_from_config(name: str, config: dict[str, Any]) -> McpServerInfo:
    path = _shejane_mcp_config_path()
    return McpServerInfo(
        name=name,
        transport=str(config.get("transport") or "stdio"),
        source="shejane",
        source_path=str(path),
        command=config.get("command") if isinstance(config.get("command"), str) else None,
        args=[str(arg) for arg in config.get("args", []) or []],
        url=config.get("url") if isinstance(config.get("url"), str) else None,
        env_keys=sorted(str(key) for key in (config.get("env") or {}).keys()),
        cwd=config.get("cwd") if isinstance(config.get("cwd"), str) else None,
    )


def _personal_skills_root() -> Path:
    root = Path.home() / ".shejane" / "skills"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _skill_md_path(name: str) -> Path:
    root = _personal_skills_root().resolve()
    skill_dir = (root / name).resolve()
    if root not in skill_dir.parents:
        raise HTTPException(status_code=400, detail="skill path escapes personal skills root")
    return skill_dir / "SKILL.md"


def _default_skill_content(name: str, description: str) -> str:
    lines = ["---", f"name: {name}"]
    description = description.strip()
    if description:
        lines.append(f"description: {description}")
    lines.extend(["---", "", f"# {name}", ""])
    if description:
        lines.append(description)
        lines.append("")
    return "\n".join(lines)


def _skill_file_from_path(name: str, path: Path) -> SkillFile:
    if not path.is_file():
        raise HTTPException(status_code=404, detail="skill not found")
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to read skill: {exc}") from exc
    _, description = _parse_frontmatter_minimal(content)
    return SkillFile(
        name=name,
        description=description,
        path=str(path),
        root_path=str(_personal_skills_root()),
        content=content,
    )


def _write_mcp_server(
    route_name: str | None, request: McpServerWriteRequest
) -> McpServerWriteResponse:
    from .tools.mcp import _normalize_entry

    name = _safe_catalog_name(route_name or request.name)
    raw: dict[str, Any] = {
        "transport": request.transport,
    }
    if request.command is not None:
        raw["command"] = request.command
    if request.args:
        raw["args"] = request.args
    if request.url is not None:
        raw["url"] = request.url
    if request.env:
        raw["env"] = request.env
    if request.cwd is not None:
        raw["cwd"] = request.cwd

    normalized = _normalize_entry(name, raw)
    if normalized is None:
        raise HTTPException(status_code=400, detail="MCP server must include command or url")

    config = _read_shejane_mcp_config()
    servers = config.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        servers = {}
        config["mcpServers"] = servers
    servers[name] = normalized
    _write_json_atomic(_shejane_mcp_config_path(), config)
    return McpServerWriteResponse(server=_mcp_info_from_config(name, normalized))


def _write_local_skill(route_name: str | None, request: SkillWriteRequest) -> SkillWriteResponse:
    name = _safe_catalog_name(route_name or request.name)
    path = _skill_md_path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    content = request.content
    if content is None:
        content = _default_skill_content(name, request.description)
    if not content.endswith("\n"):
        content += "\n"
    try:
        path.write_text(content, encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to write skill: {exc}") from exc
    return SkillWriteResponse(skill=_skill_file_from_path(name, path))


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
    scheduler = ScheduledRunDispatcher(store=store, coordinator=coordinator)
    lark_auto_sync = LarkAutoSyncDispatcher(app)
    app.state.store = store
    app.state.settings = settings
    app.state.checkpointer = checkpointer
    app.state.agent_store = agent_store
    app.state.coordinator = coordinator
    app.state.scheduler = scheduler
    app.state.lark_auto_sync = lark_auto_sync
    # Reconcile runs the previous process left non-terminal (the daemon is
    # SIGKILLed on every `make dev-electron` restart): fail dead queued/running
    # runs, leave waiting_permission runs resumable. Without this they sit
    # `running` forever and the client never sees a terminal state.
    await coordinator.recover_orphans()
    await scheduler.recover_running()
    scheduler.start()
    lark_auto_sync.start()
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
        await lark_auto_sync.stop()
        await scheduler.stop()
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

    def lark_connector() -> LarkConnector:
        return _lark_connector_for_app(app, settings)

    @app.get("/local/v1/lark/status", response_model=LocalLarkStatus)
    async def lark_status() -> dict[str, Any]:
        store: LocalStore = app.state.store
        connector = lark_connector()
        if connector.status.available:
            auth_status = await connector.probe_auth_status()
            connection = await store.update_lark_connection(
                status=auth_status.status,
                tenant_label=auth_status.tenant_label,
                account_label=auth_status.account_label,
                last_checked_at=_now_iso(),
                last_error_code=auth_status.last_error_code,
            )
        else:
            connection = await store.ensure_lark_connection()
        return {
            "connection": connection,
            "connector": connector.status.as_dict(),
        }

    @app.post("/local/v1/lark/connect", response_model=LocalLarkConnectResponse)
    async def connect_lark() -> dict[str, Any]:
        store: LocalStore = app.state.store
        connector = lark_connector()
        if not connector.status.available:
            raise HTTPException(status_code=409, detail="lark connector not found")
        result = await connector.start_login()
        if result.status == "error":
            await store.update_lark_connection(
                status="error",
                last_checked_at=_now_iso(),
                last_error_code=result.last_error_code,
            )
            raise HTTPException(status_code=502, detail=result.last_error_code)
        connection = await store.update_lark_connection(
            status=result.status,
            last_checked_at=_now_iso(),
            last_error_code=result.last_error_code,
        )
        if result.device_code:
            _track_lark_auth_task(
                app,
                asyncio.create_task(
                    _complete_lark_login_from_device_code(app, result.device_code),
                    name="lark-auth-complete",
                ),
            )
        return {
            "connection": connection,
            "connector": connector.status.as_dict(),
            "authorization_url": result.authorization_url,
            "device_code": result.device_code,
        }

    @app.post("/local/v1/lark/disconnect", response_model=LocalLarkStatus)
    async def disconnect_lark() -> dict[str, Any]:
        store: LocalStore = app.state.store
        connector = lark_connector()
        if connector.status.available:
            result = await connector.logout()
            if result.status == "error":
                connection = await store.update_lark_connection(
                    status="error",
                    last_checked_at=_now_iso(),
                    last_error_code=result.last_error_code,
                )
                return {"connection": connection, "connector": connector.status.as_dict()}
        await store.clear_lark_cache()
        connection = await store.update_lark_connection(
            status="disconnected",
            tenant_label="",
            account_label="",
            last_checked_at=_now_iso(),
            last_error_code="",
        )
        return {"connection": connection, "connector": connector.status.as_dict()}

    @app.patch("/local/v1/lark/connection", response_model=LocalLarkConnection)
    async def update_lark_connection(
        body: UpdateLocalLarkConnectionRequest,
    ) -> dict[str, Any]:
        store: LocalStore = app.state.store
        return await store.update_lark_connection(
            cloud_extraction_enabled=body.cloud_extraction_enabled,
            data_retention_days=body.data_retention_days,
            auto_sync_enabled=body.auto_sync_enabled,
            auto_sync_interval_minutes=body.auto_sync_interval_minutes,
        )

    @app.get("/local/v1/lark/sources", response_model=ListLocalLarkSourcesResponse)
    async def list_lark_sources() -> dict[str, Any]:
        store: LocalStore = app.state.store
        return {"sources": await store.list_lark_sources()}

    @app.post("/local/v1/lark/sources/discover", response_model=ListLocalLarkSourcesResponse)
    async def discover_lark_sources() -> dict[str, Any]:
        store: LocalStore = app.state.store
        connector = lark_connector()
        if not connector.status.available:
            raise HTTPException(status_code=409, detail="lark connector not found")
        try:
            sources = await connector.fetch_recent_im_sources(chat_limit=100)
            await _import_lark_sources(store, sources)
        except LarkAuthRequiredError as exc:
            await store.update_lark_connection(
                status="needs_auth",
                last_checked_at=_now_iso(),
                last_error_code=str(exc),
            )
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return {"sources": await store.list_lark_sources()}

    @app.patch("/local/v1/lark/sources/{source_id}", response_model=LocalLarkSource)
    async def update_lark_source(
        source_id: str,
        body: UpdateLocalLarkSourceRequest,
    ) -> dict[str, Any]:
        store: LocalStore = app.state.store
        updated = await store.update_lark_source(
            source_id,
            display_label=body.display_label,
            sync_enabled=body.sync_enabled,
        )
        if updated is None:
            raise HTTPException(status_code=404, detail="lark source not found")
        return updated

    @app.post("/local/v1/lark/preview", response_model=PreviewLocalLarkResponse)
    async def preview_lark_candidates(body: PreviewLocalLarkRequest) -> dict[str, Any]:
        store: LocalStore = app.state.store
        messages = await store.list_lark_messages_for_sync(limit=body.limit)
        candidates, skipped = await _lark_todo_candidates_from_messages(store, messages)
        candidate_groups = _merge_lark_todo_candidate_groups(candidates)
        skipped += len(candidates) - len(candidate_groups)
        candidates = [candidate for candidate, _message_ids in candidate_groups]
        return {
            "provider": "lark",
            "processed_messages": len(messages),
            "candidate_count": len(candidates),
            "skipped_messages": skipped,
            "candidates": [
                {
                    "message_id": candidate.message_id,
                    "source_id": candidate.source_id,
                    "source_label": candidate.source_label,
                    "source_type": candidate.source_type,
                    "redacted_text": candidate.redacted_text[:240],
                    "priority": candidate.priority_hint,
                    "suggested_action": candidate.suggested_action,
                    "confidence": candidate.confidence,
                }
                for candidate in candidates
            ],
        }

    @app.delete("/local/v1/lark/cache", response_model=ClearLocalLarkCacheResponse)
    async def clear_lark_cache() -> dict[str, Any]:
        store: LocalStore = app.state.store
        cleared = await store.clear_lark_cache()
        return {"cleared": True, **cleared}

    @app.post("/local/v1/lark/sync", response_model=SyncLocalLarkResponse)
    async def sync_lark(body: SyncLocalLarkRequest) -> dict[str, Any]:
        return await _sync_lark_once(app, body)

    @app.get("/local/v1/todos", response_model=ListLocalTodosResponse)
    async def list_todos(provider: str = Query("lark")) -> dict[str, Any]:
        if provider != "lark":
            raise HTTPException(status_code=400, detail="unsupported todo provider")
        store: LocalStore = app.state.store
        return {"todos": await store.list_todo_items(provider=provider)}

    @app.patch("/local/v1/todos/{todo_id}", response_model=LocalTodoItem)
    async def update_todo_item(
        todo_id: str,
        body: UpdateLocalTodoItemRequest,
    ) -> dict[str, Any]:
        store: LocalStore = app.state.store
        updated = await store.update_todo_item(
            todo_id,
            priority=body.priority,
            status=body.status,
            due_at=body.due_at,
        )
        if updated is None:
            raise HTTPException(status_code=404, detail="todo not found")
        return updated

    @app.post("/local/v1/todos/{todo_id}/quote", response_model=QuoteLocalTodoResponse)
    async def quote_todo_item(
        todo_id: str,
        body: QuoteLocalTodoRequest,
    ) -> dict[str, str]:
        store: LocalStore = app.state.store
        todo = await store.get_todo_item(todo_id)
        if todo is None:
            raise HTTPException(status_code=404, detail="todo not found")
        if todo.get("provider") != "lark":
            raise HTTPException(status_code=400, detail="unsupported todo provider")
        return {
            "todo_id": todo_id,
            "text": _format_todo_quote(todo, include_evidence=body.include_evidence),
        }

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
            metadata=body.metadata,
        )

    @app.get("/local/v1/schedules", response_model=ListScheduledRunsResponse)
    async def list_schedules(
        status: str | None = Query(default=None),
        notify_pending: bool = Query(default=False),
    ) -> dict[str, Any]:
        store: LocalStore = app.state.store
        schedules = await store.list_scheduled_runs(
            status=status,
            notify_pending=notify_pending,
        )
        return {"schedules": schedules}

    @app.post("/local/v1/schedules", response_model=LocalScheduledRun)
    async def create_schedule(body: CreateScheduledRunRequest) -> dict[str, Any]:
        goal = body.goal.strip()
        if not goal:
            raise HTTPException(status_code=400, detail="goal required")
        store: LocalStore = app.state.store
        return await store.create_scheduled_run(
            goal=goal,
            run_at=_normalize_schedule_time(body.run_at),
            workspace_path=body.workspace_path,
            model=body.model.strip() or "auto",
            history=body.history or [],
            settings=body.settings,
            metadata=body.metadata,
        )

    @app.delete("/local/v1/schedules/{schedule_id}", response_model=LocalScheduledRun)
    async def cancel_schedule(schedule_id: str) -> dict[str, Any]:
        store: LocalStore = app.state.store
        schedule = await store.cancel_scheduled_run(schedule_id)
        if schedule is None:
            raise HTTPException(status_code=404, detail="schedule not found")
        return schedule

    @app.post("/local/v1/schedules/{schedule_id}/notified", response_model=LocalScheduledRun)
    async def mark_schedule_notified(schedule_id: str) -> dict[str, Any]:
        store: LocalStore = app.state.store
        schedule = await store.mark_scheduled_run_notified(schedule_id)
        if schedule is None:
            raise HTTPException(status_code=404, detail="schedule not found")
        return schedule

    @app.post("/local/v1/runs/{run_id}/fork", response_model=LocalRun)
    async def fork_run(run_id: str, body: ForkRunRequest) -> dict[str, Any]:
        checkpoint_id = body.checkpoint_id.strip()
        if not checkpoint_id:
            raise HTTPException(status_code=400, detail="checkpoint_id required")
        coordinator: RunCoordinator = app.state.coordinator
        try:
            return await coordinator.fork_run(
                source_run_id=run_id,
                checkpoint_id=checkpoint_id,
                goal=body.goal,
                mode=body.model,
                settings=body.settings,
                metadata=body.metadata,
            )
        except RunNotFoundError as exc:
            raise HTTPException(status_code=404, detail="run not found") from exc
        except CheckpointNotFoundError as exc:
            raise HTTPException(status_code=404, detail="checkpoint not found") from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

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

    @app.post(
        "/local/v1/runs/{run_id}/inject",
        response_model=InjectRunInstructionResponse,
    )
    async def inject_run_instruction(
        run_id: str,
        body: InjectRunInstructionRequest,
    ) -> dict[str, Any]:
        content = body.content.strip()
        if not content:
            raise HTTPException(status_code=400, detail="content required")
        store: LocalStore = app.state.store
        run = await store.get_run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        if run.get("status") in {"completed", "canceled", "failed"}:
            raise HTTPException(status_code=409, detail="run is not active")
        record = await store.create_steering_instruction(run_id=run_id, content=content)
        return {"run_id": run_id, "instruction_id": record["id"], "queued": True}

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
        that `HumanInTheLoopMiddleware` expects on resume. One LangGraph
        interrupt can contain multiple HITL action requests, so the run
        resumes only after every permission in the current pause batch is
        resolved, preserving the original `permission.required` order.

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
        coordinator: RunCoordinator = app.state.coordinator
        # If the user picked "Always allow for this run", cache the
        # tool name in the coordinator so the auto-approve loop in
        # `_drive_run` skips re-prompting on subsequent gates for the
        # same tool. Without this the agent runs into HITL again every
        # turn and the user has to click approve repeatedly.
        if decision_text == "approve" and scope == "run":
            coordinator.grant_tool_scope(record["run_id"], record["tool_name"])
        # Emit `permission.resolved` onto the run's SSE queue so the
        # client's `hasPendingPermission` check (App.tsx:1339) clears
        # the in-flight approval card. Without this the card stays
        # rendered after the user clicks approve. Emit before deciding
        # whether to resume because batched HITL pauses may still be
        # waiting on sibling permission cards.
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
        permissions = await store.list_permissions_for_run(record["run_id"])
        raw_events = await store.events_since(record["run_id"], after_seq=0)
        batch = _current_permission_batch(raw_events, permissions, permission_id)
        if any(item.get("status") == "pending" for item in batch):
            ok = False
        else:
            resume_payload = {"decisions": [_hitl_decision_for_permission(item) for item in batch]}
            ok = await coordinator.resume_run(run_id=record["run_id"], decision=resume_payload)
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
        ok = await coordinator.resume_run(run_id=record["run_id"], decision=resume_payload)
        return {
            "question_id": question_id,
            "answered": True,
            "resumed": ok,
        }

    @app.post("/local/v1/plans/{approval_id}", response_model=PlanApprovalResolution)
    async def resolve_plan_approval(
        approval_id: str,
        body: ResolvePlanApprovalRequest,
    ) -> dict[str, Any]:
        """Approve, revise, or reject a Plan Mode `write_todos` pause."""
        decision_text = body.decision
        instructions = (body.instructions or "").strip() or None
        if decision_text == "modify" and not instructions:
            raise HTTPException(status_code=400, detail="instructions required")

        store: LocalStore = app.state.store
        record = await store.get_plan_approval(approval_id)
        if record is None:
            raise HTTPException(status_code=404, detail="plan approval not found")

        status = {
            "approve": "approved",
            "modify": "modified",
            "reject": "rejected",
        }[decision_text]
        await store.resolve_plan_approval(
            approval_id,
            status=status,
            instructions=instructions,
        )
        coordinator: RunCoordinator = app.state.coordinator
        await coordinator.emit_for_run(
            record["run_id"],
            "plan.approval_resolved",
            {
                "request_id": approval_id,
                "decision": decision_text,
                "instructions": instructions,
            },
        )
        ok = await coordinator.resume_run(
            run_id=record["run_id"],
            decision={
                "approval_id": approval_id,
                "decision": decision_text,
                "instructions": instructions,
            },
        )
        return {
            "approval_id": approval_id,
            "resolved": True,
            "decision": decision_text,
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

        Shape (per TS interface `client/src/shared/local-host/client.ts`):
            { schema_version: 1, exported_at, local_host_version?,
              run, events, permissions, artifacts, latest_checkpoint, handoff }

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
        latest_checkpoint = await _latest_checkpoint_summary(app.state.checkpointer, run_id)
        reflection = await _latest_checkpoint_reflection(app.state.checkpointer, run_id)
        return {
            "schema_version": 1,
            "exported_at": datetime.now(UTC).isoformat(),
            "local_host_version": __version__,
            "run": run,
            "events": events,
            "permissions": permissions,
            "artifacts": artifacts,
            "latest_checkpoint": latest_checkpoint,
            "handoff": _build_diagnostics_handoff(run, events, permissions, artifacts),
            "feature_ledger": _latest_feature_ledger(artifacts),
            "reflection": reflection,
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
        """Wipe every note from all long-term memory namespaces.

        Backs the "清空记忆 / Clear memory" button in the agent settings
        dialog. Walks every ("notes", ...) namespace in pages of 200
        (matches the BaseStore default search limit ceiling for SQLite stores)
        and deletes each key. Returns the total count so the UI can render an
        accurate "cleared N memories" toast.

        Idempotent: calling it on an empty store returns
        `deleted_count: 0` without error.
        """
        from .middleware.memory_writeback import NAMESPACE, NOTES_NAMESPACE_PREFIX

        agent_store = getattr(app.state, "agent_store", None)
        if agent_store is None:
            raise HTTPException(status_code=503, detail="memory store not initialized")
        deleted = 0
        # `asearch(query=None)` returns everything in the namespace
        # (no semantic ranking needed — we just want the keys).
        # Loop until a page comes back smaller than `limit` so we don't
        # over-fetch on a single-item store.
        page_size = 200
        namespaces = [NAMESPACE]
        if hasattr(agent_store, "alist_namespaces"):
            namespaces = []
            offset = 0
            while True:
                page = await agent_store.alist_namespaces(
                    prefix=NOTES_NAMESPACE_PREFIX,
                    limit=page_size,
                    offset=offset,
                )
                if not page:
                    break
                namespaces.extend(page)
                if len(page) < page_size:
                    break
                offset += len(page)
        for namespace in namespaces:
            while True:
                items = await agent_store.asearch(namespace, limit=page_size)
                if not items:
                    break
                for item in items:
                    try:
                        await agent_store.adelete(namespace, item.key)
                        deleted += 1
                    except Exception as exc:
                        log.warning(
                            "memory delete failed namespace=%s key=%s: %s", namespace, item.key, exc
                        )
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

    @app.post("/local/v1/mcp-servers", response_model=McpServerWriteResponse)
    async def create_mcp_server(request: McpServerWriteRequest) -> McpServerWriteResponse:
        return _write_mcp_server(request.name, request)

    @app.put("/local/v1/mcp-servers/{server_name}", response_model=McpServerWriteResponse)
    async def update_mcp_server(
        server_name: str, request: McpServerWriteRequest
    ) -> McpServerWriteResponse:
        return _write_mcp_server(server_name, request)

    @app.delete("/local/v1/mcp-servers/{server_name}", response_model=McpServerDeleteResponse)
    async def delete_mcp_server(server_name: str) -> McpServerDeleteResponse:
        name = _safe_catalog_name(server_name)
        config = _read_shejane_mcp_config()
        servers = config.setdefault("mcpServers", {})
        if isinstance(servers, dict):
            servers.pop(name, None)
        _write_json_atomic(_shejane_mcp_config_path(), config)
        return McpServerDeleteResponse(name=name)

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

    @app.post("/local/v1/skills", response_model=SkillWriteResponse)
    async def create_local_skill(request: SkillWriteRequest) -> SkillWriteResponse:
        return _write_local_skill(request.name, request)

    @app.get("/local/v1/skills/{skill_name}", response_model=SkillFile)
    async def get_local_skill(skill_name: str) -> SkillFile:
        name = _safe_catalog_name(skill_name)
        return _skill_file_from_path(name, _skill_md_path(name))

    @app.put("/local/v1/skills/{skill_name}", response_model=SkillWriteResponse)
    async def update_local_skill(skill_name: str, request: SkillWriteRequest) -> SkillWriteResponse:
        return _write_local_skill(skill_name, request)

    @app.delete("/local/v1/skills/{skill_name}", response_model=SkillDeleteResponse)
    async def delete_local_skill(skill_name: str) -> SkillDeleteResponse:
        name = _safe_catalog_name(skill_name)
        path = _skill_md_path(name)
        if not path.exists():
            raise HTTPException(status_code=404, detail="skill not found")
        shutil.rmtree(path.parent)
        return SkillDeleteResponse(name=name)

    return app


def _format_todo_quote(todo: dict[str, Any], *, include_evidence: bool) -> str:
    title = str(todo.get("title") or "").strip()
    lines = [title or "待办"]
    summary = str(todo.get("summary") or "").strip()
    if summary and summary != title:
        lines.append(f"摘要：{summary}")
    due_at = str(todo.get("due_at") or "").strip()
    if due_at:
        lines.append(f"时间：{due_at}")
    evidence = str(todo.get("evidence_preview") or "").strip()
    if include_evidence and evidence:
        lines.append(f"来源：{evidence}")
    return "\n".join(lines)


def _lark_todo_extractor(
    provider: str,
    *,
    settings: Settings,
    model: str,
) -> RuleTodoExtractor | CloudRedactedTodoExtractor:
    if provider == "rules":
        return RuleTodoExtractor()
    if provider == "cloud_redacted":
        return CloudRedactedTodoExtractor(
            cloud_base_url=settings.cloud_base_url,
            cloud_token=settings.cloud_token,
            model=model,
        )
    if provider == "local_model":
        raise HTTPException(status_code=501, detail="local model extraction is not implemented yet")
    raise HTTPException(status_code=400, detail="unsupported todo extraction provider")


async def _lark_todo_candidates_from_messages(
    store: LocalStore,
    messages: list[dict[str, Any]],
) -> tuple[list[TodoExtractionCandidate], int]:
    skipped = 0
    candidates: list[TodoExtractionCandidate] = []
    dismissed_todos = _dismissed_lark_todos_for_today(await store.list_todo_items(provider="lark"))
    for message in messages:
        if await store.todo_for_source_message_id(str(message["id"])):
            skipped += 1
            continue
        raw_text = str(message.get("text") or message.get("redacted_text") or "").strip()
        redacted_text = str(message.get("redacted_text") or "").strip()
        if not redacted_text:
            redacted_text = redact_lark_text(raw_text).text
        candidate = classify_lark_candidate(
            raw_text,
            source_type=str(message.get("source_type") or ""),
            mentions_user="@" in raw_text,
            high_priority_source=False,
        )
        if not candidate.is_actionable:
            skipped += 1
            continue
        if _dismissed_todo_suppresses_candidate(
            dismissed_todos,
            source_id=str(message["source_id"]),
            text=redacted_text or raw_text,
        ):
            skipped += 1
            continue
        candidates.append(
            TodoExtractionCandidate(
                message_id=str(message["id"]),
                source_id=str(message["source_id"]),
                source_label=str(message.get("display_label") or "Lark"),
                source_type=str(message.get("source_type") or ""),
                raw_text=raw_text,
                redacted_text=redacted_text,
                priority_hint=candidate.priority,
                suggested_action=candidate.suggested_action,
                confidence=candidate.confidence,
                created_at=str(message.get("created_at_lark") or message.get("received_at") or ""),
            )
        )
    return candidates, skipped


def _merge_lark_todo_candidate_groups(
    candidates: list[TodoExtractionCandidate],
) -> list[tuple[TodoExtractionCandidate, list[str]]]:
    groups: list[tuple[TodoExtractionCandidate, list[str]]] = []
    for candidate in candidates:
        for index, (representative, message_ids) in enumerate(groups):
            if candidate.source_id == representative.source_id and _similar_lark_todo_text(
                candidate.redacted_text or candidate.raw_text,
                representative.redacted_text or representative.raw_text,
            ):
                message_ids.append(candidate.message_id)
                if _priority_rank(candidate.priority_hint) < _priority_rank(
                    representative.priority_hint
                ):
                    groups[index] = (candidate, message_ids)
                break
        else:
            groups.append((candidate, [candidate.message_id]))
    return groups


def _dismissed_lark_todos_for_today(todos: list[dict[str, Any]]) -> list[dict[str, Any]]:
    today = datetime.now(UTC).date()
    dismissed: list[dict[str, Any]] = []
    for todo in todos:
        if todo.get("status") != "dismissed":
            continue
        updated_at = _parse_datetime(str(todo.get("updated_at") or ""))
        if updated_at is not None and updated_at.astimezone(UTC).date() == today:
            dismissed.append(todo)
    return dismissed


def _dismissed_todo_suppresses_candidate(
    dismissed_todos: list[dict[str, Any]],
    *,
    source_id: str,
    text: str,
) -> bool:
    for todo in dismissed_todos:
        if str(todo.get("source_id") or "") != source_id:
            continue
        if _similar_lark_todo_text(
            text, str(todo.get("evidence_preview") or todo.get("title") or "")
        ):
            return True
    return False


def _similar_lark_todo_text(left: str, right: str) -> bool:
    left_key = _lark_todo_similarity_key(left)
    right_key = _lark_todo_similarity_key(right)
    if not left_key or not right_key:
        return False
    if left_key in right_key or right_key in left_key:
        return True
    left_tokens = set(re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]", left_key))
    right_tokens = set(re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]", right_key))
    if left_tokens and right_tokens:
        overlap = len(left_tokens & right_tokens) / len(left_tokens | right_tokens)
        if overlap >= 0.62:
            return True
    shared_chars = len(set(left_key) & set(right_key))
    return shared_chars / max(len(set(left_key) | set(right_key)), 1) >= 0.72


def _lark_todo_similarity_key(text: str) -> str:
    normalized = text.lower()
    normalized = re.sub(r"\[[^\]]+\]", " ", normalized)
    normalized = re.sub(r"https?://\S+", " ", normalized)
    normalized = re.sub(r"[^\w\u4e00-\u9fff]+", " ", normalized)
    stop_terms = [
        "please",
        "could",
        "would",
        "you",
        "today",
        "tomorrow",
        "请",
        "麻烦",
        "帮忙",
        "一下",
        "今天",
        "明天",
        "下班前",
        "上午",
        "下午",
    ]
    for term in stop_terms:
        normalized = normalized.replace(term, " ")
    return re.sub(r"\s+", "", normalized)


def _priority_rank(priority: str) -> int:
    return {"now": 0, "today": 1, "later": 2, "fyi": 3}.get(priority, 3)


def _parse_datetime(value: str) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed


async def _sync_lark_once(
    app: FastAPI,
    body: SyncLocalLarkRequest,
) -> dict[str, Any]:
    store: LocalStore = app.state.store
    connector = _lark_connector_for_app(app, app.state.settings)
    if connector.status.available:
        try:
            sources = await connector.fetch_recent_im_sources(chat_limit=min(body.limit, 20))
            enabled_sources = await _import_lark_sources(store, sources)
            if enabled_sources:
                snapshot = await connector.fetch_recent_im_messages_for_sources(
                    enabled_sources,
                    messages_per_chat=min(body.limit, 50),
                )
                await _import_lark_messages(store, snapshot)
        except LarkAuthRequiredError as exc:
            await store.update_lark_connection(
                status="needs_auth",
                last_checked_at=_now_iso(),
                last_error_code=str(exc),
            )
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    await store.prune_lark_messages()
    messages = await store.list_lark_messages_for_sync(limit=body.limit)
    candidates, skipped = await _lark_todo_candidates_from_messages(store, messages)
    candidate_groups = _merge_lark_todo_candidate_groups(candidates)
    skipped += len(candidates) - len(candidate_groups)
    candidates = [candidate for candidate, _message_ids in candidate_groups]
    connection = await store.ensure_lark_connection()
    extraction_provider = body.extraction_provider
    if not connection.get("cloud_extraction_enabled") and extraction_provider == "cloud_redacted":
        extraction_provider = "rules"
    extractor = _lark_todo_extractor(
        extraction_provider,
        settings=app.state.settings,
        model=body.model,
    )
    result = await extractor.extract(candidates)
    created = 0
    candidate_by_id = {
        candidate.message_id: (candidate, message_ids)
        for candidate, message_ids in candidate_groups
    }
    if result.error_code:
        skipped += len(candidates)
    else:
        for todo in result.todos:
            candidate_entry = candidate_by_id.get(todo.candidate_id)
            if candidate_entry is None or not todo.title:
                skipped += 1
                continue
            candidate, source_message_ids = candidate_entry
            await store.create_todo_item(
                source_id=candidate.source_id,
                source_message_ids=source_message_ids,
                priority=todo.priority,
                title=todo.title[:120],
                summary=todo.summary,
                suggested_action=todo.suggested_action,
                due_at=todo.due_at,
                confidence=todo.confidence,
                extraction_provider=result.provider,
                evidence_preview=candidate.redacted_text[:240],
            )
            created += 1
        skipped += max(0, len(candidates) - created)
    return {
        "provider": "lark",
        "extraction_provider": result.provider,
        "processed_messages": len(messages),
        "created_todos": created,
        "skipped_messages": skipped,
        "error_code": result.error_code,
    }


def _lark_connector_for_app(app: FastAPI, settings: Settings) -> LarkConnector:
    factory = getattr(app.state, "lark_connector_factory", None)
    if factory is not None:
        return factory()
    return LarkConnector.discover(resources_path=settings.desktop_resources_path)


def _track_lark_auth_task(app: FastAPI, task: asyncio.Task[None]) -> None:
    tasks = getattr(app.state, "lark_auth_tasks", None)
    if tasks is None:
        tasks = set()
        app.state.lark_auth_tasks = tasks
    tasks.add(task)
    task.add_done_callback(tasks.discard)


async def _complete_lark_login_from_device_code(app: FastAPI, device_code: str) -> None:
    store: LocalStore = app.state.store
    connector = _lark_connector_for_app(app, app.state.settings)
    try:
        auth_status = await connector.complete_login(device_code)
        await store.update_lark_connection(
            status=auth_status.status,
            tenant_label=auth_status.tenant_label,
            account_label=auth_status.account_label,
            last_checked_at=_now_iso(),
            last_error_code=auth_status.last_error_code,
        )
    except Exception:
        log.exception("lark device-code auth completion failed")
        await store.update_lark_connection(
            status="needs_auth",
            last_checked_at=_now_iso(),
            last_error_code="lark_auth_completion_failed",
        )


async def _import_lark_sources(
    store: LocalStore,
    sources: list[LarkFetchedSource],
) -> list[LarkFetchedSource]:
    enabled_sources: list[LarkFetchedSource] = []
    existing_hashes = {
        str(source.get("provider_source_id_hash") or "")
        for source in await store.list_lark_sources()
    }
    for source in sources:
        source_hash = _stable_lark_hash("source", source.provider_source_id)
        initial_sync_enabled = False if source_hash not in existing_hashes else None
        local_source = await store.upsert_lark_source(
            provider_source_id_hash=source_hash,
            source_type=source.source_type,
            display_label=source.display_label or "Lark",
            sync_enabled=initial_sync_enabled,
        )
        if local_source.get("sync_enabled"):
            enabled_sources.append(source)
    return enabled_sources


async def _import_lark_messages(store: LocalStore, snapshot: LarkMessageSnapshot) -> None:
    sources_by_provider_id: dict[str, dict[str, Any]] = {}
    for source in snapshot.sources:
        local_source = await store.upsert_lark_source(
            provider_source_id_hash=_stable_lark_hash("source", source.provider_source_id),
            source_type=source.source_type,
            display_label=source.display_label or "Lark",
            sync_enabled=None,
        )
        if local_source.get("sync_enabled"):
            sources_by_provider_id[source.provider_source_id] = local_source

    for message in snapshot.messages:
        source = sources_by_provider_id.get(message.source_provider_id)
        if source is None:
            continue
        normalized = normalize_lark_message(message.raw or {})
        redacted = redact_lark_text(normalized.text)
        await store.create_lark_message(
            source_id=source["id"],
            provider_message_id_hash=_stable_lark_hash("message", message.provider_message_id),
            sender_hash=_stable_lark_hash("sender", message.sender_id) if message.sender_id else "",
            message_type=message.message_type,
            text=normalized.text,
            redacted_text=redacted.text,
            created_at_lark=message.created_at_lark,
        )


def _stable_lark_hash(kind: str, value: str) -> str:
    return sha256(f"{kind}:{value}".encode()).hexdigest()


def _current_permission_batch(
    raw_events: list[dict[str, Any]],
    permissions: list[dict[str, Any]],
    fallback_permission_id: str,
) -> list[dict[str, Any]]:
    """Return permission rows for the currently paused HITL batch.

    deepagents/LangGraph can bundle several tool approvals into one interrupt
    and expects one ordered `decisions` list on resume. We derive the batch from
    `permission.required` events emitted since the latest run start/resume
    boundary; if old rows or a sparse event log confuse that lookup, fall back
    to the single permission the user just resolved.
    """
    permission_by_id = {
        permission_id: permission
        for permission in permissions
        if (permission_id := str(permission.get("id") or ""))
    }
    batch_ids = _current_permission_batch_ids(raw_events)
    if fallback_permission_id not in batch_ids:
        batch_ids = [fallback_permission_id]

    batch: list[dict[str, Any]] = []
    seen: set[str] = set()
    for permission_id in batch_ids:
        if permission_id in seen:
            continue
        record = permission_by_id.get(permission_id)
        if record is None:
            continue
        seen.add(permission_id)
        batch.append(record)
    fallback = permission_by_id.get(fallback_permission_id)
    if not batch and fallback is not None:
        return [fallback]
    return batch


def _current_permission_batch_ids(raw_events: list[dict[str, Any]]) -> list[str]:
    boundary_index = -1
    for index, event in enumerate(raw_events):
        if event.get("event_type") in {"run.started", "run.resumed"}:
            boundary_index = index

    request_ids: list[str] = []
    seen: set[str] = set()
    for event in raw_events[boundary_index + 1 :]:
        if event.get("event_type") != "permission.required":
            continue
        payload = _event_payload(event)
        request_id = _first_string(payload.get("request_id"), payload.get("id"))
        if request_id is None or request_id in seen:
            continue
        seen.add(request_id)
        request_ids.append(request_id)
    return request_ids


def _event_payload(event: dict[str, Any]) -> dict[str, Any]:
    payload = event.get("payload")
    if isinstance(payload, dict):
        return payload
    payload_json = event.get("payload_json")
    if isinstance(payload_json, str):
        try:
            parsed = json.loads(payload_json)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _hitl_decision_for_permission(permission: dict[str, Any]) -> dict[str, str]:
    if permission.get("status") == "approved":
        return {"type": "approve"}
    return {"type": "reject", "message": "Tool execution denied by user."}


def _build_diagnostics_handoff(
    run: dict[str, Any],
    events: list[dict[str, Any]],
    permissions: list[dict[str, Any]],
    artifacts: list[dict[str, Any]],
) -> dict[str, Any]:
    status = str(run.get("status") or "unknown")
    event_count = len(events)
    artifact_count = len(artifacts)
    pending_permissions = [p for p in permissions if p.get("status") == "pending"]
    recent_event_types = [str(e.get("event_type") or "") for e in events[-8:]]
    recent_event_types = [e for e in recent_event_types if e]
    ledger_state, ledger_message = _progress_ledger_state(events, artifacts)
    verification = _latest_task_verification(events)
    failure = _latest_failure_classification(events, run_status=status, verification=verification)

    blockers: list[str] = []
    if pending_permissions:
        names = sorted({str(p.get("tool_name") or "tool") for p in pending_permissions})
        blockers.append(f"Waiting for permission: {', '.join(names)}")

    if failure:
        blockers.append(_failure_blocker(failure))
    if verification and verification["status"] == "failed":
        blockers.append(f"Latest task.verify failed: {verification.get('reason') or 'unknown'}")

    if status == "completed":
        headline = f"Run completed with {event_count} events and {artifact_count} artifacts."
        next_actions = ["Review the final answer and any listed artifacts."]
    elif status == "waiting_permission" or pending_permissions:
        headline = f"Run is waiting on {len(pending_permissions)} permission request(s)."
        next_actions = ["Approve or deny pending permission requests to continue the run."]
    elif status == "waiting_input":
        headline = "Run is waiting for user input."
        next_actions = ["Answer the pending question to continue the run."]
    elif status in {"queued", "running"}:
        headline = f"Run is {status} with {event_count} persisted events."
        next_actions = ["Reconnect to the stream or wait for the run to reach a terminal state."]
    elif status == "failed":
        headline = f"Run failed after {event_count} events."
        next_actions = ["Inspect blockers and recent failed events before retrying."]
    elif status == "canceled":
        headline = f"Run was canceled after {event_count} events."
        next_actions = ["Start a new run if the goal still needs work."]
    else:
        headline = f"Run status is {status} with {event_count} events."
        next_actions = ["Inspect recent events before resuming work."]

    if status in _HANDOFF_STATUSES and ledger_state != "fresh":
        if ledger_message:
            blockers.append(ledger_message)
        if ledger_state == "missing":
            next_actions.append(
                "Call task.progress with current acceptance criteria, decisions, risks, and next actions."
            )
        elif ledger_state == "stale":
            next_actions.append("Refresh task.progress before handing off or resuming this run.")

    if failure and failure["suggested_action"] not in next_actions:
        next_actions.append(failure["suggested_action"])
    if verification and verification["status"] == "failed":
        action = "Fix the failing verification, then rerun task.verify before final handoff."
        if action not in next_actions:
            next_actions.append(action)

    return {
        "status": status,
        "headline": headline,
        "next_actions": next_actions,
        "blockers": blockers,
        "recent_event_types": recent_event_types,
        "ledger_state": ledger_state,
        "ledger_message": ledger_message,
        "failure": failure,
        "verification": verification,
    }


async def _latest_checkpoint_summary(checkpointer: Any, run_id: str) -> dict[str, Any] | None:
    if checkpointer is None or not hasattr(checkpointer, "alist"):
        return None
    config = {"configurable": {"thread_id": run_id}}
    try:
        async for item in checkpointer.alist(config, limit=1):
            checkpoint = getattr(item, "checkpoint", None)
            metadata = getattr(item, "metadata", None)
            item_config = getattr(item, "config", None)
            if not isinstance(checkpoint, dict):
                checkpoint = {}
            if not isinstance(metadata, dict):
                metadata = {}
            if not isinstance(item_config, dict):
                item_config = {}
            configurable = item_config.get("configurable")
            if not isinstance(configurable, dict):
                configurable = {}

            checkpoint_id = _first_string(checkpoint.get("id"), configurable.get("checkpoint_id"))
            if not checkpoint_id:
                return None
            step = _int_or_none(metadata.get("step"))
            reason = _first_string(metadata.get("source"), metadata.get("reason"), "checkpoint")
            return {
                "id": checkpoint_id,
                "run_id": _first_string(configurable.get("thread_id"), run_id),
                "step": step if step is not None else 0,
                "reason": reason or "checkpoint",
                "messages_count": _checkpoint_messages_count(checkpoint),
                "created_at": _first_string(checkpoint.get("ts"), metadata.get("created_at")),
            }
    except Exception as exc:
        log.warning("latest checkpoint summary failed run_id=%s: %s", run_id, exc)
    return None


async def _latest_checkpoint_reflection(checkpointer: Any, run_id: str) -> dict[str, Any] | None:
    if checkpointer is None or not hasattr(checkpointer, "alist"):
        return None
    config = {"configurable": {"thread_id": run_id}}
    try:
        async for item in checkpointer.alist(config, limit=1):
            checkpoint = getattr(item, "checkpoint", None)
            if not isinstance(checkpoint, dict):
                return None
            channel_values = checkpoint.get("channel_values")
            if not isinstance(channel_values, dict):
                return None
            return _diagnostics_reflection(channel_values.get("reflection"))
    except Exception as exc:
        log.warning("latest checkpoint reflection failed run_id=%s: %s", run_id, exc)
    return None


def _checkpoint_messages_count(checkpoint: dict[str, Any]) -> int:
    channel_values = checkpoint.get("channel_values")
    if not isinstance(channel_values, dict):
        return 0
    messages = channel_values.get("messages")
    if isinstance(messages, list):
        return len(messages)
    return 0


def _diagnostics_reflection(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    out: dict[str, Any] = {}
    for key in ("ai_messages", "tool_results", "final_answer_chars"):
        parsed = _int_or_none(value.get(key))
        if parsed is not None:
            out[key] = parsed
    critic = _diagnostics_reflection_critic(value.get("critic"))
    if critic:
        out["critic"] = critic
    return out or None


def _diagnostics_reflection_critic(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    out: dict[str, Any] = {}
    for key in ("coverage", "clarity", "grounding"):
        parsed = _int_or_none(value.get(key))
        if parsed is not None:
            out[key] = parsed
    notes = value.get("notes")
    if isinstance(notes, list):
        compact_notes = [
            note.strip()[:300] for note in notes[:3] if isinstance(note, str) and note.strip()
        ]
        if compact_notes:
            out["notes"] = compact_notes
    raw = _first_string(value.get("raw"))
    if raw:
        out["raw"] = raw[:1000]
    return out or None


def _latest_failure_classification(
    events: list[dict[str, Any]],
    *,
    run_status: str | None = None,
    verification: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    if run_status == "completed" and (not verification or verification.get("status") != "failed"):
        return None
    for event in reversed(events):
        event_type = event.get("event_type")
        if event_type not in {"run.failed", "tool.failed"}:
            continue
        payload = event.get("payload")
        if not isinstance(payload, dict):
            payload = {}
        if (
            event_type == "tool.failed"
            and _is_task_verify_payload(payload)
            and verification
            and verification.get("status") == "passed"
        ):
            continue
        return classify_failure_payload(str(event_type), payload)
    return None


def _latest_task_verification(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    for event in reversed(events):
        event_type = event.get("event_type")
        if event_type not in {"tool.completed", "tool.failed"}:
            continue
        payload = event.get("payload")
        if not isinstance(payload, dict) or not _is_task_verify_payload(payload):
            continue
        parsed = _parse_tool_content(payload.get("content"))
        if not isinstance(parsed, dict):
            parsed = {}
        status = (
            "passed" if event_type == "tool.completed" and _truthy(parsed.get("ok")) else "failed"
        )
        return {
            "status": status,
            "reason": _verification_reason(parsed),
            "pass_count": _int_or_none(parsed.get("pass_count")),
            "fail_count": _int_or_none(parsed.get("fail_count")),
            "source_event_type": str(event_type),
        }
    return None


def _is_task_verify_payload(payload: dict[str, Any]) -> bool:
    return str(payload.get("tool") or payload.get("name") or "") == "task.verify"


def _parse_tool_content(content: Any) -> Any:
    if isinstance(content, dict):
        return content
    if isinstance(content, str):
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            return None
    return None


def _verification_reason(payload: dict[str, Any]) -> str | None:
    results = payload.get("results")
    if isinstance(results, list):
        failed_details: list[str] = []
        passed_details: list[str] = []
        for item in results:
            if not isinstance(item, dict):
                continue
            detail = item.get("detail")
            if not isinstance(detail, str) or not detail.strip():
                continue
            if _truthy(item.get("ok")):
                passed_details.append(detail.strip())
            else:
                failed_details.append(detail.strip())
        if failed_details:
            return failed_details[0]
        if passed_details:
            return passed_details[0]
    error = payload.get("error")
    if isinstance(error, str) and error.strip():
        return error.strip()
    return None


def _failure_blocker(failure: dict[str, Any]) -> str:
    code = failure.get("code")
    label = f"{failure.get('category')}: {code}" if code else str(failure.get("category"))
    tool = failure.get("tool")
    if tool:
        return f"{tool}: {label}"
    return label


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "ok", "passed"}
    if isinstance(value, (int, float)):
        return value != 0
    return bool(value)


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _first_string(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


app = create_app()
