"""Assemble the LangGraph agent via `create_deep_agent`.

We use `deepagents.create_deep_agent` instead of plain
`langchain.agents.create_agent` because it auto-assembles a sensible
batteries-included middleware stack and the SubAgent / Skills /
Filesystem / Shell integrations we need anyway. Our
remaining job is to:

  1. Bind the Runtime-selected BYOK model provider.
  2. Build a *narrow* tool list (everything outside the deepagents auto
     stack: time, environment, clipboard, local web fetch, MCP, browser).
  3. Pass per-run config: `subagents=`, `skills=`, `backend=`,
     `checkpointer=`.
  4. Append our custom middleware (5 phase hooks + retry/limit knobs)
     into the user-middleware slot.

What deepagents auto-adds for us (we no longer wire these manually):

  TodoListMiddleware              ← planning (P3)
  SkillsMiddleware                ← when `skills=` passed
  FilesystemMiddleware            ← ls/read_file/write_file/edit_file
                                    + glob/grep + execute tools
  SubAgentMiddleware + Async      ← when `subagents=` passed
  SummarizationMiddleware         ← auto context compaction
  PatchToolCallsMiddleware        ← orphan tool_call self-heal
  ToolExclusionMiddleware         ← conditional tool gating
  Prompt caching                  ← provider middleware when supported
  MemoryMiddleware                ← AGENTS.md loader
  Tool review + durable receipts  ← our Runtime middleware, including subagents
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import os
import shutil
import tempfile
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, FilesystemBackend, LocalShellBackend
from langchain.agents.middleware import (
    AgentMiddleware,
    ToolCallLimitMiddleware,
    ToolRetryMiddleware,
)
from langchain_core.messages import SystemMessage
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.store.base import BaseStore
from langgraph.store.sqlite.aio import AsyncSqliteStore

from ..config import Settings, get_settings
from ..llm.ledger import LedgerChatModel
from ..llm.runtime import RuntimeModelProxy
from ..middleware.completion_router import (
    CompletionRouterMiddleware,
    completion_repair_instruction,
)
from ..middleware.input_guard import InputGuardMiddleware
from ..middleware.outbound_policy import OutboundPolicyMiddleware
from ..middleware.plan_first import PlanFirstMiddleware
from ..middleware.steering import SteeringMiddleware
from ..middleware.tool_execution import ToolExecutionMiddleware
from ..middleware.tool_result_retry import ToolResultRetryMiddleware
from ..middleware.tool_review import ToolReviewMiddleware
from ..middleware.tool_visibility import ToolVisibilityMiddleware
from ..store.sqlite import LocalStore
from ..tools.mcp import (
    MCP_TOOL_SEARCH_THRESHOLD,
    MCPToolCatalog,
    make_mcp_tool_search,
)
from ..tools.registry import build_tools, tool_definition
from ..tools.runtime import RuntimeToolProxy
from .backends import ReadOnlyBackend, ReadOnlyFileBackend, RuntimeBackend
from .context_builder import AsyncToolExecutionGate, RuntimeContext, build_default_context
from .subagents import build_subagents

log = logging.getLogger("local_host.agent.builder")

_AGENT_DEFINITION_CACHE_MAX = 16
_AGENT_STATE_SCHEMA_VERSION = 1

_DEEPAGENTS_TOOL_NAMES = {
    "write_todos",
    "task",
    "ls",
    "read_file",
    "write_file",
    "edit_file",
    "glob",
    "grep",
    "execute",
}


# Read-only tools that benefit from auto-retry on transient failure.
# Consequential tools are deliberately excluded: after a timeout the Runtime
# cannot safely infer whether an external or filesystem side effect happened.
# We also exclude tools that use
# LangGraph control-flow exceptions (`interrupt()` → GraphInterrupt),
# because `ToolRetryMiddleware._handle_failure` would swallow that
# exception and convert it to a ToolMessage, defeating the pause.
RETRY_ELIGIBLE_TOOLS: list[str] = [
    "web.fetch",
    "read_file",
]


def _resolve_skills_dirs() -> list[Path]:
    """Return every existing skills directory the daemon should scan.

    We deliberately accept multiple roots so the agent can see skills
    from several ecosystems at once:

      1. `SHEJANE_LOCAL_SKILLS_PATH` env var (comma-separated for
         multiple paths) — full override; when set, the defaults below
         are NOT consulted.
      2. Defaults (used when the env var is unset):
         - `~/.shejane/skills/` — our own canonical location
         - `~/.claude/skills/`  — Claude Code / skills.sh default install
           target (skills.sh CLI installs here when run with
           `--agent claude-code -g`, the most common case)

    Each entry is a `Path` that exists and is a directory. Missing
    paths are silently dropped so an unset Claude install doesn't error.
    """
    custom = os.environ.get("SHEJANE_LOCAL_SKILLS_PATH", "").strip()
    if custom:
        raw_paths = [p.strip() for p in custom.split(",") if p.strip()]
    else:
        raw_paths = [
            str(Path.home() / ".shejane" / "skills"),
            str(Path.home() / ".claude" / "skills"),
        ]
    out: list[Path] = []
    for raw in raw_paths:
        candidate = Path(raw).expanduser()
        if candidate.is_dir():
            out.append(candidate)
    return out


def _agent_backend_routes(
    *,
    skills_dirs: list[Path],
    memory_sources: list[str] | None,
    workspace_root: Path,
    attachment_bindings: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Return explicit filesystem routes that may live outside workspace.

    The main backend runs in `virtual_mode=True`, so absolute paths outside
    the selected workspace are blocked by default. SkillsMiddleware and
    MemoryMiddleware still need to read configured source directories; route
    only those exact roots through their own virtual backends.
    """
    routes: dict[str, Any] = {}
    for item in attachment_bindings or []:
        source = Path(item["source_path"])
        backend = ReadOnlyFileBackend(
            FilesystemBackend(
                root_dir=source.parent,
                virtual_mode=True,
                max_file_size_mb=10,
            ),
            source.name,
        )
        routes[item["virtual_path"]] = backend
    for root in (path.expanduser() for path in skills_dirs):
        backend_root = root.resolve(strict=False)
        if workspace_root == backend_root or workspace_root.is_relative_to(backend_root):
            raise ValueError("writable workspace cannot be nested inside a read-only skill root")
        backend = ReadOnlyBackend(
            FilesystemBackend(
                root_dir=backend_root,
                virtual_mode=True,
                max_file_size_mb=10,
            )
        )
        for route in _absolute_route_keys(root):
            routes[route] = backend
        relative_route = _workspace_route(root, workspace_root, directory=True)
        if relative_route is not None:
            routes[relative_route] = backend
    for source in memory_sources or []:
        path = Path(source).expanduser()
        if path.is_dir():
            path = path / "AGENTS.md"
        backend = ReadOnlyFileBackend(
            FilesystemBackend(
                root_dir=path.parent.resolve(strict=False),
                virtual_mode=True,
                max_file_size_mb=10,
            ),
            path.name,
        )
        for route in _absolute_file_route_keys(path):
            routes[route] = backend
        relative_route = _workspace_route(path, workspace_root, directory=False)
        if relative_route is not None:
            routes[relative_route] = backend
    return routes


