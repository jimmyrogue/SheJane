"""P7 skill injection — pull markdown skills into the system prompt.

A "skill" here is the same .md file shape served by `skill.use` (see
`local_host.tools.skills`). The agent can either:
  * explicitly call `skill.use(name)` to load one mid-run, OR
  * have the daemon pre-inject the most-relevant skills into the system
    prompt via this middleware.

For Phase 3' we ship the static path: if a `skills` field is present on
state (set by the HTTP layer / agent caller), pre-pend their content as a
SystemMessage at the start of the conversation. No relevance scoring yet.
"""

from __future__ import annotations

import logging
from typing import Any

from langchain.agents.middleware import AgentMiddleware

from ..tools.skills import _default_skills_dir, _parse_frontmatter

log = logging.getLogger("local_host.middleware.skills")


class SkillInjectionMiddleware(AgentMiddleware):
    def before_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:  # noqa: ARG002
        requested = state.get("skills") or []
        if not requested:
            return None
        skills_dir = _default_skills_dir()
        blocks: list[str] = []
        for name in requested:
            path = skills_dir / f"{name}.md"
            if not path.exists():
                log.warning("requested skill not found: %s", name)
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except OSError as exc:
                log.warning("read failed for %s: %s", path, exc)
                continue
            meta, body = _parse_frontmatter(text)
            title = meta.get("title", name)
            blocks.append(f"## Skill: {title}\n\n{body.strip()}")

        if not blocks:
            return None

        from langchain_core.messages import SystemMessage

        intro = "Inline skills loaded for this run:\n\n"
        system = SystemMessage(content=intro + "\n\n---\n\n".join(blocks))
        existing = list(state.get("messages") or [])
        # Insert before any existing messages so it acts as preamble.
        return {"messages": [system, *existing]}
