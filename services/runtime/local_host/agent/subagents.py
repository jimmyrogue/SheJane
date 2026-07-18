"""Subagent definitions for SubAgentMiddleware (deepagents).

Each subagent here is a `SubAgent` TypedDict that gets compiled by
SubAgentMiddleware into an isolated `create_agent` instance. The main
agent invokes them via the `task` tool the middleware injects, e.g.:

    task(subagent_type="researcher", description="Find the latest …")

(The deepagents tool signature is `task(description=..., subagent_type=...)`
— NOT `subagent_name` / `task_description` as earlier versions of this
docstring incorrectly suggested.)

Why this layout
---------------
- Specialists keep their own context window (parent's transcript stays clean)
- Each subagent has a narrower tool surface, so its planner is more focused
- The `task` tool's return value is a single structured summary, so the
  parent agent can synthesize results without re-reasoning about the
  steps the subagent took.
"""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Sequence
from pathlib import Path

import yaml
from deepagents.backends import FilesystemBackend
from deepagents.middleware.subagents import (
    DEFAULT_GENERAL_PURPOSE_DESCRIPTION,
    DEFAULT_SUBAGENT_PROMPT,
    SubAgent,
)
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.tools import BaseTool

from ..middleware.file_write_conflict import FileWriteConflictMiddleware
from ..middleware.tool_execution import ToolExecutionMiddleware
from ..middleware.tool_review import ToolReviewMiddleware
from ..middleware.tool_visibility import ToolVisibilityMiddleware
from ..tools.mcp import MCP_TOOL_SEARCH_NAME
from .backends import RuntimeFilesystemBackend
from .context_builder import identity_safety_prompt

log = logging.getLogger("local_host.agent.subagents")

SUBAGENT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def _fenced_prompt(prompt: str) -> str:
    return f"{identity_safety_prompt()}\n\n{prompt.strip()}"


# ---- subagent system prompts -----------------------------------------------

RESEARCHER_PROMPT = """You are a focused research subagent.

Goal: given a research question, return a concise written summary based on
real sources. Prefer primary sources; cite URLs. Stop as soon as you have
enough material for a 2–4 paragraph answer.

Style:
- Lead with the answer in 1–2 sentences.
- Follow with the key facts and their sources.
- End with explicit caveats (uncertainty, recency, contested claims).

Constraints:
- You have no memory between tasks. Treat each invocation as a fresh slate.
- Don't fabricate citations. If a search returns nothing, say so plainly.
- Hard cap: 5 tool calls. If you can't answer in 5, return what you have.
"""

WRITER_PROMPT = """You are a focused writing subagent.

Goal: take the materials provided in the task description and produce a
clear, structured piece of writing. You have no tools — your only job is
to shape language.

Style:
- Match the requested format (article / email / spec / etc.) exactly.
- Use plain language; avoid filler.
- If the requested format is unclear, ask back via a brief structured note.
"""


def build_subagents(
    *,
    main_tools: list[BaseTool],
    main_model: str | BaseChatModel,
    agent_roots: Sequence[Path] | None = None,
    deferred_tool_names: set[str] | None = None,
) -> list[SubAgent]:
    """Assemble the built-in + configured subagent roster.

    Args:
        main_tools: the parent agent's full tool list — researcher reuses
                    the web / browser / verify subset from here.
        main_model: model name or instance to share across subagents.
                    Keeping the same model means subagent LLM calls flow
                    through the same Runtime model binding as the parent,
                    so provider throttling and usage accounting stay coherent.
        agent_roots: optional roots to scan for `*.md` subagent definitions.
                     `None` uses the runtime resolver; tests pass `[]` to
                     exercise only the built-ins.
    """
    # Durable memory is a top-level user capability. A configured or generic
    # subagent receives a model-authored task description, never the original
    # authenticated user instruction, so it must not be able to write memory.
    subagent_tools = [tool for tool in main_tools if tool.name != "memory.write"]
    subagents = _builtin_subagents(main_tools=subagent_tools, main_model=main_model)
    configured = _load_configured_subagents(
        main_tools=subagent_tools,
        main_model=main_model,
        agent_roots=_resolve_agent_roots() if agent_roots is None else list(agent_roots),
    )

    # Later definitions override earlier ones by name. This lets
    # `~/.shejane/agents/writer.md` replace the generic built-in writer
    # without producing two visually-identical choices for the model.
    by_name: dict[str, SubAgent] = {}
    for subagent in [*subagents, *configured]:
        by_name[subagent["name"]] = subagent
    if deferred_tool_names:
        for subagent in by_name.values():
            tool_names = {tool.name for tool in subagent.get("tools", [])}
            if MCP_TOOL_SEARCH_NAME in tool_names:
                subagent["middleware"] = [
                    ToolVisibilityMiddleware(
                        deferred_tool_names=deferred_tool_names & tool_names,
                    ),
                    *subagent.get("middleware", []),
                ]
    return list(by_name.values())


