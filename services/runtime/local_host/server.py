"""FastAPI application + HTTP route surface.

Phase 2' deliverables:
- `/v1/health` (no auth)
- `/v1/tools` (list available tools — placeholder for now)
- `/v1/workspaces` (CRUD authorization records)
- `/v1/runs` (placeholder: real impl lands in Phase 3')
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from langchain_core.messages import ToolMessage
from sse_starlette.sse import EventSourceResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import __version__
from .agent.builder import open_checkpointer, open_store
from .api_schemas import (
    MAX_LOCAL_REQUEST_BODY_BYTES,
    AnswerQuestionCommand,
    AnswerQuestionCommandReceipt,
    AnswerQuestionRequest,
    CancelRunCommand,
    CancelRunCommandReceipt,
    CancelRunResponse,
    ClearMemoryResponse,
    CreateRunRequest,
    CreateScheduledRunRequest,
    CreateWorkspaceRequest,
    DeleteLocalThreadResponse,
    DiagnoseWorkspaceRequest,
    ForkRunRequest,
    HealthResponse,
    InjectRunInstructionRequest,
    InjectRunInstructionResponse,
    ListLocalModelProvidersResponse,
    ListRunsResponse,
    ListScheduledRunsResponse,
    ListThreadChangesResponse,
    ListThreadsResponse,
    ListWorkspacesResponse,
    LocalArtifact,
    LocalModelProvider,
    LocalRun,
    LocalRunDiagnostics,
    LocalRuntimeModelCatalog,
    LocalScheduledRun,
    LocalThread,
    LocalThreadSnapshot,
    LocalWorkspaceAuthorization,
    LocalWorkspaceDiagnosis,
    McpServerCatalog,
    McpServerDeleteResponse,
    McpServerInfo,
    McpServerWriteRequest,
    McpServerWriteResponse,
    PermissionResolution,
    PlanApprovalResolution,
    PlanResolveCommand,
    PlanResolveCommandReceipt,
    QuestionAnswer,
    ReconcileToolRequest,
    ResolvePermissionCommand,
    ResolvePermissionCommandReceipt,
    ResolvePermissionRequest,
    ResolvePlanApprovalRequest,
    RuntimeInfo,
    RuntimeSettingsResponse,
    SkillDeleteResponse,
    SkillFile,
    SkillWriteRequest,
    SkillWriteResponse,
    ToolReconcileCommand,
    ToolReconcileCommandReceipt,
    ToolReconciliationResolution,
    UpdateLocalThreadRequest,
    UpdateRuntimeSettingsRequest,
    UpsertLocalModelProviderRequest,
)
from .auth import PairingTokenAuthMiddleware
from .config import Settings, get_settings
from .failure_policy import classify_failure_payload
from .middleware.tool_execution import serialize_tool_result
from .model_credentials import (
    CredentialStoreError,
    credential_ref,
    delete_model_api_key,
    get_model_api_key,
    new_credential_ref,
    set_model_api_key,
)
from .progress_ledger import (
    latest_feature_ledger as _latest_feature_ledger,
)
from .progress_ledger import (
    progress_ledger_state as _progress_ledger_state,
)
from .runs import (
    RUNTIME_PROTOCOL_VERSION,
    CheckpointNotFoundError,
    RunCoordinator,
    RunNotFoundError,
    freeze_run_settings,
    runtime_capabilities,
    sanitize_run_metadata,
)
from .scheduler import ScheduledRunDispatcher
from .store.sqlite import (
    CommandConflictError,
    LocalStore,
    ParentRunAdmissionError,
    PermissionDecisionConflictError,
    RunAdmissionError,
    RunResultConflictError,
    ThreadAdmissionError,
    WaitDecisionConflictError,
    WorkspaceAdmissionError,
)

log = logging.getLogger("local_host.server")

_RUNTIME_SETTINGS_TO_FIELDS = {
    "max_model_calls": "max_model_calls",
    "max_tool_retries": "max_tool_retries",
    "research_search_limit": "research_search_limit",
    "unknown_model_max_input_tokens": "unknown_model_max_input_tokens",
    "unknown_model_max_output_tokens": "unknown_model_max_output_tokens",
    "model_request_timeout_seconds": "model_request_timeout_seconds",
    "browser_headless": "browser_headless",
    "subagents": "enable_subagents",
    "input_guard": "input_guard_mode",
    "plan_first": "plan_first_mode",
    "verification_repair_max": "verification_repair_max",
    "repair_workflow_max": "repair_workflow_max",
    "pii_redact": "pii_redact_types",
}


def _runtime_settings_payload(settings: Settings, *, version: int) -> dict[str, Any]:
    return {
        "version": version,
        **{
            public_name: getattr(settings, field_name)
            for public_name, field_name in _RUNTIME_SETTINGS_TO_FIELDS.items()
        },
    }


def _apply_runtime_settings(settings: Settings, values: dict[str, Any]) -> Settings:
    updates = {
        field_name: values[public_name]
        for public_name, field_name in _RUNTIME_SETTINGS_TO_FIELDS.items()
        if public_name in values
    }
    return settings.model_copy(update=updates)


_HANDOFF_STATUSES = {"completed", "failed", "canceled", "waiting_permission", "waiting_input"}
_TERMINAL_RUN_STATUSES = {"completed", "failed", "canceled", "cleanup_required"}
_MODEL_PROVIDER_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


def _model_provider_base_url(raw: str) -> str:
    value = raw.strip().rstrip("/")
    parsed = urlparse(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or bool(parsed.query)
        or bool(parsed.fragment)
    ):
        raise HTTPException(status_code=400, detail="model provider base URL is invalid")
    return value


def _provider_models(row: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        models = json.loads(row.get("models_json") or "[]")
    except (json.JSONDecodeError, TypeError):
        return []
    return models if isinstance(models, list) else []


async def _model_provider_response(
    row: dict[str, Any],
    *,
    credential_configured: bool | None = None,
) -> LocalModelProvider:
    requires_api_key = bool(row.get("requires_api_key"))
    configured = credential_configured
    if configured is None:
        configured = not requires_api_key or bool(
            await get_model_api_key(
                str(row["principal_id"]),
                str(row["id"]),
                str(row["credential_ref"]),
            )
        )
    return LocalModelProvider(
        id=str(row["id"]),
        name=str(row["name"]),
        kind="openai_compatible",
        base_url=str(row["base_url"]),
        requires_api_key=requires_api_key,
        credential_configured=configured,
        models=_provider_models(row),
        enabled=bool(row.get("enabled")),
        version=int(row.get("version") or 1),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


class _RequestBodyTooLarge(Exception):
    pass


class RequestBodyLimitMiddleware:
    """Reject oversized HTTP bodies before FastAPI parses JSON."""

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_LOCAL_REQUEST_BODY_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        content_length = dict(scope.get("headers", [])).get(b"content-length")
        if content_length is not None:
            try:
                if int(content_length) > self.max_bytes:
                    await self._reject(scope, receive, send)
                    return
            except ValueError:
                pass

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise _RequestBodyTooLarge
            return message

        try:
            await self.app(scope, limited_receive, send)
        except _RequestBodyTooLarge:
            await self._reject(scope, receive, send)

    @staticmethod
    async def _reject(scope: Scope, receive: Receive, send: Send) -> None:
        response = JSONResponse(
            {"detail": "request body exceeds the 1 MiB limit"},
            status_code=413,
        )
        await response(scope, receive, send)


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


async def _owned_run(
    store: LocalStore,
    *,
    principal_id: str,
    run_id: str,
    not_found_detail: str = "run not found",
) -> dict[str, Any]:
    run = await store.get_run_for_principal(principal_id=principal_id, run_id=run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=not_found_detail)
    return run


async def _normalized_path(raw: str) -> str:
    return await asyncio.to_thread(
        lambda: str(Path(os.path.abspath(os.path.expanduser(raw))).resolve())
    )


async def _authorized_workspace_path(
    store: LocalStore, *, principal_id: str, path: str | None
) -> str | None:
    if path is None:
        return None
    resolved = await _normalized_path(path)
    workspace = await store.workspace_by_path(principal_id=principal_id, path=resolved)
    if workspace is None:
        raise HTTPException(status_code=403, detail="workspace is not authorized")
    workspace_error = await store.workspace_admission_error(
        principal_id=principal_id,
        path=resolved,
    )
    if workspace_error is not None:
        raise HTTPException(status_code=409, detail=workspace_error)
    return resolved


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
    settings: Settings = app.state.bootstrap_settings
    settings.ensure_data_dir()
    # Make sure the canonical user-managed skills dir exists from boot —
    # otherwise it's invisible to the UI until the user manually creates
    # it, and the "Personal" section silently disappears from the list.
    (Path.home() / ".shejane" / "skills").mkdir(parents=True, exist_ok=True)
    store = await LocalStore.open(settings.local_db_path)
    persisted_settings = await store.get_runtime_settings()
    if persisted_settings is not None:
        settings = _apply_runtime_settings(settings, persisted_settings["settings"])
    checkpointer, ck_stack = await open_checkpointer(settings)
    agent_store, store_stack = await open_store(settings)
    coordinator = RunCoordinator(
        store=store,
        checkpointer=checkpointer,
        agent_store=agent_store,
        settings=settings,
    )
    scheduler = ScheduledRunDispatcher(store=store, coordinator=coordinator)
    app.state.store = store
    app.state.settings = settings
    app.state.checkpointer = checkpointer
    app.state.agent_store = agent_store
    app.state.coordinator = coordinator
    app.state.scheduler = scheduler
    app.state.runtime_settings_version = int(
        persisted_settings["version"] if persisted_settings is not None else 0
    )
    # Reconcile runs the previous process left non-terminal (the daemon is
    # SIGKILLed on every `make dev-electron` restart): fail dead queued/running
    # runs, leave waiting_permission runs resumable. Without this they sit
    # `running` forever and the client never sees a terminal state.
    await coordinator.recover_orphans()
    coordinator.start()
    await scheduler.recover_running()
    scheduler.start()
    log.info(
        "local-host started host=%s port=%s data=%s",
        settings.host,
        settings.port,
        settings.data_dir,
    )
    try:
        yield
    finally:
        await scheduler.stop()
        await coordinator.stop()
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
    app.state.bootstrap_settings = settings

    @app.exception_handler(RequestValidationError)
    async def request_validation_error_handler(
        _request: Request,
        exc: RequestValidationError,
    ) -> JSONResponse:
        # FastAPI normally includes the rejected input in its 422 payload.
        # Local requests can contain provider credentials, so return only
        # the location, message, and error type across the entire API.
        errors = [
            {key: value for key, value in error.items() if key not in {"input", "ctx"}}
            for error in exc.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": errors})

    app.add_middleware(RequestBodyLimitMiddleware)

    # Order matters: middleware added LAST runs FIRST on the request path
    # (Starlette wraps outward). PairingTokenAuthMiddleware must sit
    # behind CORSMiddleware so that:
    #   1. CORS preflight (OPTIONS) is answered by CORSMiddleware without
    #      ever hitting auth — preflight by spec carries no credentials,
    #      so rejecting it with 401 makes every browser fetch fail.
    #   2. Even authenticated-but-401 responses still ship the
    #      Access-Control-Allow-Origin header, otherwise the browser
    #      hides the error body from the JS layer.
    app.add_middleware(PairingTokenAuthMiddleware, token=settings.pairing_token)

    # CORS — the daemon binds loopback only, but the Vite dev server (and
    # the production Electron renderer when loaded over file://) live on a
    # different origin than `:17371`. Without these headers, every
    # browser-side fetch fails preflight. Bearer-token auth
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
        #   • packages/runtime-client/src/client.ts:probeLocalHost
        #     checks `status === "ok"` and reads mode/worker
        # The HealthResponse defaults already encode `ok=True status="ok"`
        # mode="ready" worker="python-langgraph" — only `version` and
        # `pairing_configured` need to be filled per-request.
        return HealthResponse(
            version=__version__,
            pairing_configured=bool(settings.pairing_token),
        )

    @app.get("/local/v1/runtime", response_model=RuntimeInfo)
    async def runtime_info(request: Request) -> RuntimeInfo:
        runtime_settings: Settings = app.state.settings
        provider_configured = False
        store: LocalStore = app.state.store
        try:
            providers = await store.list_model_providers(principal_id=request.state.principal_id)
            for provider in providers:
                if bool(provider.get("enabled")) and (
                    not bool(provider.get("requires_api_key"))
                    or await get_model_api_key(
                        request.state.principal_id,
                        str(provider["id"]),
                        str(provider["credential_ref"]),
                    )
                ):
                    provider_configured = True
                    break
        except CredentialStoreError:
            provider_configured = False
        return RuntimeInfo(
            protocol_version=RUNTIME_PROTOCOL_VERSION,
            runtime_version=__version__,
            capabilities=sorted(runtime_capabilities(runtime_settings)),
            model_provider_configured=provider_configured,
        )

    @app.get("/local/v1/settings", response_model=RuntimeSettingsResponse)
    async def get_runtime_settings() -> dict[str, Any]:
        return _runtime_settings_payload(
            app.state.settings,
            version=app.state.runtime_settings_version,
        )

    @app.put("/local/v1/settings", response_model=RuntimeSettingsResponse)
    async def update_runtime_settings(body: UpdateRuntimeSettingsRequest) -> dict[str, Any]:
        current = _runtime_settings_payload(
            app.state.settings,
            version=app.state.runtime_settings_version,
        )
        current.update(body.model_dump(exclude_none=True))
        validated = RuntimeSettingsResponse(**current)
        values = validated.model_dump(exclude={"version"})
        store: LocalStore = app.state.store
        stored = await store.put_runtime_settings(values)
        updated = _apply_runtime_settings(app.state.settings, values)
        app.state.settings = updated
        app.state.coordinator.settings = updated
        app.state.runtime_settings_version = int(stored["version"])
        return _runtime_settings_payload(updated, version=int(stored["version"]))

    @app.get(
        "/local/v1/model-providers",
        response_model=ListLocalModelProvidersResponse,
    )
    async def list_model_providers(request: Request) -> dict[str, Any]:
        store: LocalStore = app.state.store
        try:
            providers = [
                await _model_provider_response(row)
                for row in await store.list_model_providers(principal_id=request.state.principal_id)
            ]
        except CredentialStoreError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"providers": providers}

    @app.put(
        "/local/v1/model-providers/{provider_id}",
        response_model=LocalModelProvider,
    )
    async def upsert_model_provider(
        request: Request,
        provider_id: str,
        body: UpsertLocalModelProviderRequest,
    ) -> LocalModelProvider:
        provider_id = provider_id.strip().lower()
        if not _MODEL_PROVIDER_ID_RE.fullmatch(provider_id) or provider_id in {
            "auto",
            "fake",
            "gateway",
            "local",
        }:
            raise HTTPException(status_code=400, detail="model provider id is invalid or reserved")
        models = [model.model_dump(mode="json") for model in body.models]
        if len({model["model_id"] for model in models}) != len(models):
            raise HTTPException(status_code=400, detail="model ids must be unique per provider")
        principal_id = request.state.principal_id
        api_key = body.api_key.strip() if body.api_key is not None else None
        if api_key and not body.requires_api_key:
            raise HTTPException(
                status_code=400,
                detail="API key must be omitted when the provider does not require one",
            )
        base_url = _model_provider_base_url(body.base_url)
        store: LocalStore = app.state.store
        try:
            async with app.state.coordinator.model_provider_mutation(
                principal_id=principal_id,
                provider_id=provider_id,
            ):
                existing = await store.get_model_provider(
                    principal_id=principal_id,
                    provider_id=provider_id,
                )
                needs_credential_access = bool(
                    body.requires_api_key
                    or api_key
                    or (existing and bool(existing.get("requires_api_key")))
                )
                existing_key = (
                    await get_model_api_key(
                        principal_id,
                        provider_id,
                        str(existing["credential_ref"]) if existing else None,
                    )
                    if needs_credential_access
                    else None
                )
                if body.requires_api_key and not api_key and not existing_key:
                    raise HTTPException(
                        status_code=400, detail="model provider API key is required"
                    )
                old_credential_ref = (
                    str(existing["credential_ref"]) if existing else credential_ref(provider_id)
                )
                next_credential_ref = old_credential_ref
                if api_key:
                    next_credential_ref = new_credential_ref(provider_id)
                    await set_model_api_key(
                        principal_id,
                        provider_id,
                        api_key,
                        next_credential_ref,
                    )
                try:
                    provider = await store.upsert_model_provider(
                        principal_id=principal_id,
                        provider_id=provider_id,
                        name=body.name.strip(),
                        kind=body.kind,
                        base_url=base_url,
                        requires_api_key=body.requires_api_key,
                        credential_ref=next_credential_ref,
                        models=models,
                        enabled=body.enabled,
                    )
                except BaseException:
                    if next_credential_ref != old_credential_ref:
                        await delete_model_api_key(
                            principal_id,
                            provider_id,
                            next_credential_ref,
                        )
                    raise
                if existing_key and (
                    not body.requires_api_key or next_credential_ref != old_credential_ref
                ):
                    try:
                        await delete_model_api_key(
                            principal_id,
                            provider_id,
                            old_credential_ref,
                        )
                    except CredentialStoreError:
                        log.warning(
                            "failed to clean obsolete model credential provider=%s", provider_id
                        )
                return await _model_provider_response(
                    provider,
                    credential_configured=not body.requires_api_key
                    or bool(api_key or existing_key),
                )
        except CredentialStoreError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.delete(
        "/local/v1/model-providers/{provider_id}",
        response_model=LocalModelProvider,
    )
    async def remove_model_provider(request: Request, provider_id: str) -> LocalModelProvider:
        principal_id = request.state.principal_id
        store: LocalStore = app.state.store
        try:
            async with app.state.coordinator.model_provider_mutation(
                principal_id=principal_id,
                provider_id=provider_id,
            ):
                provider = await store.get_model_provider(
                    principal_id=principal_id,
                    provider_id=provider_id,
                )
                if provider is None:
                    raise HTTPException(status_code=404, detail="model provider not found")
                response = await _model_provider_response(provider)
                provider_credential_ref = str(provider["credential_ref"])
                await store.delete_model_provider(
                    principal_id=principal_id,
                    provider_id=provider_id,
                )
                for ref in {provider_credential_ref, credential_ref(provider_id)}:
                    try:
                        await delete_model_api_key(principal_id, provider_id, ref)
                    except CredentialStoreError:
                        log.warning(
                            "failed to clean deleted model credential provider=%s", provider_id
                        )
        except CredentialStoreError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return response

    @app.get("/local/v1/models", response_model=LocalRuntimeModelCatalog)
    async def list_runtime_models(request: Request) -> dict[str, Any]:
        store: LocalStore = app.state.store
        models: list[dict[str, Any]] = []
        try:
            for row in await store.list_model_providers(principal_id=request.state.principal_id):
                if not bool(row.get("enabled")):
                    continue
                requires_key = bool(row.get("requires_api_key"))
                configured = not requires_key or bool(
                    await get_model_api_key(
                        request.state.principal_id,
                        str(row["id"]),
                        str(row["credential_ref"]),
                    )
                )
                for model in _provider_models(row):
                    models.append(
                        {
                            "spec": f"local:{row['id']}:{model['model_id']}",
                            "model_id": model["model_id"],
                            "display_name": model["display_name"],
                            "provider_id": row["id"],
                            "provider_name": row["name"],
                            "tool_calling": bool(model.get("tool_calling")),
                            "streaming": bool(model.get("streaming")),
                            "max_input_tokens": model.get("max_input_tokens"),
                            "max_output_tokens": model.get("max_output_tokens"),
                            "available": configured
                            and bool(model.get("tool_calling"))
                            and bool(model.get("streaming")),
                        }
                    )
        except CredentialStoreError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"models": models}

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
    async def list_workspaces(request: Request) -> dict[str, Any]:
        store: LocalStore = app.state.store
        return {"workspaces": await store.list_workspaces(principal_id=request.state.principal_id)}

    @app.post("/local/v1/workspaces", response_model=LocalWorkspaceAuthorization)
    async def add_workspace(request: Request, body: CreateWorkspaceRequest) -> dict[str, Any]:
        """Authorize a workspace path. Returns the flat row — the TS
        `authorizeLocalWorkspace` reads `.id / .path / .label` directly
        (no wrapper)."""
        store: LocalStore = app.state.store
        raw_path = body.path.strip()
        if not raw_path:
            raise HTTPException(status_code=400, detail="path required")
        path = await _normalized_path(raw_path)
        if not await asyncio.to_thread(Path(path).is_dir):
            raise HTTPException(status_code=400, detail="workspace must be an existing directory")
        return await store.create_workspace(
            principal_id=request.state.principal_id,
            path=path,
            label=body.label.strip() or path,
        )

    @app.delete(
        "/local/v1/workspaces/{workspace_id}",
        response_model=LocalWorkspaceAuthorization,
    )
    async def remove_workspace(request: Request, workspace_id: str) -> dict[str, Any]:
        """Revoke a workspace authorization. Returns the deleted row
        matching the TS `revokeLocalWorkspace` →
        `Promise<LocalWorkspaceAuthorization>` signature."""
        store: LocalStore = app.state.store
        # Fetch before delete so we can return the record. If it didn't
        # exist, surface a 404 — client `decodeLocalResponse` throws
        # which the renderer catches and shows to the user.
        existing = None
        principal_id = request.state.principal_id
        for ws in await store.list_workspaces(principal_id=principal_id):
            if ws["id"] == workspace_id:
                existing = ws
                break
        if existing is None:
            raise HTTPException(status_code=404, detail="workspace not found")
        await store.delete_workspace(principal_id=principal_id, workspace_id=workspace_id)
        return existing

    @app.get("/local/v1/threads", response_model=ListThreadsResponse)
    async def list_threads(
        request: Request,
        limit: int = Query(default=100, ge=1, le=500),
        before_created_at: str | None = Query(default=None),
        before_id: str | None = Query(default=None),
    ):
        store: LocalStore = app.state.store
        if (before_created_at is None) != (before_id is None):
            raise HTTPException(status_code=400, detail="both thread page cursors are required")
        threads, cursor, has_more = await store.list_threads(
            principal_id=request.state.principal_id,
            limit=limit,
            before_created_at=before_created_at,
            before_id=before_id,
        )
        return {
            "threads": [_thread_record_for_api(thread) for thread in threads],
            "cursor": cursor,
            "has_more": has_more,
            "next_before_created_at": threads[-1]["created_at"] if has_more and threads else None,
            "next_before_id": threads[-1]["id"] if has_more and threads else None,
        }

    @app.get("/local/v1/threads/changes", response_model=ListThreadChangesResponse)
    async def list_thread_changes(
        request: Request,
        after: int = Query(default=0, ge=0),
        limit: int = Query(default=500, ge=1, le=1000),
    ):
        store: LocalStore = app.state.store
        changes, cursor = await store.thread_changes_since(
            principal_id=request.state.principal_id,
            after_cursor=after,
            limit=limit,
        )
        return {"changes": changes, "cursor": cursor}

    @app.get("/local/v1/threads/{thread_id}", response_model=LocalThreadSnapshot)
    async def get_thread_snapshot(
        request: Request,
        thread_id: str,
        before_position: int | None = Query(default=None, ge=1),
        item_limit: int = Query(default=200, ge=2, le=500),
        event_limit: int = Query(default=5000, ge=1, le=10000),
        expected_version: int | None = Query(default=None, ge=1),
    ):
        store: LocalStore = app.state.store
        try:
            snapshot = await store.get_thread_snapshot(
                principal_id=request.state.principal_id,
                thread_id=thread_id,
                before_position=before_position,
                item_limit=item_limit,
                event_limit=event_limit,
                expected_version=expected_version,
            )
        except RunResultConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if snapshot is None:
            raise HTTPException(status_code=404, detail="thread not found")
        items = []
        for item in snapshot["items"]:
            try:
                metadata = json.loads(item.get("metadata_json") or "{}")
            except (json.JSONDecodeError, TypeError):
                metadata = {}
            items.append({**item, "metadata": metadata if isinstance(metadata, dict) else {}})
        events = []
        for event in snapshot["events"]:
            try:
                payload = json.loads(event.get("payload_json") or "{}")
            except (json.JSONDecodeError, TypeError):
                payload = {}
            events.append({**event, "payload": payload if isinstance(payload, dict) else {}})
        return {
            **snapshot,
            "thread": _thread_record_for_api(snapshot["thread"]),
            "items": items,
            "events": events,
        }

    @app.patch("/local/v1/threads/{thread_id}", response_model=LocalThread)
    async def update_thread(
        request: Request,
        thread_id: str,
        body: UpdateLocalThreadRequest,
    ):
        store: LocalStore = app.state.store
        thread = await store.update_thread(
            principal_id=request.state.principal_id,
            thread_id=thread_id,
            title=body.title,
            metadata=body.metadata,
            archived=body.archived,
        )
        if thread is None:
            raise HTTPException(status_code=404, detail="thread not found")
        return _thread_record_for_api(thread)

    @app.delete("/local/v1/threads/{thread_id}", response_model=DeleteLocalThreadResponse)
    async def delete_thread(request: Request, thread_id: str):
        store: LocalStore = app.state.store
        try:
            version = await store.delete_thread(
                principal_id=request.state.principal_id,
                thread_id=thread_id,
            )
        except RunResultConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if version is None:
            raise HTTPException(status_code=404, detail="thread not found")
        return {"id": thread_id, "deleted": True, "version": version}

    @app.get("/local/v1/runs", response_model=ListRunsResponse)
    async def list_runs(request: Request) -> dict[str, Any]:
        """Recent runs newest-first.

        Client `listLocalRuns()` (packages/runtime-client/src/client.ts:283)
        reads `{runs: LocalRun[]}` on every boot. Previously this route
        didn't exist — every Electron launch silently 404'd here and
        the conversation history sidebar came up empty.
        """
        store: LocalStore = app.state.store
        runs = await store.list_runs(principal_id=request.state.principal_id)
        return {"runs": runs}

    @app.post(
        "/local/v1/commands",
        response_model=(
            CancelRunCommandReceipt
            | AnswerQuestionCommandReceipt
            | ResolvePermissionCommandReceipt
            | PlanResolveCommandReceipt
            | ToolReconcileCommandReceipt
        ),
    )
    async def accept_command(
        request: Request,
        body: (
            CancelRunCommand
            | AnswerQuestionCommand
            | ResolvePermissionCommand
            | PlanResolveCommand
            | ToolReconcileCommand
        ),
    ) -> dict[str, Any]:
        store: LocalStore = app.state.store
        coordinator: RunCoordinator = app.state.coordinator
        if isinstance(body, ToolReconcileCommand):
            command_payload = {
                "type": body.type,
                "operation_id": body.operation_id,
                "decision": body.decision,
            }
            try:
                replay = await store.accepted_command_receipt(
                    principal_id=request.state.principal_id,
                    command_id=body.command_id,
                    command_type=body.type,
                    payload=command_payload,
                )
                if replay is not None:
                    if replay.get("resumed"):
                        coordinator.wake_jobs()
                    return replay
                reconciliation = await store.get_wait_candidate(body.operation_id)
                if reconciliation is None or reconciliation.get("kind") != "tool_reconciliation":
                    raise KeyError(body.operation_id)
                run = await _owned_run(
                    store,
                    principal_id=request.state.principal_id,
                    run_id=str(reconciliation["run_id"]),
                    not_found_detail="tool reconciliation not found",
                )
                await _authorized_workspace_path(
                    store,
                    principal_id=request.state.principal_id,
                    path=run.get("workspace_path"),
                )
                await coordinator.reconcile_resume_head(str(reconciliation["run_id"]))
                results = await _tool_reconciliation_results(
                    store,
                    operation_id=body.operation_id,
                    decision=body.decision,
                )
                receipt, _created = await store.request_tool_reconcile_command(
                    principal_id=request.state.principal_id,
                    command_id=body.command_id,
                    operation_id=body.operation_id,
                    decision=body.decision,
                    **results,
                )
            except KeyError as exc:
                raise HTTPException(
                    status_code=404, detail="tool reconciliation not found"
                ) from exc
            except (CommandConflictError, WaitDecisionConflictError) as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            except WorkspaceAdmissionError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            if receipt["resumed"]:
                coordinator.wake_jobs()
            return receipt
        if isinstance(body, PlanResolveCommand):
            instructions = (body.instructions or "").strip() or None
            command_payload: dict[str, Any] = {
                "type": body.type,
                "approval_id": body.approval_id,
                "decision": body.decision,
            }
            if instructions is not None:
                command_payload["instructions"] = instructions
            try:
                replay = await store.accepted_command_receipt(
                    principal_id=request.state.principal_id,
                    command_id=body.command_id,
                    command_type=body.type,
                    payload=command_payload,
                )
                if replay is not None:
                    if replay.get("resumed"):
                        coordinator.wake_jobs()
                    return replay
                approval = await store.get_plan_approval(body.approval_id)
                if approval is None:
                    raise KeyError(body.approval_id)
                run = await _owned_run(
                    store,
                    principal_id=request.state.principal_id,
                    run_id=str(approval["run_id"]),
                    not_found_detail="plan approval not found",
                )
                await _authorized_workspace_path(
                    store,
                    principal_id=request.state.principal_id,
                    path=run.get("workspace_path"),
                )
                await coordinator.reconcile_resume_head(str(approval["run_id"]))
                receipt, _created = await store.request_plan_resolve_command(
                    principal_id=request.state.principal_id,
                    command_id=body.command_id,
                    approval_id=body.approval_id,
                    decision=body.decision,
                    instructions=instructions,
                )
            except KeyError as exc:
                raise HTTPException(status_code=404, detail="plan approval not found") from exc
            except (CommandConflictError, WaitDecisionConflictError) as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            except WorkspaceAdmissionError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            if receipt["resumed"]:
                coordinator.wake_jobs()
            return receipt
        if isinstance(body, ResolvePermissionCommand):
            edited_action = body.edited_action.model_dump() if body.edited_action else None
            command_payload: dict[str, Any] = {
                "type": body.type,
                "permission_id": body.permission_id,
                "decision": body.decision,
                "scope": body.scope,
            }
            if edited_action is not None:
                command_payload["edited_action"] = edited_action
            try:
                replay = await store.accepted_command_receipt(
                    principal_id=request.state.principal_id,
                    command_id=body.command_id,
                    command_type=body.type,
                    payload=command_payload,
                )
                if replay is not None:
                    if replay.get("resumed"):
                        coordinator.wake_jobs()
                    return replay
                permission = await store.get_permission(body.permission_id)
                if permission is None:
                    raise KeyError(body.permission_id)
                run = await _owned_run(
                    store,
                    principal_id=request.state.principal_id,
                    run_id=str(permission["run_id"]),
                    not_found_detail="permission not found",
                )
                await _authorized_workspace_path(
                    store,
                    principal_id=request.state.principal_id,
                    path=run.get("workspace_path"),
                )
                await coordinator.reconcile_resume_head(str(permission["run_id"]))
                receipt, _created = await store.request_permission_resolve_command(
                    principal_id=request.state.principal_id,
                    command_id=body.command_id,
                    permission_id=body.permission_id,
                    decision=body.decision,
                    scope=body.scope,
                    edited_action=edited_action,
                )
            except KeyError as exc:
                raise HTTPException(status_code=404, detail="permission not found") from exc
            except (CommandConflictError, WaitDecisionConflictError) as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            except WorkspaceAdmissionError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            if receipt["resumed"]:
                coordinator.wake_jobs()
            return receipt
        if isinstance(body, AnswerQuestionCommand):
            command_payload = {
                "type": body.type,
                "question_id": body.question_id,
                "answers": body.answers,
            }
            try:
                replay = await store.accepted_command_receipt(
                    principal_id=request.state.principal_id,
                    command_id=body.command_id,
                    command_type=body.type,
                    payload=command_payload,
                )
                if replay is not None:
                    if replay.get("resumed"):
                        coordinator.wake_jobs()
                    return replay
                question = await store.get_question(body.question_id)
                if question is None:
                    raise KeyError(body.question_id)
                run = await _owned_run(
                    store,
                    principal_id=request.state.principal_id,
                    run_id=str(question["run_id"]),
                    not_found_detail="question not found",
                )
                await _authorized_workspace_path(
                    store,
                    principal_id=request.state.principal_id,
                    path=run.get("workspace_path"),
                )
                await coordinator.reconcile_resume_head(str(question["run_id"]))
                receipt, _created = await store.request_question_answer_command(
                    principal_id=request.state.principal_id,
                    command_id=body.command_id,
                    question_id=body.question_id,
                    answers=body.answers,
                )
            except KeyError as exc:
                raise HTTPException(status_code=404, detail="question not found") from exc
            except (CommandConflictError, WaitDecisionConflictError) as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            except WorkspaceAdmissionError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            if receipt["resumed"]:
                coordinator.wake_jobs()
            return receipt
        try:
            receipt, _created = await store.request_run_cancel_command(
                principal_id=request.state.principal_id,
                command_id=body.command_id,
                run_id=body.run_id,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="run not found") from exc
        except CommandConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if receipt["canceled"]:
            await coordinator.cancel_run(body.run_id)
        return receipt

    @app.post("/local/v1/runs", response_model=LocalRun)
    async def create_run(request: Request, body: CreateRunRequest) -> dict[str, Any]:
        """Create a new run. Returns the flat `LocalRun` shape (NOT
        `{run: {...}}`) — that's the contract `client.test.ts:63-92`
        pins and what TypeScript's `createLocalRun` reads via
        `decodeLocalResponse<LocalRun>`."""
        goal = body.goal.strip()
        if not goal:
            raise HTTPException(status_code=400, detail="goal required")
        principal_id = request.state.principal_id
        workspace_path = (
            await _normalized_path(body.workspace_path) if body.workspace_path is not None else None
        )
        coordinator: RunCoordinator = app.state.coordinator
        try:
            return await coordinator.start_run(
                principal_id=principal_id,
                command_id=body.command_id,
                client_message_id=body.client_message_id,
                protocol_version=body.protocol_version,
                required_capabilities=body.required_capabilities,
                goal=goal,
                thread_id=body.thread_id,
                user_input=body.user_input,
                assistant_message_id=body.assistant_message_id,
                thread_title=body.thread_title,
                thread_metadata=body.thread_metadata,
                user_item_metadata=body.user_item_metadata,
                replace_from_client_id=body.replace_from_client_id,
                workspace_path=workspace_path,
                # The daemon's legacy `mode` column carries the Runtime model selection.
                mode=body.model,
                history=body.history or [],
                parent_run_id=body.parent_run_id,
                settings=body.settings,
                metadata=body.metadata,
            )
        except CommandConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except WorkspaceAdmissionError as exc:
            status_code = 409 if "no longer available" in str(exc) else 403
            raise HTTPException(status_code=status_code, detail=str(exc)) from exc
        except ParentRunAdmissionError as exc:
            status_code = 404 if "not found" in str(exc) else 409
            raise HTTPException(status_code=status_code, detail=str(exc)) from exc
        except ThreadAdmissionError as exc:
            status_code = 404 if "not found" in str(exc) else 409
            raise HTTPException(status_code=status_code, detail=str(exc)) from exc
        except RunAdmissionError as exc:
            raise HTTPException(
                status_code=409,
                detail={"code": exc.code, "message": str(exc)},
            ) from exc

    @app.get("/local/v1/schedules", response_model=ListScheduledRunsResponse)
    async def list_schedules(
        request: Request,
        status: str | None = Query(default=None),
        notify_pending: bool = Query(default=False),
    ) -> dict[str, Any]:
        store: LocalStore = app.state.store
        schedules = await store.list_scheduled_runs_for_principal(
            principal_id=request.state.principal_id,
            status=status,
            notify_pending=notify_pending,
        )
        return {"schedules": schedules}

    @app.post("/local/v1/schedules", response_model=LocalScheduledRun)
    async def create_schedule(request: Request, body: CreateScheduledRunRequest) -> dict[str, Any]:
        goal = body.goal.strip()
        if not goal:
            raise HTTPException(status_code=400, detail="goal required")
        store: LocalStore = app.state.store
        principal_id = request.state.principal_id
        workspace_path = (
            await _normalized_path(body.workspace_path) if body.workspace_path is not None else None
        )
        try:
            return await store.create_scheduled_run(
                principal_id=principal_id,
                goal=goal,
                run_at=_normalize_schedule_time(body.run_at),
                workspace_path=workspace_path,
                model=body.model.strip(),
                history=body.history or [],
                settings=freeze_run_settings(app.state.settings, body.settings),
                metadata=sanitize_run_metadata(body.metadata),
            )
        except WorkspaceAdmissionError as exc:
            status_code = 409 if "no longer available" in str(exc) else 403
            raise HTTPException(status_code=status_code, detail=str(exc)) from exc

    @app.delete("/local/v1/schedules/{schedule_id}", response_model=LocalScheduledRun)
    async def cancel_schedule(request: Request, schedule_id: str) -> dict[str, Any]:
        store: LocalStore = app.state.store
        schedule = await store.cancel_scheduled_run(
            principal_id=request.state.principal_id,
            schedule_id=schedule_id,
        )
        if schedule is None:
            raise HTTPException(status_code=404, detail="schedule not found")
        return schedule

    @app.post("/local/v1/schedules/{schedule_id}/notified", response_model=LocalScheduledRun)
    async def mark_schedule_notified(request: Request, schedule_id: str) -> dict[str, Any]:
        store: LocalStore = app.state.store
        schedule = await store.mark_scheduled_run_notified(
            principal_id=request.state.principal_id,
            schedule_id=schedule_id,
        )
        if schedule is None:
            raise HTTPException(status_code=404, detail="schedule not found")
        return schedule

    @app.post("/local/v1/runs/{run_id}/fork", response_model=LocalRun)
    async def fork_run(request: Request, run_id: str, body: ForkRunRequest) -> dict[str, Any]:
        checkpoint_id = body.checkpoint_id.strip()
        if not checkpoint_id:
            raise HTTPException(status_code=400, detail="checkpoint_id required")
        await _owned_run(
            app.state.store,
            principal_id=request.state.principal_id,
            run_id=run_id,
        )
        coordinator: RunCoordinator = app.state.coordinator
        try:
            return await coordinator.fork_run(
                principal_id=request.state.principal_id,
                source_run_id=run_id,
                command_id=body.command_id,
                client_message_id=body.client_message_id,
                assistant_message_id=body.assistant_message_id,
                thread_id=body.thread_id,
                protocol_version=body.protocol_version,
                required_capabilities=body.required_capabilities,
                checkpoint_id=checkpoint_id,
                goal=body.goal,
                user_input=body.user_input,
                thread_title=body.thread_title,
                thread_metadata=body.thread_metadata,
                user_item_metadata=body.user_item_metadata,
                metadata=body.metadata,
            )
        except RunNotFoundError as exc:
            raise HTTPException(status_code=404, detail="run not found") from exc
        except CheckpointNotFoundError as exc:
            raise HTTPException(status_code=404, detail="checkpoint not found") from exc
        except WorkspaceAdmissionError as exc:
            status_code = 409 if "no longer available" in str(exc) else 403
            raise HTTPException(status_code=status_code, detail=str(exc)) from exc
        except ThreadAdmissionError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except CommandConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except RunAdmissionError as exc:
            raise HTTPException(
                status_code=409,
                detail={"code": exc.code, "message": str(exc)},
            ) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/local/v1/runs/{run_id}", response_model=LocalRun)
    async def get_run(request: Request, run_id: str) -> dict[str, Any]:
        """Return the flat run record (same shape as POST /runs)."""
        store: LocalStore = app.state.store
        return await _owned_run(
            store,
            principal_id=request.state.principal_id,
            run_id=run_id,
        )

    @app.get("/local/v1/runs/{run_id}/stream")
    async def stream_run(
        request: Request,
        run_id: str,
        after: int = Query(default=0, ge=0),
    ) -> EventSourceResponse:
        store: LocalStore = app.state.store
        await _owned_run(
            store,
            principal_id=request.state.principal_id,
            run_id=run_id,
        )
        first_seq, latest_seq = await store.event_sequence_window(run_id)
        if after > latest_seq or (first_seq is not None and after < first_seq - 1):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "event_cursor_reset_required",
                    "message": "event cursor is outside the retained event window",
                    "requested_after": after,
                    "first_available_seq": first_seq,
                    "latest_seq": latest_seq,
                },
            )
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
                async for event in coordinator.stream(run_id, after_seq=after):
                    yield {
                        "id": str(event.get("seq") or event["id"]),
                        "event": event["event_type"],
                        "data": json.dumps(event, default=str, ensure_ascii=False),
                    }
            finally:
                yield {"data": "[DONE]"}

        # `sep="\n"` (LF) matches the Runtime SDK parser, which splits on
        # `/\n\n/`. sse-starlette's default `\r\n` is spec-correct but does
        # not match that protocol contract.
        return EventSourceResponse(gen(), sep="\n")

    @app.post("/local/v1/runs/{run_id}/cancel", response_model=CancelRunResponse)
    async def cancel_run(request: Request, run_id: str) -> dict[str, Any]:
        await _owned_run(
            app.state.store,
            principal_id=request.state.principal_id,
            run_id=run_id,
        )
        coordinator: RunCoordinator = app.state.coordinator
        ok = await coordinator.cancel_run(run_id)
        return {"canceled": ok}

    @app.post(
        "/local/v1/runs/{run_id}/inject",
        response_model=InjectRunInstructionResponse,
    )
    async def inject_run_instruction(
        request: Request,
        run_id: str,
        body: InjectRunInstructionRequest,
    ) -> dict[str, Any]:
        content = body.content.strip()
        if not content:
            raise HTTPException(status_code=400, detail="content required")
        store: LocalStore = app.state.store
        run = await _owned_run(
            store,
            principal_id=request.state.principal_id,
            run_id=run_id,
        )
        if run.get("status") in _TERMINAL_RUN_STATUSES:
            raise HTTPException(status_code=409, detail="run is not active")
        record = await store.create_steering_instruction(run_id=run_id, content=content)
        return {"run_id": run_id, "instruction_id": record["id"], "queued": True}

    # ---- compatibility shims the client expects (pre-existing Node API) ----
    #
    # Some of these are full features that didn't make it into Phase 3'/4'
    # yet. They return safe defaults / 501 so the client can boot without
    # crashing on missing routes. Implementations land in Phase 6'+.

    @app.post("/local/v1/permissions/{permission_id}", response_model=PermissionResolution)
    async def resolve_permission(
        request: Request, permission_id: str, body: ResolvePermissionRequest
    ) -> dict[str, Any]:
        """Approve, edit, or deny a parameter-bound tool review.

        Translates the client's `{decision, scope}` body into the
        `{"decisions": [{"type": "approve"|"edit"|"reject", ...}]}` shape
        that `ToolReviewMiddleware` verifies on resume. One LangGraph
        interrupt can contain multiple action requests, so the run
        resumes only after every permission in the current pause batch is
        resolved, preserving the original `permission.required` order.

        `scope=run` is a bounded durable grant for the same tool, exact
        argument fingerprint, and risk class; it never widens by tool name.
        """
        decision_text = body.decision
        scope = body.scope
        store: LocalStore = app.state.store
        record = await store.get_permission(permission_id)
        if record is None:
            raise HTTPException(status_code=404, detail="permission not found")
        run = await _owned_run(
            store,
            principal_id=request.state.principal_id,
            run_id=record["run_id"],
            not_found_detail="permission not found",
        )
        await _authorized_workspace_path(
            store,
            principal_id=request.state.principal_id,
            path=run.get("workspace_path"),
        )
        if decision_text == "approve":
            hitl_decision: dict[str, Any] = {"type": "approve"}
            persisted_status = "approved"
        elif decision_text == "edit":
            assert body.edited_action is not None
            if body.edited_action.name != record["tool_name"]:
                raise HTTPException(status_code=400, detail="tool name cannot be changed")
            hitl_decision = {
                "type": "edit",
                "edited_action": body.edited_action.model_dump(),
            }
            persisted_status = "approved"
        else:
            hitl_decision = {
                "type": "reject",
                "message": "Tool execution denied by user.",
            }
            persisted_status = "denied"
        already_resolved = record.get("status") != "pending"
        if not already_resolved and run.get("status") in _TERMINAL_RUN_STATUSES:
            raise HTTPException(status_code=409, detail="run is not awaiting a decision")
        resolution_event = {
            "request_id": permission_id,
            "tool": record["tool_name"],
            "tool_name": record["tool_name"],
            "operation_id": record.get("operation_id"),
            "decision": decision_text,
            "scope": str(scope),
        }
        try:
            await store.resolve_permission(
                permission_id,
                status=persisted_status,
                scope=str(scope),
                decision=hitl_decision,
                event_payload=None if already_resolved else resolution_event,
            )
        except (PermissionDecisionConflictError, WaitDecisionConflictError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        coordinator: RunCoordinator = app.state.coordinator
        if not already_resolved:
            coordinator.wake_run(str(record["run_id"]))
        resume_payload = await store.wait_cycle_resume_payload(
            run_id=str(record["run_id"]),
            wait_cycle_id=str(record.get("wait_cycle_id") or record["id"]),
        )
        if resume_payload is None:
            ok = False
        else:
            ok = await _ensure_resume_job(
                store=store,
                coordinator=coordinator,
                run_id=record["run_id"],
                decision=resume_payload,
            )
        return {
            "permission_id": permission_id,
            "resolved": True,
            "decision": decision_text,
            "scope": scope,
            "resumed": ok,
        }

    @app.post("/local/v1/questions/{question_id}", response_model=QuestionAnswer)
    async def answer_question(
        request: Request, question_id: str, body: AnswerQuestionRequest
    ) -> dict[str, Any]:
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
        run = await _owned_run(
            store,
            principal_id=request.state.principal_id,
            run_id=record["run_id"],
            not_found_detail="question not found",
        )
        await _authorized_workspace_path(
            store,
            principal_id=request.state.principal_id,
            path=run.get("workspace_path"),
        )
        already_answered = record.get("status") != "pending"
        if not already_answered and run.get("status") in _TERMINAL_RUN_STATUSES:
            raise HTTPException(status_code=409, detail="run is not awaiting a decision")
        answer_event = {"request_id": question_id, "answers": answers}
        try:
            await store.answer_question(
                question_id,
                answers=answers,
                event_payload=None if already_answered else answer_event,
            )
        except WaitDecisionConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        coordinator: RunCoordinator = app.state.coordinator
        if not already_answered:
            coordinator.wake_run(str(record["run_id"]))
        resume_payload = await store.wait_cycle_resume_payload(
            run_id=str(record["run_id"]),
            wait_cycle_id=str(record.get("wait_cycle_id") or record["id"]),
        )
        if resume_payload is not None:
            ok = await _ensure_resume_job(
                store=store,
                coordinator=coordinator,
                run_id=record["run_id"],
                decision=resume_payload,
            )
        else:
            ok = False
        return {
            "question_id": question_id,
            "answered": True,
            "resumed": ok,
        }

    @app.post(
        "/local/v1/tool-reconciliations/{operation_id}",
        response_model=ToolReconciliationResolution,
    )
    async def reconcile_tool_operation(
        request: Request,
        operation_id: str,
        body: ReconcileToolRequest,
    ) -> dict[str, Any]:
        store: LocalStore = app.state.store
        command_id = f"legacy_reconcile_{operation_id}"
        try:
            replay = await store.accepted_command_receipt(
                principal_id=request.state.principal_id,
                command_id=command_id,
                command_type="tool.reconcile",
                payload={
                    "type": "tool.reconcile",
                    "operation_id": operation_id,
                    "decision": body.decision,
                },
            )
        except CommandConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if replay is not None:
            if replay.get("resumed"):
                app.state.coordinator.wake_jobs()
            return replay
        record = await store.get_wait_candidate(operation_id)
        if record is None or record.get("kind") != "tool_reconciliation":
            raise HTTPException(status_code=404, detail="tool reconciliation not found")
        run = await _owned_run(
            store,
            principal_id=request.state.principal_id,
            run_id=str(record["run_id"]),
            not_found_detail="tool reconciliation not found",
        )
        await _authorized_workspace_path(
            store,
            principal_id=request.state.principal_id,
            path=run.get("workspace_path"),
        )
        if run.get("status") in _TERMINAL_RUN_STATUSES:
            raise HTTPException(status_code=409, detail="run is not awaiting a decision")
        coordinator: RunCoordinator = app.state.coordinator
        await coordinator.reconcile_resume_head(str(record["run_id"]))
        try:
            results = await _tool_reconciliation_results(
                store,
                operation_id=operation_id,
                decision=body.decision,
            )
            receipt, _created = await store.request_tool_reconcile_command(
                principal_id=request.state.principal_id,
                command_id=command_id,
                operation_id=operation_id,
                decision=body.decision,
                **results,
            )
        except (CommandConflictError, WaitDecisionConflictError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except WorkspaceAdmissionError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if receipt["resumed"]:
            coordinator.wake_jobs()
        return receipt

    @app.post("/local/v1/plans/{approval_id}", response_model=PlanApprovalResolution)
    async def resolve_plan_approval(
        request: Request,
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
        run = await _owned_run(
            store,
            principal_id=request.state.principal_id,
            run_id=record["run_id"],
            not_found_detail="plan approval not found",
        )
        await _authorized_workspace_path(
            store,
            principal_id=request.state.principal_id,
            path=run.get("workspace_path"),
        )
        if run.get("status") in _TERMINAL_RUN_STATUSES:
            raise HTTPException(status_code=409, detail="run is not awaiting a decision")
        coordinator: RunCoordinator = app.state.coordinator
        await coordinator.reconcile_resume_head(str(record["run_id"]))
        try:
            receipt, _created = await store.request_plan_resolve_command(
                principal_id=request.state.principal_id,
                command_id=f"legacy_plan_{approval_id}",
                approval_id=approval_id,
                decision=decision_text,
                instructions=instructions,
            )
        except (CommandConflictError, WaitDecisionConflictError) as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except WorkspaceAdmissionError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if receipt["resumed"]:
            coordinator.wake_jobs()
        return receipt

    @app.get("/local/v1/artifacts/{artifact_id}", response_model=LocalArtifact)
    async def get_artifact(request: Request, artifact_id: str) -> dict[str, Any]:
        """Return a single artifact record.

        Shape matches the TS `LocalArtifact` interface
        (`client.ts:38-44`): `{id, title, content, tool_name?, created_at?}`.
        """
        store: LocalStore = app.state.store
        record = await store.get_artifact(artifact_id)
        if record is None:
            raise HTTPException(status_code=404, detail="artifact not found")
        await _owned_run(
            store,
            principal_id=request.state.principal_id,
            run_id=record["run_id"],
            not_found_detail="artifact not found",
        )
        return {
            "id": record["id"],
            "title": record["title"],
            "content": record["content"],
            "tool_name": record.get("tool_name"),
            "created_at": record["created_at"],
        }

    @app.get("/local/v1/workspace-files")
    async def get_workspace_file(
        request: Request,
        path: str = Query(..., description="Absolute file path inside an authorized workspace"),
    ):
        """Stream a file's bytes back to the renderer.

        Gated by `local_workspaces` — the file's parent chain must be inside
        a path the user previously authorized in the client. We do
        NOT serve arbitrary paths; that would let a compromised renderer
        exfiltrate the entire disk.

        Used by the right-side DocPreviewPanel to fetch .docx / .xlsx
        bytes for in-browser rendering (docx-preview, exceljs). No
        response_model — this is a binary stream, not a JSON shape, so
        it stays out of api_schemas.py / openapi.json by design.
        """
        if not path:
            raise HTTPException(status_code=400, detail="path required")
        resolved = Path(await _normalized_path(path))
        try:
            if not await asyncio.to_thread(resolved.is_file):
                raise HTTPException(status_code=404, detail="file not found")
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"invalid path: {exc}") from exc
        store: LocalStore = app.state.store
        workspaces = await store.list_workspaces(principal_id=request.state.principal_id)
        # `is_relative_to` walks the parent chain; we need the file to live
        # under *some* authorized workspace root.
        roots = [Path(ws["path"]) for ws in workspaces]
        if not any(resolved == root or resolved.is_relative_to(root) for root in roots):
            raise HTTPException(
                status_code=403,
                detail="path is not inside any authorized workspace",
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
        request: Request,
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
        resolved = Path(await _normalized_path(path))
        try:
            if not await asyncio.to_thread(resolved.is_file):
                raise HTTPException(status_code=404, detail="file not found")
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"invalid path: {exc}") from exc
        if resolved.suffix.lower() != ".pptx":
            raise HTTPException(status_code=400, detail="path must point to a .pptx file")
        store: LocalStore = app.state.store
        workspaces = await store.list_workspaces(principal_id=request.state.principal_id)
        roots = [Path(ws["path"]) for ws in workspaces]
        if not any(resolved == root or resolved.is_relative_to(root) for root in roots):
            raise HTTPException(
                status_code=403,
                detail="path is not inside any authorized workspace",
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
    async def run_diagnostics(request: Request, run_id: str) -> dict[str, Any]:
        """Return the full `LocalRunDiagnostics` payload.

        Shape (per TS interface `packages/runtime-client/src/client.ts`):
            { schema_version: 1, exported_at, local_host_version?,
              run, events, permissions, artifacts, latest_checkpoint, handoff }

        Phase 5'+ used to return only `{run, events}`, so the
        `DiagnosticsPanel` rendered NaN counts (permissions.length on
        undefined) and the "latest checkpoint" tab was always missing.
        """
        store: LocalStore = app.state.store
        run = await _owned_run(
            store,
            principal_id=request.state.principal_id,
            run_id=run_id,
        )
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
        tool_receipts = await store.list_tool_receipts_for_run(run_id)
        wait_candidates = await store.list_wait_candidates_for_run(run_id)
        artifacts = await store.list_artifacts_for_run(run_id)
        latest_checkpoint = await _latest_checkpoint_summary(app.state.checkpointer, run)
        reflection = await _latest_checkpoint_reflection(app.state.checkpointer, run)
        return {
            "schema_version": 1,
            "exported_at": datetime.now(UTC).isoformat(),
            "local_host_version": __version__,
            "run": run,
            "events": events,
            "permissions": permissions,
            "tool_receipts": [
                {
                    key: receipt.get(key)
                    for key in (
                        "operation_id",
                        "tool_call_id",
                        "tool_name",
                        "tool_version",
                        "arguments_hash",
                        "risk",
                        "status",
                        "attempt_count",
                        "result_hash",
                        "error_type",
                        "created_at",
                        "started_at",
                        "completed_at",
                        "updated_at",
                    )
                }
                for receipt in tool_receipts
            ],
            "wait_candidates": [
                {
                    key: candidate.get(key)
                    for key in ("id", "kind", "status", "created_at", "resolved_at")
                }
                for candidate in wait_candidates
            ],
            "artifacts": artifacts,
            "latest_checkpoint": latest_checkpoint,
            "handoff": _build_diagnostics_handoff(run, events, permissions, artifacts),
            "feature_ledger": _latest_feature_ledger(artifacts),
            "reflection": reflection,
        }

    @app.post(
        "/local/v1/workspaces/diagnose",
        response_model=LocalWorkspaceDiagnosis,
        response_model_exclude_none=True,
    )
    async def diagnose_workspace(
        request: Request, body: DiagnoseWorkspaceRequest
    ) -> dict[str, Any]:
        """Inspect a candidate path against the authorization registry.

        Response matches the TS `LocalWorkspaceDiagnosis` shape — the
        `reason` enum drives the workspace-picker's "why disabled?"
        copy, keep it stable.
        """
        store: LocalStore = app.state.store
        path = body.path.strip()
        if not path:
            raise HTTPException(status_code=400, detail="path required")
        resolved = await _normalized_path(path)
        path_obj = Path(resolved)
        exists, is_directory = await asyncio.gather(
            asyncio.to_thread(path_obj.exists),
            asyncio.to_thread(path_obj.is_dir),
        )
        workspace = await store.workspace_by_path(
            principal_id=request.state.principal_id,
            path=resolved,
        )
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
    async def clear_memory(request: Request) -> dict[str, Any]:
        """Wipe this authenticated principal's long-term memory namespaces.

        Backs the "清空记忆 / Clear memory" button in the agent settings
        dialog. Walks every ("notes", ...) namespace in pages of 200
        (matches the BaseStore default search limit ceiling for SQLite stores)
        and deletes each key. Returns the total count so the UI can render an
        accurate "cleared N memories" toast.

        Idempotent: calling it on an empty store returns
        `deleted_count: 0` without error.
        """
        from .tools.memory import memory_namespace_prefix

        agent_store = getattr(app.state, "agent_store", None)
        if agent_store is None:
            raise HTTPException(status_code=503, detail="memory store not initialized")
        deleted = 0
        # `asearch(query=None)` returns everything in the namespace
        # (no semantic ranking needed — we just want the keys).
        # Loop until a page comes back smaller than `limit` so we don't
        # over-fetch on a single-item store.
        page_size = 200
        principal_prefix = memory_namespace_prefix(request.state.principal_id)
        namespaces = [principal_prefix]
        if hasattr(agent_store, "alist_namespaces"):
            namespaces = []
            offset = 0
            while True:
                page = await agent_store.alist_namespaces(
                    prefix=principal_prefix,
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


async def _ensure_resume_job(
    *,
    store: LocalStore,
    coordinator: RunCoordinator,
    run_id: str,
    decision: dict[str, Any],
) -> bool:
    """Idempotently ensure a resolved wait has a durable resume owner.

    The decision and resume job are currently separate SQLite transactions.
    Replaying the same decision repairs the crash window between them instead
    of falsely acknowledging a run that remains permanently paused.
    """
    if await coordinator.resume_run(run_id=run_id, decision=decision):
        return True
    run = await store.get_run(run_id)
    if run is None:
        return False
    if run.get("status") in {"completed", "failed", "canceled"}:
        return True
    if run.get("status") not in {"waiting_permission", "waiting_input"}:
        return False
    active_job = await store.get_active_run_job(run_id)
    return bool(
        active_job
        and active_job.get("kind") == "resume"
        and active_job.get("status") in {"pending", "leased"}
    )


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


def _thread_record_for_api(thread: dict[str, Any]) -> dict[str, Any]:
    try:
        metadata = json.loads(thread.get("metadata_json") or "{}")
    except (json.JSONDecodeError, TypeError):
        metadata = {}
    return {**thread, "metadata": metadata if isinstance(metadata, dict) else {}}


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


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(str(value or "{}"))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


async def _tool_reconciliation_results(
    store: LocalStore,
    *,
    operation_id: str,
    decision: str,
) -> dict[str, str | None]:
    record = await store.get_wait_candidate(operation_id)
    if record is None or record.get("kind") != "tool_reconciliation":
        raise KeyError(operation_id)
    payload = _json_object(record.get("payload_json"))
    current_receipt = await store.get_tool_receipt(operation_id)
    prior_operation_id = str(payload.get("prior_operation_id") or operation_id)
    prior_receipt = await store.get_tool_receipt(prior_operation_id)
    if current_receipt is None or prior_receipt is None:
        raise WaitDecisionConflictError("tool reconciliation receipt is missing")
    current_result = (
        _tool_reconciliation_result(current_receipt, decision)
        if decision != "retry_not_executed"
        else None
    )
    prior_result = _tool_reconciliation_result(
        prior_receipt,
        "abort" if decision == "retry_not_executed" else decision,
    )
    return {
        "current_result_json": current_result,
        "current_result_hash": (
            hashlib.sha256(current_result.encode()).hexdigest()
            if current_result is not None
            else None
        ),
        "prior_result_json": prior_result,
        "prior_result_hash": hashlib.sha256(prior_result.encode()).hexdigest(),
    }


def _tool_reconciliation_result(receipt: dict[str, Any], decision: str) -> str:
    completed = decision == "confirmed_completed"
    return serialize_tool_result(
        ToolMessage(
            content=(
                "The user verified that the external action completed successfully."
                if completed
                else "The user verified that this uncertain action must not be retried automatically."
            ),
            name=str(receipt.get("tool_name") or ""),
            tool_call_id=str(receipt.get("tool_call_id") or ""),
            status="success" if completed else "error",
        )
    )


def _hitl_decision_for_permission(permission: dict[str, Any]) -> dict[str, Any]:
    raw = permission.get("decision_json")
    if isinstance(raw, str) and raw:
        try:
            decision = json.loads(raw)
        except json.JSONDecodeError:
            decision = None
        if isinstance(decision, dict):
            return decision
    # Compatibility for permission rows created before decision_json existed.
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
    elif status == "cleanup_required":
        headline = "Run is quarantined because execution cleanup could not yet be confirmed."
        blockers.append("The Runtime has not released this execution generation.")
        next_actions = [
            "Do not retry automatically; inspect Runtime diagnostics and cleanup state."
        ]
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


def _run_checkpoint_config(run: dict[str, Any]) -> dict[str, Any]:
    configurable = {"thread_id": str(run.get("graph_thread_id") or run["id"])}
    checkpoint_id = run.get("graph_checkpoint_id")
    if isinstance(checkpoint_id, str) and checkpoint_id:
        configurable["checkpoint_id"] = checkpoint_id
    return {"configurable": configurable}


async def _latest_checkpoint_summary(
    checkpointer: Any, run: dict[str, Any]
) -> dict[str, Any] | None:
    if checkpointer is None:
        return None
    run_id = str(run["id"])
    try:
        item = await _run_checkpoint_tuple(checkpointer, run)
        if item is None:
            return None
        checkpoint = item.checkpoint if isinstance(item.checkpoint, dict) else {}
        metadata = item.metadata if isinstance(item.metadata, dict) else {}
        configurable = item.config.get("configurable", {})
        checkpoint_id = _first_string(checkpoint.get("id"), configurable.get("checkpoint_id"))
        if not checkpoint_id:
            return None
        step = _int_or_none(metadata.get("step"))
        reason = _first_string(metadata.get("source"), metadata.get("reason"), "checkpoint")
        return {
            "id": checkpoint_id,
            "run_id": run_id,
            "step": step if step is not None else 0,
            "reason": reason or "checkpoint",
            "messages_count": _checkpoint_messages_count(checkpoint),
            "created_at": _first_string(checkpoint.get("ts"), metadata.get("created_at")),
        }
    except Exception as exc:
        log.warning("latest checkpoint summary failed run_id=%s: %s", run_id, exc)
    return None


async def _latest_checkpoint_reflection(
    checkpointer: Any, run: dict[str, Any]
) -> dict[str, Any] | None:
    if checkpointer is None:
        return None
    run_id = str(run["id"])
    try:
        item = await _run_checkpoint_tuple(checkpointer, run)
        checkpoint = item.checkpoint if item is not None else None
        if not isinstance(checkpoint, dict):
            return None
        channel_values = checkpoint.get("channel_values")
        if not isinstance(channel_values, dict):
            return None
        return _diagnostics_reflection(channel_values.get("reflection"))
    except Exception as exc:
        log.warning("latest checkpoint reflection failed run_id=%s: %s", run_id, exc)
    return None


async def _run_checkpoint_tuple(checkpointer: Any, run: dict[str, Any]) -> Any | None:
    config = _run_checkpoint_config(run)
    if run.get("graph_checkpoint_id") and hasattr(checkpointer, "aget_tuple"):
        return await checkpointer.aget_tuple(config)
    if hasattr(checkpointer, "alist"):
        async for item in checkpointer.alist(config, limit=1):
            return item
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