def _absolute_route_keys(path: Path) -> list[str]:
    expanded = path.expanduser()
    raw = expanded if expanded.is_absolute() else expanded.absolute()
    resolved = expanded.resolve(strict=False)
    keys = {
        str(raw).rstrip("/") + "/",
        str(resolved).rstrip("/") + "/",
    }
    return sorted(keys)


def _absolute_file_route_keys(path: Path) -> list[str]:
    expanded = path.expanduser()
    raw = expanded if expanded.is_absolute() else expanded.absolute()
    return sorted({str(raw), str(expanded.resolve(strict=False))})


def _workspace_route(path: Path, workspace_root: Path, *, directory: bool) -> str | None:
    try:
        relative = path.expanduser().resolve(strict=False).relative_to(workspace_root)
    except ValueError:
        return None
    route = "/" + relative.as_posix().lstrip("/")
    return route.rstrip("/") + "/" if directory else route


def _build_agent_backend(
    *,
    effective_workspace: str,
    skills_dirs: list[Path],
    memory_sources: list[str] | None,
    attachment_bindings: list[dict[str, str]] | None = None,
):
    workspace_root = Path(effective_workspace).expanduser().resolve()
    default = LocalShellBackend(
        root_dir=workspace_root,
        virtual_mode=True,
        env={
            key: os.environ[key]
            for key in ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SHELL", "USER")
            if key in os.environ
        },
    )
    routes: dict[str, FilesystemBackend] = {}
    for route in _absolute_route_keys(Path(effective_workspace)):
        routes[route] = default
    routes.update(
        _agent_backend_routes(
            skills_dirs=skills_dirs,
            memory_sources=memory_sources,
            workspace_root=workspace_root,
            attachment_bindings=attachment_bindings,
        )
    )
    return CompositeBackend(default=default, routes=routes)


