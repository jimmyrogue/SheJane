"""Subagent definitions for SubAgentMiddleware (deepagents).

Each subagent here is a `SubAgent` TypedDict that gets compiled by
SubAgentMiddleware into an isolated `create_agent` instance. The main
agent invokes them via the `task` tool the middleware injects, e.g.:

    task(subagent_name="researcher", task_description="Find the latest …")

Why this layout
---------------
- Specialists keep their own context window (parent's transcript stays clean)
- Each subagent has a narrower tool surface, so its planner is more focused
- The `task` tool's return value is a single structured summary, so the
  parent agent can synthesize results without re-reasoning about the
  steps the subagent took.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from deepagents.backends import FilesystemBackend
from deepagents.middleware.subagents import SubAgent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.tools import BaseTool

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
) -> list[SubAgent]:
    """Assemble the starter subagent roster.

    Args:
        main_tools: the parent agent's full tool list — researcher reuses
                    the web / browser / verify subset from here.
        main_model: model name or instance to share across subagents.
                    Keeping the same model means subagent LLM calls flow
                    through the same backend gateway as the parent (so
                    credits/throttling stay coherent).
    """
    research_tool_names = {
        "web.fetch",
        "tavily_search",
        "browser.task",
        "task.verify",
        "time.now",
        "fs.read",
        "read_file",
    }
    research_tools = [t for t in main_tools if t.name in research_tool_names]

    subagents: list[SubAgent] = [
        {
            "name": "researcher",
            "description": (
                "Run deep research on a single, well-scoped question. "
                "Returns a short written summary with citations. Use when "
                "the answer needs fresh sources and your own context is "
                "getting noisy."
            ),
            "system_prompt": RESEARCHER_PROMPT,
            "model": main_model,
            "tools": research_tools,
        },
        {
            "name": "writer",
            "description": (
                "Shape provided material into a clean piece of writing "
                "(article / email / spec / etc.). No tools. Use when you "
                "have the facts and just need a careful final draft."
            ),
            "system_prompt": WRITER_PROMPT,
            "model": main_model,
            "tools": [],
        },
    ]
    return subagents


def build_subagent_backend(workspace_root: str | None) -> FilesystemBackend:
    """Build the shared filesystem backend for subagents.

    Subagents need a shared scratch area for any files they write
    (research notes, intermediate artifacts, etc.). We point the backend
    at the run's authorized workspace when present, falling back to the
    daemon data dir.
    """
    if workspace_root:
        return FilesystemBackend(root_dir=workspace_root, max_file_size_mb=10)
    # No authorized workspace — subagents get a virtual in-memory FS so
    # they can't accidentally touch real disk paths.
    return FilesystemBackend(virtual_mode=True, max_file_size_mb=10)
