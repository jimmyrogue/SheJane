"""Assemble the LangGraph agent from `create_agent` + middleware list.

Per-run rebuild
---------------
We rebuild the agent for each run because two middleware
(`ShellToolMiddleware`, `FilesystemFileSearchMiddleware`) bind to a specific
workspace root that can differ between runs. The checkpointer is shared
across all runs (one `AsyncSqliteSaver` per daemon, keyed by `thread_id`).

Middleware stack (Phase 3' part 2 — built-ins only)
---------------------------------------------------
Order matters — `before_*` hooks fire in this order, `after_*` in reverse:

  1. TodoListMiddleware                # P3 — planning
  2. ToolCallLimitMiddleware           # P8 — research convergence
  3. HumanInTheLoopMiddleware          # P10 — permission gate
  4. ToolRetryMiddleware               # P12 — transient retry
  5. ModelCallLimitMiddleware          # P12 — step cap
  6. ShellToolMiddleware               # adds `shell` tool, workspace-scoped
  7. FilesystemFileSearchMiddleware    # adds Glob + Grep
  8. ContextEditingMiddleware          # auto-prune old tool outputs

Phase 3' part 3 will insert our 6 custom middleware
(input_guard / fast_deep_router / skill_injection / output_guard / reflect
/ memory_writeback) at the appropriate positions in this stack.
"""

from __future__ import annotations

import logging
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

from deepagents.middleware import SubAgentMiddleware
from langchain.agents import create_agent
from langchain.agents.middleware import (
    AgentMiddleware,
    ContextEditingMiddleware,
    FilesystemFileSearchMiddleware,
    HumanInTheLoopMiddleware,
    ModelCallLimitMiddleware,
    ShellToolMiddleware,
    TodoListMiddleware,
    ToolCallLimitMiddleware,
    ToolRetryMiddleware,
)
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from ..config import Settings, get_settings
from ..llm.backend import BackendChatModel
from ..middleware import (
    FastDeepRouterMiddleware,
    InputGuardMiddleware,
    MemoryWritebackMiddleware,
    OutputGuardMiddleware,
    ReflectMiddleware,
    SkillInjectionMiddleware,
)
from ..store.sqlite import LocalStore
from ..tools.registry import build_tools
from .subagents import build_subagent_backend, build_subagents

log = logging.getLogger("local_host.agent.builder")

# Tools the user MUST approve before they run. Mirrors HumanInTheLoop's
# `interrupt_on` shape: True = always interrupt; the dict form allows
# fine-grained allow/deny criteria later.
DESTRUCTIVE_TOOLS: dict[str, bool] = {
    "fs.write": True,        # legacy alias, only fires if we re-add it
    "write_file": True,      # FileManagementToolkit
    "shell": True,           # ShellToolMiddleware-provided tool
    "open.url": True,
    "open.file": True,
    "clipboard.write": True,
    "browser.task": True,    # agentic browser can do anything
    "image.generate": True,  # paid + side-effecting
    "image.edit": True,
}


async def open_checkpointer(settings: Settings | None = None) -> tuple[AsyncSqliteSaver, AsyncExitStack]:
    """Open a long-lived AsyncSqliteSaver.

    Returns `(checkpointer, stack)`. The caller is responsible for keeping
    `stack` alive (or calling `await stack.aclose()` at shutdown).

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


def _built_in_middleware(
    settings: Settings,
    workspace_root: str | None,
) -> list[AgentMiddleware]:
    middleware: list[AgentMiddleware] = [
        TodoListMiddleware(),
        ToolCallLimitMiddleware(
            tool_name="tavily_search",
            run_limit=settings.research_search_limit,
        ),
        HumanInTheLoopMiddleware(interrupt_on=DESTRUCTIVE_TOOLS),
        ToolRetryMiddleware(max_retries=settings.max_tool_retries),
        ModelCallLimitMiddleware(run_limit=settings.max_model_calls),
        ContextEditingMiddleware(),
    ]
    if workspace_root:
        middleware.insert(
            -1,  # before ContextEditingMiddleware so shell calls flow through
            ShellToolMiddleware(workspace_root=workspace_root),
        )
        middleware.insert(
            -1,
            FilesystemFileSearchMiddleware(root_path=workspace_root),
        )
    return middleware


async def build_agent(
    *,
    store: LocalStore,
    checkpointer: AsyncSqliteSaver,
    workspace_root: str | None,
    run_id: str,
    mode: str = "fast",
    settings: Settings | None = None,
    extra_middleware: list[AgentMiddleware] | None = None,
) -> Any:
    """Build a compiled agent for one run.

    Args:
        store: Daemon-level SQLite store (for workspace lookups, etc.).
        checkpointer: Shared AsyncSqliteSaver from `open_checkpointer`.
        workspace_root: Authorized filesystem root for this run. Required
                        for shell + filesystem search; without it those
                        middleware are skipped.
        run_id: LangGraph `thread_id` — must be unique per logical run.
        mode: "fast" | "deep" — passed through to BackendChatModel.
        settings: Override settings (tests).
        extra_middleware: Inserted before the built-in stack so custom
                          phase hooks fire first.
    """
    settings = settings or get_settings()

    tools = await build_tools(
        store=store,
        workspace_root=workspace_root,
        include_mcp=True,
        browser_llm=None,  # Phase 3' part 2: browser sub-agent LLM stays None
    )

    model = BackendChatModel(
        cloud_base_url=settings.cloud_base_url,
        cloud_token=settings.cloud_token,
        run_id=run_id,
        mode=mode,
    )

    middleware: list[AgentMiddleware] = []

    # Custom middleware first — input guard + skill injection should land
    # before any model call so the system prompt + guard state are visible
    # to the built-ins.
    middleware.extend(
        [
            InputGuardMiddleware(),            # P1
            SkillInjectionMiddleware(),        # P7
            FastDeepRouterMiddleware(),        # P2
        ]
    )

    middleware.extend(_built_in_middleware(settings, workspace_root))

    # Subagents (Phase 6'+) — adds a `task` tool the main agent can call
    # to delegate to specialist subagents (researcher / writer / …). Each
    # subagent runs in an isolated context window with a narrower toolset.
    if settings.enable_subagents:
        backend = build_subagent_backend(workspace_root)
        subagents = build_subagents(main_tools=tools, main_model=model)
        middleware.append(SubAgentMiddleware(backend=backend, subagents=subagents))

    # Post-model and post-agent custom middleware go last so they observe
    # the full message tail after built-ins have already run.
    middleware.extend(
        [
            OutputGuardMiddleware(),           # P9
            ReflectMiddleware(),               # P4
            MemoryWritebackMiddleware(),       # P6
        ]
    )

    if extra_middleware:
        middleware.extend(extra_middleware)

    return create_agent(
        model=model,
        tools=tools,
        middleware=middleware,
        checkpointer=checkpointer,
    )
