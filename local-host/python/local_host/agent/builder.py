"""Assemble the LangGraph agent via `create_deep_agent`.

We use `deepagents.create_deep_agent` instead of plain
`langchain.agents.create_agent` because it auto-assembles a sensible
batteries-included middleware stack and the SubAgent / Skills /
Filesystem / Shell / HumanInTheLoop integrations we need anyway. Our
remaining job is to:

  1. Pick the model (BackendChatModel pointed at the cloud SSE endpoint).
  2. Build a *narrow* tool list (everything outside the deepagents auto
     stack: workspace.open, time, env, clipboard, web, image, MCP, browser).
  3. Pass per-run config: `subagents=`, `skills=`, `backend=`,
     `interrupt_on=`, `checkpointer=`.
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
  Prompt caching                  ← Go Anthropic gateway adds cache_control
  MemoryMiddleware                ← AGENTS.md loader
  HumanInTheLoopMiddleware        ← when `interrupt_on=` passed
"""

from __future__ import annotations

import logging
import os
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

import httpx
from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, FilesystemBackend
from langchain.agents.middleware import (
    AgentMiddleware,
    ContextEditingMiddleware,
    LLMToolSelectorMiddleware,
    ModelCallLimitMiddleware,
    ModelRetryMiddleware,
    PIIMiddleware,
    ToolCallLimitMiddleware,
    ToolRetryMiddleware,
)
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.store.base import BaseStore
from langgraph.store.sqlite.aio import AsyncSqliteStore

from ..config import Settings, get_settings
from ..failure_policy import build_retry_decision
from ..llm.backend import BackendChatModel, BackendLLMError
from ..middleware import (
    InputGuardMiddleware,
    MemoryWritebackMiddleware,
    OutputGuardMiddleware,
    PlanApprovalMiddleware,
    PlanFirstMiddleware,
    ProgressLedgerGuardMiddleware,
    ReflectMiddleware,
    SteeringMiddleware,
    ToolResultRetryMiddleware,
    VerificationLoopMiddleware,
)
from ..middleware.memory_writeback import memory_namespace_for_workspace
from ..store.sqlite import LocalStore
from ..tools.registry import build_tools
from .context_builder import RuntimeContext, build_default_context
from .subagents import build_subagents

log = logging.getLogger("local_host.agent.builder")


# Tools the user MUST approve before they run. Forwarded to
# `create_deep_agent(interrupt_on=...)` — deepagents wires its bundled
# HumanInTheLoopMiddleware accordingly. Tool names mix deepagents-provided
# (`write_file`, `execute`, `edit_file`) and our custom (`open.url`, etc.).
DESTRUCTIVE_TOOLS: dict[str, bool] = {
    "write_file": True,
    "edit_file": True,
    "execute": True,  # deepagents shell-equivalent
    "open.url": True,
    "open.file": True,
    "clipboard.read": True,
    "clipboard.write": True,
    "browser.task": True,  # agentic browser can do anything
    "image.generate": True,  # paid + side-effecting
    "image.edit": True,
}


# Tools the selector must never filter out — these are the agent's
# "always-available" capabilities even when LLMToolSelectorMiddleware
# narrows the toolset for a given turn:
#   - write_todos   : planning is fundamental
#   - task          : subagent dispatch — letting the LLM still hand off
#                     even when its main toolset has been narrowed
#   - memory.search : long-term memory recall — must be accessible
#                     regardless of how many other tools survive
#   - time.now      : tiny but the model often needs it for orientation
ALWAYS_INCLUDE_TOOLS: list[str] = [
    "write_todos",
    "task",
    "memory.search",
    "user.ask",  # clarifying-question gateway must always be reachable
    "time.now",
]


# Tools that benefit from auto-retry on transient failure (network /
# filesystem / browser flakes). Crucially NOT including tools that use
# LangGraph control-flow exceptions (`interrupt()` → GraphInterrupt),
# because `ToolRetryMiddleware._handle_failure` would swallow that
# exception and convert it to a ToolMessage, defeating the pause.
RETRY_ELIGIBLE_TOOLS: list[str] = [
    "web.fetch",
    "web.search",
    "browser.task",
    "execute",  # deepagents shell — FS races etc.
    "read_file",
    "write_file",
    "edit_file",
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
) -> dict[str, FilesystemBackend]:
    """Return explicit filesystem routes that may live outside workspace.

    The main backend runs in `virtual_mode=True`, so absolute paths outside
    the selected workspace are blocked by default. SkillsMiddleware and
    MemoryMiddleware still need to read configured source directories; route
    only those exact roots through their own virtual backends.
    """
    roots: list[Path] = [path.expanduser() for path in skills_dirs]
    for source in memory_sources or []:
        path = Path(source).expanduser()
        roots.append(path if path.is_dir() else path.parent)

    routes: dict[str, FilesystemBackend] = {}
    for root in roots:
        backend_root = root.resolve(strict=False)
        backend = FilesystemBackend(
            root_dir=backend_root,
            virtual_mode=True,
            max_file_size_mb=10,
        )
        for route in _absolute_route_keys(root):
            routes[route] = backend
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


