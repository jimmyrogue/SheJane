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
  AnthropicPromptCachingMiddleware← Claude cache_control
  MemoryMiddleware                ← AGENTS.md loader
  HumanInTheLoopMiddleware        ← when `interrupt_on=` passed
"""

from __future__ import annotations

import logging
import os
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend
from langchain.agents.middleware import (
    AgentMiddleware,
    ContextEditingMiddleware,
    ModelCallLimitMiddleware,
    ModelRetryMiddleware,
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
)
from ..store.sqlite import LocalStore
from ..tools.registry import build_tools
from .subagents import build_subagents

log = logging.getLogger("local_host.agent.builder")


# Tools the user MUST approve before they run. Forwarded to
# `create_deep_agent(interrupt_on=...)` — deepagents wires its bundled
# HumanInTheLoopMiddleware accordingly. Tool names mix deepagents-provided
# (`write_file`, `execute`, `edit_file`) and our custom (`open.url`, etc.).
DESTRUCTIVE_TOOLS: dict[str, bool] = {
    "write_file": True,
    "edit_file": True,
    "execute": True,        # deepagents shell-equivalent
    "open.url": True,
    "open.file": True,
    "clipboard.write": True,
    "browser.task": True,   # agentic browser can do anything
    "image.generate": True, # paid + side-effecting
    "image.edit": True,
}


def _resolve_skills_dir() -> Path | None:
    """Return the skills directory if configured + exists, else None.

    Read order:
      1. `JIANDANLY_LOCAL_SKILLS_PATH` env var
      2. `~/.jiandanly/skills/` default
    """
    custom = os.environ.get("JIANDANLY_LOCAL_SKILLS_PATH")
    candidate = Path(custom) if custom else Path.home() / ".jiandanly" / "skills"
    candidate = candidate.expanduser()
    return candidate if candidate.is_dir() else None


async def open_checkpointer(settings: Settings | None = None) -> tuple[AsyncSqliteSaver, AsyncExitStack]:
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


def _custom_middleware(settings: Settings) -> list[AgentMiddleware]:
    """Our middleware that deepagents doesn't auto-add.

    Order:
      InputGuard → FastDeepRouter → ToolCallLimit → ToolRetry →
      ModelRetry → ModelCallLimit → ContextEditing →
      OutputGuard → Reflect → MemoryWriteback

    `before_*` fire top-to-bottom, `after_*` fire bottom-to-top —
    so OutputGuard runs first after each LLM call, then Reflect, then
    MemoryWriteback.
    """
    return [
        InputGuardMiddleware(),                             # P1
        FastDeepRouterMiddleware(),                         # P2
        ToolCallLimitMiddleware(                            # P8
            tool_name="tavily_search",
            run_limit=settings.research_search_limit,
        ),
        ToolRetryMiddleware(max_retries=settings.max_tool_retries),
        ModelRetryMiddleware(max_retries=settings.max_tool_retries),
        ModelCallLimitMiddleware(run_limit=settings.max_model_calls),
        ContextEditingMiddleware(),
        OutputGuardMiddleware(),                            # P9
        ReflectMiddleware(),                                # P4
        MemoryWritebackMiddleware(),                        # P6
    ]


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
        settings:        Override settings (tests).
        extra_middleware: Appended after the built-in custom stack.
    """
    settings = settings or get_settings()

    tools = await build_tools(
        store=store,
        workspace_root=workspace_root,
        include_mcp=True,
        browser_llm=None,  # browser sub-agent LLM is Phase 8'+ work
    )

    model = BackendChatModel(
        cloud_base_url=settings.cloud_base_url,
        cloud_token=settings.cloud_token,
        run_id=run_id,
        mode=mode,
    )

    # FilesystemBackend serves three deepagents subsystems at once:
    #   - FilesystemMiddleware tools (ls / read_file / write_file / edit_file)
    #   - `execute` shell tool (run commands inside the sandbox)
    #   - SubAgentMiddleware (subagents share this scratch area)
    if workspace_root:
        backend = FilesystemBackend(root_dir=workspace_root, max_file_size_mb=10)
    else:
        backend = FilesystemBackend(virtual_mode=True, max_file_size_mb=10)

    middleware = _custom_middleware(settings)
    if extra_middleware:
        middleware.extend(extra_middleware)

    skills_dir = _resolve_skills_dir()
    skills_arg = [str(skills_dir)] if skills_dir is not None else None

    subagents_arg = (
        build_subagents(main_tools=tools, main_model=model)
        if settings.enable_subagents
        else None
    )

    return create_deep_agent(
        model=model,
        tools=tools,
        middleware=middleware,
        subagents=subagents_arg,
        skills=skills_arg,
        backend=backend,
        interrupt_on=DESTRUCTIVE_TOOLS,
        checkpointer=checkpointer,
    )