def _execution_scratch(
    settings: Settings,
    *,
    run_id: str,
    execution_attempt_id: str | None,
    resource_stack: AsyncExitStack | None,
) -> str:
    """Create one private filesystem root owned by this execution attempt."""
    settings.ensure_data_dir()
    parent = settings.data_dir / "execution-workspaces"
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    identity = f"{run_id}\0{execution_attempt_id or 'untracked'}"
    prefix = hashlib.sha256(identity.encode()).hexdigest()[:12] + "-"
    scratch = Path(tempfile.mkdtemp(prefix=prefix, dir=parent))
    scratch.chmod(0o700)
    if resource_stack is None:
        shutil.rmtree(scratch)
        raise RuntimeError("no-workspace execution requires a resource stack")
    resource_stack.callback(shutil.rmtree, scratch)
    return str(scratch)


async def open_checkpointer(
    settings: Settings | None = None,
) -> tuple[AsyncSqliteSaver, AsyncExitStack]:
    """Open a long-lived AsyncSqliteSaver.

    Eager `await checkpointer.setup()` avoids the lazy-init disk-I/O race
    observed in the Phase 0 spike on macOS APFS.
    """
    settings = settings or get_settings()
    settings.ensure_data_dir()
    stack = AsyncExitStack()
    saver = await stack.enter_async_context(
        AsyncSqliteSaver.from_conn_string(str(settings.checkpoint_db_path))
    )
    await saver.setup()
    log.info("checkpointer ready at %s", settings.checkpoint_db_path)
    return saver, stack


async def open_store(settings: Settings | None = None) -> tuple[BaseStore, AsyncExitStack]:
    """Open a long-lived `BaseStore` for cross-run durable memory.

    This is what explicit memory tools write into and what
    `langgraph.store.base.BaseStore`-aware tools read via `runtime.store`.

    Backed by `AsyncSqliteStore` on the daemon data dir — same WAL +
    eager-setup pattern as the checkpointer.
    """
    settings = settings or get_settings()
    settings.ensure_data_dir()
    stack = AsyncExitStack()
    store = await stack.enter_async_context(
        AsyncSqliteStore.from_conn_string(str(settings.store_db_path))
    )
    await store.setup()
    log.info("store ready at %s", settings.store_db_path)
    return store, stack


def _custom_middleware(
    settings: Settings,
    *,
    deferred_tool_names: set[str] | None = None,
) -> list[AgentMiddleware]:
    """Our middleware that deepagents doesn't auto-add.

    Order:
      InputGuard → ToolCallLimit → ToolRetry →
      durable model-call reservation →
      CompletionRouter

    `before_*` fire top-to-bottom, `after_*` fire bottom-to-top —
    CompletionRouter is the only custom after-model hook that may change the
    graph route. Execution settlement and cleanup are owned by RunCoordinator,
    outside the graph middleware chain.
    """
    middleware: list[AgentMiddleware] = [
        RuntimePromptMiddleware(),
        RuntimeModelMiddleware(),
        ToolVisibilityMiddleware(deferred_tool_names=deferred_tool_names),
        OutboundPolicyMiddleware(),
        InputGuardMiddleware(mode=settings.input_guard_mode),  # P1
        # Plan & Execute mode (off | always | auto; auto-skips trivial
        # tasks). Sourced from settings so the Advanced agent-settings
        # panel can override the SHEJANE_PLAN_FIRST env default per-run.
        PlanFirstMiddleware(mode=settings.plan_first_mode),
        ToolReviewMiddleware(),
        ToolExecutionMiddleware(),
    ]
    middleware.extend(
        [
            ToolCallLimitMiddleware(  # P8
                tool_name="web.search",
                run_limit=settings.research_search_limit,
            ),
            # Retry only network/IO-flaky tools, with a tight retryable
            # exception set. We deliberately exclude tools that use
            # `interrupt()` (user.ask, task, etc.) because
            # ToolRetryMiddleware's `_handle_failure` catches *any*
            # Exception (including GraphInterrupt) and converts it to a
            # ToolMessage — that would swallow our pause signals. Only
            # listing the tools we DO want retried (RETRY_ELIGIBLE_TOOLS)
            # keeps GraphInterrupt-flow tools out of its catch path.
            ToolRetryMiddleware(
                max_retries=settings.max_tool_retries,
                tools=list(RETRY_ELIGIBLE_TOOLS),
                retry_on=(
                    ConnectionError,
                    TimeoutError,
                    OSError,
                ),
            ),
            # Some tools return structured envelopes instead of raising.
            # Retry only when the envelope explicitly opts in with
            # `{ok:false, retryable:true}` and the tool is in the same
            # allowlist as exception retries.
            ToolResultRetryMiddleware(
                max_retries=settings.max_tool_retries,
                tools=list(RETRY_ELIGIBLE_TOOLS),
                initial_delay=0.25,
                max_delay=2.0,
            ),
        ]
    )
    middleware.extend(
        [
            CompletionRouterMiddleware(max_verification_repairs=settings.verification_repair_max),
        ]
    )
    return middleware