def _build_agent_backend(
    *,
    effective_workspace: str,
    skills_dirs: list[Path],
    memory_sources: list[str] | None,
):
    workspace_root = Path(effective_workspace).expanduser().resolve()
    default = FilesystemBackend(
        root_dir=workspace_root,
        virtual_mode=True,
        max_file_size_mb=10,
    )
    routes: dict[str, FilesystemBackend] = {}
    for route in _absolute_route_keys(Path(effective_workspace)):
        routes[route] = default
    routes.update(
        _agent_backend_routes(
            skills_dirs=skills_dirs,
            memory_sources=memory_sources,
            workspace_root=workspace_root,
        )
    )
    return CompositeBackend(default=default, routes=routes)


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

    This is what `MemoryWritebackMiddleware` writes into (post-run summary
    of goal + final answer) and what `langgraph.store.base.BaseStore`-aware
    middleware/tools read from via `runtime.store`.

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
    memory_enabled: bool = True,
    memory_namespace: tuple[str, ...] | None = None,
) -> list[AgentMiddleware]:
    """Our middleware that deepagents doesn't auto-add.

    Order:
      InputGuard → ToolCallLimit → ToolRetry →
      ModelRetry → ModelCallLimit → ContextEditing →
      OutputGuard → VerificationLoop → ProgressLedgerGuard → Reflect → MemoryWriteback

    `before_*` fire top-to-bottom, `after_*` fire bottom-to-top —
    so OutputGuard runs before VerificationLoop after each LLM call, then the
    progress-ledger guard, Reflect, and MemoryWriteback.

    `memory_enabled=False` keeps MemoryWritebackMiddleware in the chain
    but short-circuits its hooks — surfaces of the chain stay symmetric
    across runs, only the persistence is skipped.
    """
    middleware: list[AgentMiddleware] = [
        InputGuardMiddleware(mode=settings.input_guard_mode),  # P1
        # Plan & Execute mode (off | always | auto; auto-skips trivial
        # tasks). Sourced from settings so the Advanced agent-settings
        # panel can override the SHEJANE_PLAN_FIRST env default per-run.
        PlanFirstMiddleware(mode=settings.plan_first_mode),
    ]
    if str(settings.plan_first_mode).lower() != "off":
        middleware.append(PlanApprovalMiddleware())
    # PII redaction (opt-in via SHEJANE_LOCAL_PII_REDACT). One
    # PIIMiddleware instance per PII type — they compose cleanly.
    for pii_type in _parse_pii_types(settings.pii_redact_types):
        middleware.append(
            PIIMiddleware(
                pii_type=pii_type,
                strategy="redact",
                apply_to_input=True,
                apply_to_output=False,  # don't break legitimate model output
                apply_to_tool_results=True,  # leak surface: tool returns
            )
        )
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
            ModelRetryMiddleware(
                max_retries=settings.max_model_retries,
                retry_on=_should_retry_model_exception,
                on_failure="error",
            ),
        ]
    )
    if settings.fallback_models.strip():
        log.warning(
            "SHEJANE_LOCAL_FALLBACK_MODELS is ignored; if model fallback is "
            "introduced, it must live in the Go model gateway so provider keys "
            "and credit accounting stay in the cloud control plane"
        )
    middleware.extend(
        [
            ModelCallLimitMiddleware(run_limit=settings.max_model_calls),
            ContextEditingMiddleware(),
            OutputGuardMiddleware(),  # P9
            VerificationLoopMiddleware(max_attempts=settings.verification_repair_max),
            ProgressLedgerGuardMiddleware(max_attempts=1),
            ReflectMiddleware(enabled=settings.enable_critic_reflection),  # P4
            MemoryWritebackMiddleware(
                enabled=memory_enabled,
                namespace=memory_namespace or memory_namespace_for_workspace(None),
            ),  # P6
        ]
    )
    return middleware


