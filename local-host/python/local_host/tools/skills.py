"""skill.use — load a markdown skill from disk.

A "skill" is a self-contained instruction file (usually .md with YAML
frontmatter) that the agent can pull into its context on demand. This tool
returns the raw content + parsed frontmatter; how the agent consumes it is
up to the prompt layer.

Skills directory comes from `JIANDANLY_LOCAL_SKILLS_PATH` env var (default
~/.jiandanly/skills/).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from langchain_core.tools import tool


def _default_skills_dir() -> Path:
    custom = os.environ.get("JIANDANLY_LOCAL_SKILLS_PATH")
    if custom:
        return Path(os.path.expanduser(custom))
    return Path.home() / ".jiandanly" / "skills"


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Tiny frontmatter parser — supports a YAML-like prefix bounded by '---'.

    No full YAML support; we only need flat `key: value` lines and bullet
    arrays. Anything fancier we'd pull in `pyyaml`, but keeping the dep tree
    smaller here.
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    meta: dict[str, str] = {}
    end = 1
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i + 1
            break
        if ":" in lines[i]:
            key, _, value = lines[i].partition(":")
            meta[key.strip()] = value.strip()
    body = "\n".join(lines[end:]).lstrip("\n")
    return meta, body


def _list_skills(skills_dir: Path) -> list[dict[str, str]]:
    if not skills_dir.exists():
        return []
    out: list[dict[str, str]] = []
    for md in sorted(skills_dir.glob("*.md")):
        try:
            text = md.read_text(encoding="utf-8")
        except OSError:
            continue
        meta, _ = _parse_frontmatter(text)
        out.append(
            {
                "name": md.stem,
                "title": meta.get("title", md.stem),
                "description": meta.get("description", ""),
                "path": str(md),
            }
        )
    return out


@tool("skill.use")
def skill_use(name: str) -> dict[str, Any]:
    """Load a skill instruction by name.

    Args:
        name: Skill name (filename without `.md`). Listing available skills
              is done via the daemon's `/v1/skills` endpoint.

    Returns:
        {ok, name, title, description, content} on success, or
        {ok: "false", error, available} on failure (with `available` listing
        what *can* be loaded).
    """
    skills_dir = _default_skills_dir()
    target = skills_dir / f"{name}.md"
    if not target.exists():
        return {
            "ok": "false",
            "error": f"skill not found: {name}",
            "available": [s["name"] for s in _list_skills(skills_dir)],
        }
    try:
        text = target.read_text(encoding="utf-8")
    except OSError as exc:
        return {"ok": "false", "error": f"read failed: {exc}"}
    meta, body = _parse_frontmatter(text)
    return {
        "ok": "true",
        "name": name,
        "title": meta.get("title", name),
        "description": meta.get("description", ""),
        "content": body,
    }


def list_skills() -> list[dict[str, str]]:
    """Expose the skill catalog to the daemon HTTP layer."""
    return _list_skills(_default_skills_dir())


SKILL_TOOLS = [skill_use]