class RuntimePromptMiddleware(AgentMiddleware):
    """Append model-visible instructions from the invocation context."""

    @staticmethod
    def _request_with_context(request: Any) -> Any:
        context = getattr(getattr(request, "runtime", None), "context", None)
        if not isinstance(context, RuntimeContext):
            return request
        prompt = build_default_context(context)
        repair_instruction = completion_repair_instruction(
            getattr(request, "state", {}),
            run_id=context.run_id,
        )
        if repair_instruction:
            prompt = f"{prompt}\n\n<runtime-repair>\n{repair_instruction}\n</runtime-repair>"
        system_message = request.system_message
        return request.override(
            system_message=SystemMessage(
                content=[
                    {"type": "text", "text": prompt},
                    *system_message.content_blocks,
                ]
            )
        )

    def wrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        return handler(self._request_with_context(request))

    async def awrap_model_call(
        self,
        request: Any,
        handler: Callable[[Any], Awaitable[Any]],
    ) -> Any:
        return await handler(self._request_with_context(request))


class RuntimeModelMiddleware(AgentMiddleware):
    """Select the model connection owned by this invocation."""

    @staticmethod
    def _request_with_model(request: Any) -> Any:
        context = getattr(getattr(request, "runtime", None), "context", None)
        model = getattr(context, "model", None)
        return request.override(model=model) if model is not None else request

    def wrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        return handler(self._request_with_model(request))

    async def awrap_model_call(
        self,
        request: Any,
        handler: Callable[[Any], Awaitable[Any]],
    ) -> Any:
        return await handler(self._request_with_model(request))


def _build_chat_model(
    settings: Settings,
    run_id: str,
    mode: str,
    *,
    model_binding: dict[str, Any] | None = None,
    model_api_key: str | None = None,
) -> Any:
    """Build the selected BYOK model, or the deterministic test model."""
    if settings.fake_llm:
        from ..llm.fake import FakeBackendChatModel

        return FakeBackendChatModel(
            profile={
                "max_input_tokens": settings.unknown_model_max_input_tokens,
                "max_output_tokens": settings.unknown_model_max_output_tokens,
            }
        )
    if model_binding and model_binding.get("provider") in {"openai_compatible", "anthropic"}:
        raw_profile = model_binding.get("profile")
        profile = (
            {
                key: raw_profile[key]
                for key in (
                    "tool_calling",
                    "image_inputs",
                    "max_input_tokens",
                    "max_output_tokens",
                )
                if key in raw_profile and raw_profile[key] is not None
            }
            if isinstance(raw_profile, dict)
            else {}
        )
        profile.setdefault("max_input_tokens", settings.unknown_model_max_input_tokens)
        profile.setdefault("max_output_tokens", settings.unknown_model_max_output_tokens)
        profile.setdefault("image_inputs", False)
        profile["image_tool_message"] = profile["image_inputs"]
        if model_binding["provider"] == "anthropic":
            from langchain_anthropic import ChatAnthropic

            return ChatAnthropic(
                model=str(model_binding["model_id"]),
                base_url=str(model_binding["base_url"]),
                api_key=model_api_key or "local",
                streaming=True,
                stream_usage=True,
                max_retries=0,
                max_tokens=int(profile["max_output_tokens"]),
                timeout=settings.model_request_timeout_seconds,
                profile=profile,
            )

        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=str(model_binding["model_id"]),
            base_url=str(model_binding["base_url"]),
            api_key=model_api_key or "local",
            http_client=httpx.Client(),
            http_async_client=httpx.AsyncClient(),
            streaming=True,
            stream_usage=True,
            max_retries=0,
            max_tokens=int(profile["max_output_tokens"]),
            timeout=settings.model_request_timeout_seconds,
            profile=profile,
        )
    raise RuntimeError("Runtime BYOK model binding is required")