def _should_retry_model_exception(exc: Exception) -> bool:
    if isinstance(exc, BackendLLMError):
        return _should_retry_model_payload(exc.to_event_payload())
    if isinstance(exc, httpx.HTTPStatusError):
        return _should_retry_model_payload(
            {
                "code": str(exc.response.status_code),
                "message": str(exc),
            }
        )
    if isinstance(exc, (httpx.TimeoutException, TimeoutError)):
        return _should_retry_model_payload(
            {
                "code": "timeout",
                "message": str(exc) or type(exc).__name__,
                "retryable": True,
            }
        )
    if isinstance(exc, (httpx.TransportError, ConnectionError)):
        return _should_retry_model_payload(
            {
                "code": "network_error",
                "message": str(exc) or type(exc).__name__,
                "retryable": True,
            }
        )
    return False


def _should_retry_model_payload(payload: dict[str, Any]) -> bool:
    decision = build_retry_decision(
        "run.failed",
        payload,
        attempt=0,
        max_attempts=1,
        initial_delay=0,
        max_delay=0,
    )
    return bool(decision["should_retry"])


_VALID_PII_TYPES = {"email", "credit_card", "ip", "mac_address", "url"}


def _parse_pii_types(spec: str) -> list[str]:
    """Split + validate the PII types env. Unknown entries are dropped
    with a warning (so a typo doesn't crash boot)."""
    out: list[str] = []
    for token in spec.split(","):
        t = token.strip()
        if not t:
            continue
        if t not in _VALID_PII_TYPES:
            log.warning(
                "unknown PII type %r ignored (valid: %s)",
                t,
                sorted(_VALID_PII_TYPES),
            )
            continue
        out.append(t)
    return out


def _build_chat_model(settings: Settings, run_id: str, mode: str) -> Any:
    """The agent's chat model — the real cloud-backed one, or a deterministic
    network-free fake when settings.fake_llm is set (SSE contract test). Used
    for the main model AND the selector/critic models so a faked run makes no
    cloud calls at all."""
    if settings.fake_llm:
        from ..llm.fake import FakeBackendChatModel

        return FakeBackendChatModel()
    return BackendChatModel(
        cloud_base_url=settings.cloud_base_url,
        cloud_token=settings.cloud_token,
        run_id=run_id,
        mode=mode,
    )


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


