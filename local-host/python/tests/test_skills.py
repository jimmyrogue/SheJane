"""Tests for the multi-root skill scanner.

Covers `_resolve_skills_dirs` + `_list_skill_files` + the
`skills_enabled` gate threaded through `build_agent` to `create_deep_agent`.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi.testclient import TestClient
from langgraph.store.memory import InMemoryStore

from local_host.config import reset_settings_for_tests
from local_host.server import create_app


def _write_skill(root: Path, name: str, *, title: str = "", description: str = "") -> Path:
    """Helper: create `<root>/<name>/SKILL.md` with optional frontmatter."""
    skill_dir = root / name
    skill_dir.mkdir(parents=True)
    body_lines = []
    if title or description:
        body_lines.append("---")
        if title:
            body_lines.append(f"title: {title}")
        if description:
            body_lines.append(f"description: {description}")
        body_lines.append("---")
        body_lines.append("")
    body_lines.append(f"# {name}")
    skill_md = skill_dir / "SKILL.md"
    skill_md.write_text("\n".join(body_lines) + "\n", encoding="utf-8")
    return skill_md


# --- _resolve_skills_dirs ----------------------------------------------------


def test_resolve_skills_dirs_returns_only_existing_paths(tmp_path: Path, monkeypatch) -> None:
    from local_host.agent.builder import _resolve_skills_dirs

    # Only the .shejane dir gets created — .claude intentionally missing
    # so we can prove the resolver silently drops non-existent paths.
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("SHEJANE_LOCAL_SKILLS_PATH", raising=False)

    # `~/.shejane/skills/` and `~/.claude/skills/` are the defaults;
    # we patch home() so they resolve under tmp_path. Only the existing
    # one (.shejane/) should come back.
    shejane_skills = tmp_path / ".shejane" / "skills"
    shejane_skills.mkdir(parents=True)

    dirs = _resolve_skills_dirs()
    assert shejane_skills in dirs
    assert all(d.is_dir() for d in dirs)


def test_resolve_skills_dirs_includes_both_when_both_exist(tmp_path: Path, monkeypatch) -> None:
    from local_host.agent.builder import _resolve_skills_dirs

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("SHEJANE_LOCAL_SKILLS_PATH", raising=False)

    (tmp_path / ".shejane" / "skills").mkdir(parents=True)
    (tmp_path / ".claude" / "skills").mkdir(parents=True)

    dirs = _resolve_skills_dirs()
    # Order matters for the dedupe-first-wins logic in _list_skill_files
    # — shejane must come first.
    assert [d.name for d in dirs[:2]] == ["skills", "skills"]
    assert dirs[0].parent.name == ".shejane"
    assert dirs[1].parent.name == ".claude"


def test_resolve_skills_dirs_env_override_full_takeover(tmp_path: Path, monkeypatch) -> None:
    """When `SHEJANE_LOCAL_SKILLS_PATH` is set, the home defaults are
    ignored — that's the documented contract so a power user can pin the
    list to exactly what they want."""
    from local_host.agent.builder import _resolve_skills_dirs

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    # Defaults would resolve, but they shouldn't get used.
    (tmp_path / ".shejane" / "skills").mkdir(parents=True)
    (tmp_path / ".claude" / "skills").mkdir(parents=True)

    override = tmp_path / "custom" / "skills"
    override.mkdir(parents=True)
    monkeypatch.setenv("SHEJANE_LOCAL_SKILLS_PATH", str(override))

    dirs = _resolve_skills_dirs()
    assert dirs == [override]


def test_resolve_skills_dirs_env_override_supports_comma(tmp_path: Path, monkeypatch) -> None:
    from local_host.agent.builder import _resolve_skills_dirs

    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()
    monkeypatch.setenv("SHEJANE_LOCAL_SKILLS_PATH", f"{a}, {b}")

    dirs = _resolve_skills_dirs()
    assert dirs == [a, b]


# --- _list_skill_files -------------------------------------------------------


def test_list_skill_files_walks_all_roots(tmp_path: Path, monkeypatch) -> None:
    from local_host.server import _list_skill_files

    shejane = tmp_path / ".shejane" / "skills"
    claude = tmp_path / ".claude" / "skills"
    shejane.mkdir(parents=True)
    claude.mkdir(parents=True)
    _write_skill(shejane, "shejane-only", title="Shejane Only")
    _write_skill(claude, "claude-only", title="Claude Only")

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("SHEJANE_LOCAL_SKILLS_PATH", raising=False)

    skills = _list_skill_files()
    names = {s["name"] for s in skills}
    assert {"shejane-only", "claude-only"} <= names
    by_name = {s["name"]: s for s in skills}
    # `source` derives from the parent dir, dot-stripped — so the UI
    # can distinguish shejane-rooted entries from claude-rooted ones.
    assert by_name["shejane-only"]["source"] == "shejane"
    assert by_name["claude-only"]["source"] == "claude"
    # `root_path` lets the UI open the right directory in Finder.
    assert by_name["shejane-only"]["root_path"].endswith("/.shejane/skills")
    assert by_name["claude-only"]["root_path"].endswith("/.claude/skills")


def test_list_skill_files_requires_SKILL_md(tmp_path: Path, monkeypatch) -> None:
    """A subdirectory without SKILL.md is silently ignored — that's the
    Anthropic Agent Skills convention."""
    from local_host.server import _list_skill_files

    shejane = tmp_path / ".shejane" / "skills"
    shejane.mkdir(parents=True)
    valid_skill = shejane / "valid"
    valid_skill.mkdir()
    (valid_skill / "SKILL.md").write_text("---\ntitle: Valid\n---\n# valid\n", encoding="utf-8")
    # Decoy dir without SKILL.md — should NOT appear.
    invalid = shejane / "no-skill-md"
    invalid.mkdir()
    (invalid / "README.md").write_text("not a skill", encoding="utf-8")

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("SHEJANE_LOCAL_SKILLS_PATH", raising=False)

    names = {s["name"] for s in _list_skill_files()}
    assert "valid" in names
    assert "no-skill-md" not in names


def test_list_skill_files_dedupes_across_roots(tmp_path: Path, monkeypatch) -> None:
    """When the same skill name appears in both shejane and claude
    dirs, shejane wins (first-source-wins). Without dedupe, the UI
    would show two identically-named entries and confuse the user."""
    from local_host.server import _list_skill_files

    shejane = tmp_path / ".shejane" / "skills"
    claude = tmp_path / ".claude" / "skills"
    shejane.mkdir(parents=True)
    claude.mkdir(parents=True)
    _write_skill(shejane, "shared", title="From SheJane")
    _write_skill(claude, "shared", title="From Claude")

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("SHEJANE_LOCAL_SKILLS_PATH", raising=False)

    skills = _list_skill_files()
    shared = [s for s in skills if s["name"] == "shared"]
    assert len(shared) == 1
    assert shared[0]["title"] == "From SheJane"


def test_list_skill_files_skips_underscore_and_dot_dirs(tmp_path: Path, monkeypatch) -> None:
    """Internal/private subdirs (starts with _ or .) are skipped — they
    typically hold tests, fixtures, or git internals, not real skills."""
    from local_host.server import _list_skill_files

    shejane = tmp_path / ".shejane" / "skills"
    shejane.mkdir(parents=True)
    _write_skill(shejane, "_private", title="Should hide")
    _write_skill(shejane, ".dotted", title="Should hide")
    _write_skill(shejane, "real", title="Should show")

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("SHEJANE_LOCAL_SKILLS_PATH", raising=False)

    names = {s["name"] for s in _list_skill_files()}
    assert "real" in names
    assert "_private" not in names
    assert ".dotted" not in names


def test_http_skill_crud_writes_personal_skill(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("SHEJANE_LOCAL_SKILLS_PATH", raising=False)
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp_path / "data",
    )
    app = create_app(settings)

    with TestClient(app) as client:
        created = client.post(
            "/local/v1/skills",
            headers={"Authorization": "Bearer tok"},
            json={
                "name": "daily-digest",
                "description": "整理每日摘要",
                "content": "---\ntitle: Daily Digest\ndescription: 整理每日摘要\n---\n\n# Daily\n",
            },
        )
        assert created.status_code == 200, created.text
        skill_path = tmp_path / ".shejane" / "skills" / "daily-digest" / "SKILL.md"
        assert skill_path.read_text(encoding="utf-8").startswith("---\ntitle: Daily Digest")

        listed = client.get("/local/v1/skills", headers={"Authorization": "Bearer tok"})
        assert listed.status_code == 200
        assert any(s["name"] == "daily-digest" for s in listed.json()["skills"])

        loaded = client.get(
            "/local/v1/skills/daily-digest",
            headers={"Authorization": "Bearer tok"},
        )
        assert loaded.status_code == 200
        assert loaded.json()["content"].startswith("---\ntitle: Daily Digest")

        updated = client.put(
            "/local/v1/skills/daily-digest",
            headers={"Authorization": "Bearer tok"},
            json={
                "description": "新版摘要",
                "content": "---\ntitle: Daily Digest\ndescription: 新版摘要\n---\n\n# Updated\n",
            },
        )
        assert updated.status_code == 200, updated.text
        assert "# Updated" in skill_path.read_text(encoding="utf-8")

        deleted = client.delete(
            "/local/v1/skills/daily-digest",
            headers={"Authorization": "Bearer tok"},
        )
        assert deleted.status_code == 200
        assert not skill_path.exists()


# --- build_agent skills_enabled gate ----------------------------------------


def test_build_agent_passes_skills_dirs_to_deepagents_when_enabled(
    tmp_path: Path, monkeypatch
) -> None:
    """When `skills_enabled=True`, every resolved skill root should be
    forwarded to deepagents' `create_deep_agent(skills=...)`.

    The workspace backend stays in virtual mode for path containment, while
    absolute skill roots are exposed through explicit virtual routes.
    """
    from deepagents.backends import CompositeBackend, FilesystemBackend

    import local_host.agent.builder as builder_mod
    from local_host.agent.builder import build_agent, open_checkpointer

    shejane = tmp_path / ".shejane" / "skills"
    shejane.mkdir(parents=True)
    _write_skill(shejane, "test-skill", title="Test Skill", description="A demo")

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("SHEJANE_LOCAL_SKILLS_PATH", raising=False)

    captured: dict[str, object] = {}

    def fake_create_deep_agent(**kwargs):
        captured["skills"] = kwargs.get("skills")
        captured["backend"] = kwargs.get("backend")
        return object()

    monkeypatch.setattr(builder_mod, "create_deep_agent", fake_create_deep_agent)

    async def run() -> None:
        reset_settings_for_tests(data_dir=tmp_path / "data")
        monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
        monkeypatch.delenv("TAVILY_API_KEY", raising=False)
        store = await LocalStore_open(tmp_path / "store.db")
        saver, stack = await open_checkpointer()
        try:
            await build_agent(
                store=store,
                checkpointer=saver,
                agent_store=InMemoryStore(),
                workspace_root=str(tmp_path),
                run_id="r-skills-on",
                skills_enabled=True,
            )
        finally:
            await store.close()
            await stack.aclose()

    asyncio.run(run())
    skills = captured["skills"]
    assert isinstance(skills, list) and len(skills) >= 1
    assert any(str(shejane) in s for s in skills)
    backend = captured["backend"]
    assert isinstance(backend, CompositeBackend)
    assert isinstance(backend.default, FilesystemBackend)
    assert backend.default.virtual_mode is True
    workspace_route = str(tmp_path.resolve()).rstrip("/") + "/"
    skill_route = str(shejane.resolve()).rstrip("/") + "/"
    assert workspace_route in backend.routes
    assert skill_route in backend.routes
    assert backend.routes[skill_route].virtual_mode is True


def test_build_agent_passes_none_when_skills_disabled(tmp_path: Path, monkeypatch) -> None:
    """`skills_enabled=False` ⇒ deepagents gets `skills=None`, so the
    SkillsMiddleware doesn't load anything into the prompt."""
    import local_host.agent.builder as builder_mod
    from local_host.agent.builder import build_agent, open_checkpointer

    shejane = tmp_path / ".shejane" / "skills"
    shejane.mkdir(parents=True)
    _write_skill(shejane, "test-skill")

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("SHEJANE_LOCAL_SKILLS_PATH", raising=False)

    captured: dict[str, object] = {}

    def fake_create_deep_agent(**kwargs):
        captured["skills"] = kwargs.get("skills")
        return object()

    monkeypatch.setattr(builder_mod, "create_deep_agent", fake_create_deep_agent)

    async def run() -> None:
        reset_settings_for_tests(data_dir=tmp_path / "data")
        monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
        monkeypatch.delenv("TAVILY_API_KEY", raising=False)
        store = await LocalStore_open(tmp_path / "store.db")
        saver, stack = await open_checkpointer()
        try:
            await build_agent(
                store=store,
                checkpointer=saver,
                agent_store=InMemoryStore(),
                workspace_root=str(tmp_path),
                run_id="r-skills-off",
                skills_enabled=False,
            )
        finally:
            await store.close()
            await stack.aclose()

    asyncio.run(run())
    assert captured["skills"] is None