def _int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _str_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _outbound_is_external(
    settings: Settings,
    model_binding: dict[str, Any] | None,
) -> bool:
    if settings.fake_llm or (model_binding or {}).get("provider") == "fake":
        return False
    if model_binding is None:
        return True
    raw_url = str((model_binding or {}).get("base_url") or "")
    hostname = (urlparse(raw_url).hostname or "").strip().lower()
    if hostname == "localhost":
        return False
    try:
        return not ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return True


def _outbound_pii_types(spec: str) -> tuple[str, ...]:
    valid = {"email", "credit_card", "ip", "mac_address", "url"}
    return tuple(
        dict.fromkeys(
            item for item in (part.strip().lower() for part in spec.split(",")) if item in valid
        )
    )


async def build_agent(
    *,
    store: LocalStore,
    checkpointer: AsyncSqliteSaver,
    agent_store: BaseStore | None = None,
    workspace_root: str | None,
    attachment_bindings: list[dict[str, str]] | None = None,
    run_id: str,
    mode: str = "fast",
    task_goal: str | None = None,
    turn_count: int | None = None,
    repair_context: dict[str, Any] | None = None,
    retry_context: dict[str, Any] | None = None,
    memory_enabled: bool = True,
    skills_enabled: bool = True,
    mcp_enabled: bool = True,
    mcp_disabled_servers: set[str] | None = None,
    mcp_catalog: MCPToolCatalog | None = None,
    settings: Settings | None = None,
    model_binding: dict[str, Any] | None = None,
    model_api_key: str | None = None,
    resource_stack: AsyncExitStack | None = None,
    execution_attempt_id: str | None = None,
    runtime_context: RuntimeContext | None = None,
    definition_cache: dict[str, Any] | None = None,
    definition_cache_lock: asyncio.Lock | None = None,
    steering_emit: Callable[[str, dict[str, Any]], Awaitable[None]] | None = None,
    extra_middleware: list[AgentMiddleware] | None = None,
) -> Any:
    """Build a compiled agent for one run via `create_deep_agent`.

    Args:
        store:           Daemon-level SQLite store (workspace lookups).
        checkpointer:    Shared AsyncSqliteSaver from `open_checkpointer`.
        workspace_root:  Authorized filesystem root for this run.
                         Becomes the FilesystemBackend's root_dir, which
                         deepagents' built-in FilesystemMiddleware + shell
                         execute use as their sandbox. None ⇒ virtual_mode.
        run_id:          LangGraph `thread_id` — unique per logical run.
        mode:            Runtime model selection stored with the run.
        task_goal:       Current user goal for this run. Echoed into the
                         <task> layer of the prompt so it survives long
                         tool-call chains.
        turn_count:      How many messages we're into the conversation
                         (incl. current user message). Used for the
                         <state> layer.
        repair_context:  Optional run metadata for a user-confirmed repair
                         attempt. Rendered into the <state> layer so the
                         model can distinguish repair from ordinary retry.
        retry_context:   Optional run metadata for a user-confirmed retry
                         attempt. Rendered into the <state> layer so the
                         model can avoid repeating the failed path blindly.
        memory_enabled:  When False, drops `memory.search` and `memory.write`
                         from the tool list.
                         The user toggle in agent settings flows in here
                         via RunCoordinator._settings_overrides.
        skills_enabled:  When False, passes `skills=None` to deepagents so
                         no skill instructions get injected into the prompt
                         and the agent doesn't see them. Mirrors the
                         memory toggle pattern.
        mcp_enabled:     When False, omits MCP tools from this execution
                         entirely so no MCP tools land in the agent's tool
                         list. The discovered servers are still reported
                         via GET /local/v1/mcp-servers — only their
                         activation is suppressed. Same toggle pattern as
                         memory + skills.
        mcp_disabled_servers:
                         Per-server opt-out. Names in this set are
                         filtered before the Runtime MCP catalog is read.
                         Driven by the per-row switches in the client's
                         MCP tab; layered ON TOP of mcp_enabled — if the
                         master flag is off, this set is moot.
        mcp_catalog:     Runtime-owned MCP directory and Server Supervisor.
                         Runs acquire a fixed snapshot lease through the
                         execution resource stack.
        settings:        Override settings (tests).
        steering_emit:   Optional async event sink used by SteeringMiddleware
                         to mirror injected instructions onto the run SSE
                         stream after it drains the SQLite queue.
        extra_middleware: Appended after the built-in custom stack.
    """
    settings = settings or get_settings()
    if workspace_root is None and resource_stack is None:
        raise RuntimeError("no-workspace execution requires a resource stack")

    tools = await build_tools(
        browser_llm=None,  # browser sub-agent LLM is Phase 8'+ work
        browser_headless=settings.browser_headless,
    )
    catalog = mcp_catalog or MCPToolCatalog(settings.data_dir)
    if mcp_catalog is None and resource_stack is not None:
        resource_stack.push_async_callback(catalog.close)
    if mcp_enabled and resource_stack is not None:
        dynamic_tools = await resource_stack.enter_async_context(
            catalog.acquire_tools(
                disabled_servers=mcp_disabled_servers,
                reserved_names={tool.name for tool in tools} | _DEEPAGENTS_TOOL_NAMES,
            )
        )
    elif mcp_enabled:
        dynamic_tools = await catalog.get_tools(
            disabled_servers=mcp_disabled_servers,
            reserved_names={tool.name for tool in tools} | _DEEPAGENTS_TOOL_NAMES,
        )
    else:
        dynamic_tools = []
    mcp_tool_names = {item.name for item in dynamic_tools}
    tools.extend(
        RuntimeToolProxy.from_tool(
            item.tool,
            description=item.description,
            args_schema=item.args_schema,
        )
        for item in dynamic_tools
    )
    deferred_tool_names = (
        mcp_tool_names if len(mcp_tool_names) >= MCP_TOOL_SEARCH_THRESHOLD else set()
    )
    if deferred_tool_names:
        tools.append(make_mcp_tool_search([item.tool for item in dynamic_tools]))
    if not memory_enabled:
        tools = [t for t in tools if not t.name.startswith("memory.")]

    provider_model = _build_chat_model(
        settings,
        run_id,
        mode,
        model_binding=model_binding,
        model_api_key=model_api_key,
    )
    _register_model_cleanup(provider_model, resource_stack)
    model = (
        LedgerChatModel(
            delegate=provider_model,
            store=store,
            run_id=run_id,
            execution_attempt_id=execution_attempt_id,
            model_name=mode,
            max_calls=settings.max_model_calls,
            profile=getattr(provider_model, "profile", None),
        )
        if execution_attempt_id is not None
        else provider_model
    )
    definition_model = RuntimeModelProxy(profile=getattr(model, "profile", None))

    skills_dirs = _resolve_skills_dirs() if skills_enabled else []
    skills_arg = [str(d) for d in skills_dirs] if skills_dirs else None
    memory_arg = _resolve_memory_sources(settings)

    # FilesystemBackend serves three deepagents subsystems at once:
    #   - FilesystemMiddleware tools (ls / read_file / write_file / edit_file)
    #   - `execute` shell tool (run commands inside the sandbox)
    #   - SubAgentMiddleware (subagents share this scratch area)
    #   - SkillsMiddleware (reads `<skill-dir>/SKILL.md`)
    #
    # The default backend runs in virtual mode so the selected workspace
    # is a real path boundary. Skills and configured memory sources can
    # still live elsewhere, but only through explicit per-root routes.
    if workspace_root:
        effective_workspace = workspace_root
    else:
        effective_workspace = _execution_scratch(
            settings,
            run_id=run_id,
            execution_attempt_id=execution_attempt_id,
            resource_stack=resource_stack,
        )
    backend = _build_agent_backend(
        effective_workspace=effective_workspace,
        skills_dirs=skills_dirs,
        memory_sources=memory_arg,
        attachment_bindings=attachment_bindings,
    )

    middleware = _custom_middleware(
        settings,
        deferred_tool_names=deferred_tool_names,
    )
    middleware.insert(3, SteeringMiddleware())

    if extra_middleware:
        middleware.extend(extra_middleware)

    subagents_arg = (
        build_subagents(
            main_tools=tools,
            main_model=definition_model,
            deferred_tool_names=deferred_tool_names,
        )
        if settings.enable_subagents
        else None
    )

    # Complete provider-independent prompt stack: Runtime identity and safety,
    # developer instructions, task, skills hint, run state, and environment.
    # See context_builder.py for the full layout.
    if runtime_context is None:
        runtime_context = RuntimeContext(
            run_id=run_id,
            store=store,
            steering_emit=steering_emit,
            backend=backend,
            model=model,
            dynamic_tools={item.name: item.tool for item in dynamic_tools},
            execution_attempt_id=execution_attempt_id,
            tool_mutation_lock=AsyncToolExecutionGate(),
            outbound_is_external=_outbound_is_external(settings, model_binding),
            outbound_pii_types=_outbound_pii_types(settings.pii_redact_types),
            outbound_secrets=(model_api_key,) if model_api_key else (),
            memory_enabled=memory_enabled,
            workspace_root=workspace_root,
            attachments=tuple(
                str(item.get("virtual_path"))
                for item in attachment_bindings or []
                if item.get("virtual_path")
            ),
            enabled_skills=_active_skill_names(skills_arg),
            task_goal=task_goal,
            mode=mode,
            turn_count=turn_count,
            repair_intent=bool(repair_context),
            repair_attempt=_int_or_none((repair_context or {}).get("attempt")),
            repair_max_attempts=_int_or_none((repair_context or {}).get("max_attempts")),
            repair_source_run_id=_str_or_none((repair_context or {}).get("source_run_id")),
            repair_source_message_id=_str_or_none((repair_context or {}).get("source_message_id")),
            repair_failure_category=_str_or_none((repair_context or {}).get("failure_category")),
            repair_failure_action_kind=_str_or_none(
                (repair_context or {}).get("failure_action_kind")
            ),
            retry_intent=bool(retry_context),
            retry_attempt=_int_or_none((retry_context or {}).get("attempt")),
            retry_source_run_id=_str_or_none((retry_context or {}).get("source_run_id")),
            retry_source_message_id=_str_or_none((retry_context or {}).get("source_message_id")),
            retry_failure_category=_str_or_none((retry_context or {}).get("failure_category")),
            retry_failure_action_kind=_str_or_none(
                (retry_context or {}).get("failure_action_kind")
            ),
        )
    else:
        runtime_context.enabled_skills = _active_skill_names(skills_arg)
        runtime_context.backend = backend
        runtime_context.model = model
        runtime_context.execution_attempt_id = execution_attempt_id
        if not isinstance(runtime_context.tool_mutation_lock, AsyncToolExecutionGate):
            runtime_context.tool_mutation_lock = AsyncToolExecutionGate()
        runtime_context.outbound_is_external = _outbound_is_external(settings, model_binding)
        runtime_context.outbound_pii_types = _outbound_pii_types(settings.pii_redact_types)
        runtime_context.outbound_secrets = (model_api_key,) if model_api_key else ()
        runtime_context.dynamic_tools = {item.name: item.tool for item in dynamic_tools}
        runtime_context.memory_enabled = memory_enabled
        runtime_context.attachments = tuple(
            str(item.get("virtual_path"))
            for item in attachment_bindings or []
            if item.get("virtual_path")
        )

    fingerprint = _agent_definition_fingerprint(
        settings=settings,
        model_profile=getattr(definition_model, "profile", None),
        tools=tools,
        subagents=subagents_arg,
        skills=skills_arg,
        memory=memory_arg,
    )
    runtime_context.graph_definition_id = fingerprint

    def compile_definition() -> Any:
        return create_deep_agent(
            model=definition_model,
            tools=tools,
            middleware=middleware,
            subagents=subagents_arg,
            skills=skills_arg,
            memory=memory_arg,
            backend=RuntimeBackend(),
            checkpointer=checkpointer,
            store=agent_store,
            context_schema=RuntimeContext,
        )

    if definition_cache is None or extra_middleware:
        agent = compile_definition()
    elif definition_cache_lock is None:
        agent = _cached_agent_definition(definition_cache, fingerprint, compile_definition)
    else:
        async with definition_cache_lock:
            agent = _cached_agent_definition(definition_cache, fingerprint, compile_definition)
    nodes = getattr(agent, "nodes", {})
    tools_node = nodes.get("tools") if isinstance(nodes, dict) else None
    bound_tools = getattr(getattr(tools_node, "bound", None), "tools_by_name", {})
    runtime_context.tool_registry = dict(bound_tools) if isinstance(bound_tools, dict) else {}
    return agent