async def build_agent(
    *,
    store: LocalStore,
    checkpointer: AsyncSqliteSaver,
    agent_store: BaseStore | None = None,
    workspace_root: str | None,
    run_id: str,
    mode: str = "fast",
    task_goal: str | None = None,
    turn_count: int | None = None,
    dropped_history_count: int = 0,
    dropped_history_summary: str | None = None,
    repair_context: dict[str, Any] | None = None,
    retry_context: dict[str, Any] | None = None,
    memory_enabled: bool = True,
    skills_enabled: bool = True,
    mcp_enabled: bool = True,
    mcp_disabled_servers: set[str] | None = None,
    code_exec_enabled: bool = False,
    settings: Settings | None = None,
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
        mode:            "fast" | "deep" — passed through to BackendChatModel.
        task_goal:       Current user goal for this run. Echoed into the
                         <task> layer of the prompt so it survives long
                         tool-call chains.
        turn_count:      How many messages we're into the conversation
                         (incl. current user message). Used for the
                         <state> layer.
        dropped_history_count:
                         How many earlier messages were truncated before
                         this run started. Surfaced to the model so it
                         knows context is incomplete instead of silently
                         losing it.
        dropped_history_summary:
                         Compact deterministic digest of truncated earlier
                         messages. This preserves some decisions and
                         constraints without making another model call.
        repair_context:  Optional run metadata for a user-confirmed repair
                         attempt. Rendered into the <state> layer so the
                         model can distinguish repair from ordinary retry.
        retry_context:   Optional run metadata for a user-confirmed retry
                         attempt. Rendered into the <state> layer so the
                         model can avoid repeating the failed path blindly.
        memory_enabled:  When False, drops `memory.search` from the tool
                         list and short-circuits the writeback middleware.
                         The user toggle in agent settings flows in here
                         via RunCoordinator._settings_overrides.
        skills_enabled:  When False, passes `skills=None` to deepagents so
                         no skill instructions get injected into the prompt
                         and the agent doesn't see them. Mirrors the
                         memory toggle pattern.
        mcp_enabled:     When False, skips MCP discovery + tool loading
                         entirely so no MCP tools land in the agent's tool
                         list. The discovered servers are still reported
                         via GET /local/v1/mcp-servers — only their
                         activation is suppressed. Same toggle pattern as
                         memory + skills.
        mcp_disabled_servers:
                         Per-server opt-out. Names in this set are
                         filtered before MultiServerMCPClient even sees
                         the config, so we never spawn the subprocess.
                         Driven by the per-row switches in the client's
                         MCP tab; layered ON TOP of mcp_enabled — if the
                         master flag is off, this set is moot.
        settings:        Override settings (tests).
        steering_emit:   Optional async event sink used by SteeringMiddleware
                         to mirror injected instructions onto the run SSE
                         stream after it drains the SQLite queue.
        extra_middleware: Appended after the built-in custom stack.
    """
    settings = settings or get_settings()

    tools = await build_tools(
        store=store,
        run_id=run_id,
        workspace_root=workspace_root,
        include_mcp=mcp_enabled,
        mcp_disabled_servers=mcp_disabled_servers,
        include_code_exec=code_exec_enabled,
        browser_llm=None,  # browser sub-agent LLM is Phase 8'+ work
        browser_headless=settings.browser_headless,
    )
    if not memory_enabled:
        tools = [t for t in tools if t.name != "memory.search"]

    model = _build_chat_model(settings, run_id, mode)

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
        scratch = Path.home() / ".shejane" / "workspace"
        scratch.mkdir(parents=True, exist_ok=True)
        effective_workspace = str(scratch)
    backend = _build_agent_backend(
        effective_workspace=effective_workspace,
        skills_dirs=skills_dirs,
        memory_sources=memory_arg,
    )

    memory_namespace = memory_namespace_for_workspace(workspace_root)
    middleware = _custom_middleware(
        settings,
        memory_enabled=memory_enabled,
        memory_namespace=memory_namespace,
    )
    if steering_emit is not None:
        middleware.insert(
            2,
            SteeringMiddleware(store=store, run_id=run_id, emit=steering_emit),
        )

    # LLM-driven tool preselection — sits in the custom middleware band
    # so the narrowed toolset is what the main LLM sees. Always-include
    # keeps the agent's core capabilities (planning, memory, subagent
    # dispatch) accessible regardless of selection. Selector reuses
    # BackendChatModel in "fast" mode so its cost flows through our
    # cloud accounting.
    if settings.tool_selector_max_tools > 0:
        selector_model = _build_chat_model(settings, run_id, "fast")
        always_include = (
            ALWAYS_INCLUDE_TOOLS
            if memory_enabled
            else [name for name in ALWAYS_INCLUDE_TOOLS if name != "memory.search"]
        )
        middleware.append(
            LLMToolSelectorMiddleware(
                model=selector_model,
                max_tools=settings.tool_selector_max_tools,
                always_include=always_include,
            )
        )

    # Mid-loop tool-result critic. Watches "lossy" tools (web.fetch,
    # web.search, task, browser.task, execute, read_file, edit_file)
    # and asks a cheap LLM whether each result is usable for the task.
    # Annotates or replaces ToolMessages based on mode.
    if settings.tool_critic_mode.lower() in {"watch", "nudge", "block"}:
        from ..middleware.tool_critic import ToolResultCriticMiddleware

        critic_model = _build_chat_model(settings, run_id, "fast")
        middleware.append(
            ToolResultCriticMiddleware(
                critic_model=critic_model,
                mode=settings.tool_critic_mode,
            )
        )

    if extra_middleware:
        middleware.extend(extra_middleware)

    subagents_arg = (
        build_subagents(main_tools=tools, main_model=model) if settings.enable_subagents else None
    )

    # Layer 30-55 of the prompt stack — developer instructions, task,
    # skills hint, run state, runtime context. See context_builder.py for
    # the full stack layout. Cloud-injected Layer 0+10 (identity, safety)
    # gets prepended in api/internal/httpapi/agent_stream.go via
    # InjectScenePrompt("agent_local", ...).
    instructions = build_default_context(
        RuntimeContext(
            workspace_root=workspace_root,
            enabled_skills=_active_skill_names(skills_arg),
            task_goal=task_goal,
            mode=mode,
            turn_count=turn_count,
            dropped_history_count=dropped_history_count,
            dropped_history_summary=dropped_history_summary,
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
    )

    return create_deep_agent(
        model=model,
        tools=tools,
        middleware=middleware,
        system_prompt=instructions,
        subagents=subagents_arg,
        skills=skills_arg,
        memory=memory_arg,
        backend=backend,
        interrupt_on=DESTRUCTIVE_TOOLS,
        checkpointer=checkpointer,
        store=agent_store,
    )


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
    items = [p.strip() for p in spec.split(",") if p.strip()]
    # Expand `~` for user convenience but don't validate existence — the
    # middleware itself logs nicely if a path is missing.
    expanded = [str(Path(p).expanduser()) for p in items]
    return expanded or None