def _builtin_subagents(
    *,
    main_tools: list[BaseTool],
    main_model: str | BaseChatModel,
) -> list[SubAgent]:
    research_tool_names = {
        "web.fetch",
        "browser.task",
        "task.verify",
        "time.now",
        "fs.read",
        "read_file",
    }
    research_tools = [t for t in main_tools if t.name in research_tool_names]

    subagents: list[SubAgent] = [
        {
            # Deep Agents currently injects an automatic general-purpose
            # subagent that does not inherit Runtime middleware. Defining the
            # same name later makes its task registry select this fenced
            # version, so internal tools receive review + durable receipts.
            "name": "general-purpose",
            "description": DEFAULT_GENERAL_PURPOSE_DESCRIPTION,
            "system_prompt": _fenced_prompt(DEFAULT_SUBAGENT_PROMPT),
            "model": main_model,
            "tools": main_tools,
            "middleware": [
                ToolReviewMiddleware(),
                ToolExecutionMiddleware(),
                FileWriteConflictMiddleware(),
            ],
        },
        {
            "name": "researcher",
            "description": (
                "USE THIS FOR ANY INDEPENDENT RESEARCH QUESTION. Prefer "
                "this when you have at least two independent research "
                "questions that can be answered separately — emit multiple "
                "`task` calls in one message to run them in parallel. Each "
                "subagent has its own context window so raw search dumps "
                "stay out of the main agent's context. Returns a 2-4 "
                "paragraph synthesized summary with citations. Also use "
                "this for a single research question that would otherwise "
                "require many search/fetch calls (isolate the noise)."
            ),
            "system_prompt": _fenced_prompt(RESEARCHER_PROMPT),
            "model": main_model,
            "tools": research_tools,
            "middleware": [
                ToolReviewMiddleware(),
                ToolExecutionMiddleware(),
                FileWriteConflictMiddleware(),
            ],
        },
        {
            "name": "writer",
            "description": (
                "Shape provided material into a clean piece of writing "
                "(article / email / spec / etc.). No tools. Use when you "
                "have the facts and just need a careful final draft."
            ),
            "system_prompt": _fenced_prompt(WRITER_PROMPT),
            "model": main_model,
            "tools": [],
            "middleware": [
                ToolReviewMiddleware(),
                ToolExecutionMiddleware(),
                FileWriteConflictMiddleware(),
            ],
        },
    ]
    return subagents


def _resolve_agent_roots() -> list[Path]:
    """Return existing directories that may contain Markdown subagents.

    `SHEJANE_LOCAL_AGENTS_PATH` is a full override, matching the skills
    resolver. When unset, SheJane scans its canonical user-owned root:
    `~/.shejane/agents/*.md`.
    """
    custom = os.environ.get("SHEJANE_LOCAL_AGENTS_PATH", "").strip()
    raw_paths = (
        [p.strip() for p in custom.split(",") if p.strip()]
        if custom
        else [str(Path.home() / ".shejane" / "agents")]
    )
    roots: list[Path] = []
    for raw in raw_paths:
        candidate = Path(raw).expanduser()
        if candidate.is_dir():
            roots.append(candidate)
    return roots


def _load_configured_subagents(
    *,
    main_tools: list[BaseTool],
    main_model: str | BaseChatModel,
    agent_roots: Sequence[Path],
) -> list[SubAgent]:
    out: list[SubAgent] = []
    for root in agent_roots:
        for path in sorted(root.glob("*.md"), key=lambda p: p.name.lower()):
            subagent = _load_subagent_file(path, main_tools=main_tools, main_model=main_model)
            if subagent is not None:
                out.append(subagent)
    return out


def _load_subagent_file(
    path: Path,
    *,
    main_tools: list[BaseTool],
    main_model: str | BaseChatModel,
) -> SubAgent | None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        log.warning("failed to read configured subagent %s: %s", path, exc)
        return None

    metadata, prompt = _split_frontmatter(text)
    if not metadata or not prompt.strip():
        return None

    name = _clean_scalar(metadata.get("name"))
    description = _clean_scalar(metadata.get("description"))
    if not name or not description or not SUBAGENT_NAME_RE.fullmatch(name):
        return None

    allowed_tools = _normalize_tool_names(metadata.get("tools"))
    selected_tools = _filter_tools(main_tools, allowed_tools)
    return {
        "name": name,
        "description": description,
        "system_prompt": _fenced_prompt(prompt),
        "model": main_model,
        "tools": selected_tools,
        "middleware": [
            ToolReviewMiddleware(),
            ToolExecutionMiddleware(),
            FileWriteConflictMiddleware(),
        ],
    }


def _split_frontmatter(text: str) -> tuple[dict[str, object], str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            raw_frontmatter = "\n".join(lines[1:index])
            prompt = "\n".join(lines[index + 1 :])
            try:
                parsed = yaml.safe_load(raw_frontmatter) or {}
            except yaml.YAMLError as exc:
                log.warning("invalid subagent frontmatter: %s", exc)
                return {}, prompt
            if isinstance(parsed, dict):
                return parsed, prompt
            return {}, prompt
    return {}, text


def _clean_scalar(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _normalize_tool_names(value: object) -> set[str]:
    if value is None or value == "":
        return set()
    if isinstance(value, str):
        raw_names = value.split(",")
    elif isinstance(value, list):
        raw_names = value
    else:
        return set()
    return {str(name).strip() for name in raw_names if str(name).strip()}


def _filter_tools(main_tools: list[BaseTool], allowed_tool_names: set[str]) -> list[BaseTool]:
    if not allowed_tool_names:
        return []
    return [tool for tool in main_tools if tool.name in allowed_tool_names]


def build_subagent_backend(workspace_root: str | None) -> FilesystemBackend:
    """Build the shared filesystem backend for subagents.

    Subagents need a shared scratch area for any files they write
    (research notes, intermediate artifacts, etc.). We point the backend
    at the run's authorized workspace when present, falling back to the
    daemon data dir.
    """
    if workspace_root:
        return RuntimeFilesystemBackend(
            root_dir=workspace_root,
            virtual_mode=True,
            max_file_size_mb=10,
        )
    # No authorized workspace — subagents get a virtual in-memory FS so
    # they can't accidentally touch real disk paths.
    return RuntimeFilesystemBackend(virtual_mode=True, max_file_size_mb=10)