def _agent_definition_fingerprint(
    *,
    settings: Settings,
    model_profile: Any,
    tools: list[Any],
    subagents: list[Any] | None,
    skills: list[str] | None,
    memory: list[str] | None,
) -> str:
    payload = {
        "version": _AGENT_STATE_SCHEMA_VERSION,
        "model_profile": model_profile,
        "tools": [tool_definition(tool) for tool in tools],
        "subagents": [
            {
                "name": item.get("name"),
                "description": item.get("description"),
                "system_prompt": item.get("system_prompt"),
                "tools": [tool_definition(tool) for tool in item.get("tools", [])],
                "middleware": [type(value).__qualname__ for value in item.get("middleware", [])],
            }
            for item in (subagents or [])
            if isinstance(item, dict)
        ],
        "skills": skills or [],
        "memory": memory or [],
        "middleware": {
            "input_guard": settings.input_guard_mode,
            "plan_first": settings.plan_first_mode,
            "research_limit": settings.research_search_limit,
            "tool_retries": settings.max_tool_retries,
            "verification_repairs": settings.verification_repair_max,
            "subagents": settings.enable_subagents,
            "browser_headless": settings.browser_headless,
        },
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()


def _cached_agent_definition(
    cache: dict[str, Any],
    fingerprint: str,
    compile_definition: Callable[[], Any],
) -> Any:
    if fingerprint in cache:
        definition = cache.pop(fingerprint)
        cache[fingerprint] = definition
        return definition
    definition = compile_definition()
    cache[fingerprint] = definition
    # ponytail: bounded process-local LRU; add durable cache only if compile
    # time remains material across daemon restarts.
    if len(cache) > _AGENT_DEFINITION_CACHE_MAX:
        cache.pop(next(iter(cache)))
    return definition


def _register_model_cleanup(model: Any, stack: AsyncExitStack | None) -> None:
    """Close provider clients when the owning execution attempt ends."""
    if stack is None:
        return
    seen: set[int] = set()
    for name in ("root_async_client", "_async_client"):
        client = getattr(model, name, None)
        close = getattr(client, "close", None)
        if callable(close) and id(client) not in seen:
            seen.add(id(client))
            stack.push_async_callback(close)
    for name in ("root_client", "_client"):
        client = getattr(model, name, None)
        close = getattr(client, "close", None)
        if callable(close) and id(client) not in seen:
            seen.add(id(client))
            stack.callback(close)


def _active_skill_names(skills_arg: list[str] | None) -> list[str]:
    """Best-effort: enumerate installed skill names from the skills
    directory so the ContextBuilder can hint the model that they're
    available. Empty list when skills are off / unresolved.

    The full SKILL.md bodies are loaded into the prompt by deepagents'
    SkillsMiddleware — this layer just primes the model that the
    skills exist (deepagents lists them too but earlier in the loop
    we want our own short echo so the `enabled_skills` priority sits
    above runtime context)."""
    if not skills_arg:
        return []
    names: list[str] = []
    for path_str in skills_arg:
        path = Path(path_str)
        if not path.is_dir():
            continue
        for entry in sorted(path.iterdir()):
            if entry.is_dir() and not entry.name.startswith("_"):
                names.append(entry.name)
    return names


def _resolve_memory_sources(settings: Settings) -> list[str] | None:
    """Parse SHEJANE_LOCAL_MEMORY_PATHS (comma-separated paths) into the
    `memory=` argument of `create_deep_agent`. Each path is typically an
    `AGENTS.md` file or a directory of such files — `MemoryMiddleware`
    loads them into the system prompt at run start.

    None ⇒ memory loader skipped (MemoryMiddleware no-ops).
    """
    spec = (settings.memory_sources or "").strip()
    if not spec:
        return None
    items = [Path(p.strip()).expanduser() for p in spec.split(",") if p.strip()]
    # Deep Agents expects file paths. Preserve missing paths so its own
    # diagnostics remain useful, but normalize existing directories.
    expanded = [str(path / "AGENTS.md" if path.is_dir() else path) for path in items]
    return expanded or None