def test_build_agent_defaults_workspace_to_real_scratch_when_none(
    tmp_path: Path, monkeypatch
) -> None:
    """When the client doesn't pass `workspace_path` (chat without a
    project), the backend should still get a real scratch root, but keep
    virtual path containment enabled."""
    from deepagents.backends import CompositeBackend, FilesystemBackend

    import local_host.agent.builder as builder_mod
    from local_host.agent.builder import build_agent, open_checkpointer

    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("SHEJANE_LOCAL_SKILLS_PATH", raising=False)

    captured: dict[str, object] = {}

    def fake_create_deep_agent(**kwargs):
        captured["backend"] = kwargs.get("backend")
        return object()

    monkeypatch.setattr(builder_mod, "create_deep_agent", fake_create_deep_agent)

    async def run() -> None:
        reset_settings_for_tests(data_dir=tmp_path / "data")
        monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
        monkeypatch.delenv("TAVILY_API_KEY", raising=False)
        store = await LocalStore_open(tmp_path / "store.db")
        saver, stack = await open_checkpointer()
        try:
            await build_agent(
                store=store,
                checkpointer=saver,
                agent_store=InMemoryStore(),
                workspace_root=None,
                run_id="r-no-workspace",
            )
        finally:
            await store.close()
            await stack.aclose()

    asyncio.run(run())
    backend = captured["backend"]
    assert isinstance(backend, CompositeBackend)
    assert isinstance(backend.default, FilesystemBackend)
    assert backend.default.virtual_mode is True
    # cwd should resolve to the auto-created scratch dir under tmp_path.
    scratch = (tmp_path / ".shejane" / "workspace").resolve()
    assert scratch.is_dir()
    assert backend.default.cwd == scratch
    assert str(scratch).rstrip("/") + "/" in backend.routes


# Re-export under a stable name so the async helpers above don't fight
# the import-at-module-time pattern used elsewhere in the test suite.
async def LocalStore_open(*args, **kwargs):  # mimics camelCase wrapper
    from local_host.store.sqlite import LocalStore

    return await LocalStore.open(*args, **kwargs)
