"""browser tool — agentic browser via `browser-use`.

Why one tool instead of 10:
-------------------------
The Node daemon ships ten granular browser primitives (open / search /
snapshot / read / verify / screenshot / click / type / scroll / close).
We're replacing all of them with a single `browser.task` tool that drives a
full `browser-use` agent given a high-level instruction. The sub-agent
itself handles snapshot/click/type/scroll internally, vision-aware, with
its own retry and replan loops.

Where the LLM comes from:
------------------------
`browser-use` needs its own `BaseChatModel` instance — it's not directly
compatible with `langchain_core.language_models.BaseChatModel`. Phase 2'
exposes the factory below; the actual LLM binding lands in Phase 3' inside
`local_host.agent.builder`, where the agent's primary chat model and the
browser sub-agent's model are both constructed from the same backend
session config.

Until then the tool returns a "configure-me" envelope so the host agent
can still discover the capability without crashing.
"""

from __future__ import annotations

import logging
from typing import Any

from langchain_core.tools import BaseTool, tool

log = logging.getLogger("local_host.tools.browser")


def _browser_use_available() -> bool:
    try:
        import browser_use  # noqa: F401
    except ImportError:
        return False
    return True


def make_browser_tool(llm: Any = None, *, headless: bool = True) -> BaseTool:
    """Build the agentic `browser.task` tool.

    Args:
        llm: A `browser_use.llm.base.BaseChatModel` instance. If None, the
             returned tool short-circuits with an "unavailable" envelope.
        headless: Run Chromium headless (default True; toggle for local
                  debugging).
    """

    if not _browser_use_available():
        @tool("browser.task")
        async def _stub(task: str) -> dict[str, str]:
            """Drive a headless browser to complete a high-level task."""
            return {
                "ok": "false",
                "error": "browser-use not installed",
            }

        return _stub

    if llm is None:
        @tool("browser.task")
        async def _no_llm(task: str) -> dict[str, str]:
            """Drive a headless browser to complete a high-level task."""
            return {
                "ok": "false",
                "error": "browser sub-agent LLM not configured (Phase 3')",
            }

        return _no_llm

    from browser_use import Agent

    @tool("browser.task")
    async def browser_task(task: str, max_steps: int = 25) -> dict[str, Any]:
        """Drive a headless browser to complete a high-level task.

        The instruction goes to a browser sub-agent (browser-use) that
        plans its own click / type / scroll / screenshot actions and
        returns the final outcome.

        Args:
            task: Natural-language description of what to do in the browser.
            max_steps: Hard cap on the sub-agent's iteration count.
        """
        agent = Agent(
            task=task,
            llm=llm,
            use_vision=True,
            max_actions_per_step=5,
        )
        try:
            history = await agent.run(max_steps=max_steps)
        except Exception as exc:  # noqa: BLE001
            return {"ok": "false", "error": f"{type(exc).__name__}: {exc}"}

        # Surface a compact summary; full history stays in browser-use's
        # own logging.
        return {
            "ok": "true",
            "final": str(history.final_result() if hasattr(history, "final_result") else history),
            "steps": getattr(history, "n_steps", 0),
        }

    return browser_task
