"""Context Engineering — assembles the daemon-side portion of the prompt
stack that `create_deep_agent(instructions=...)` consumes.

Prompt Stack Overview
---------------------
This module owns Layer 20-50. Layer 0+10 (identity, safety) live on the
cloud side (api/internal/llm/router.go:scenePrompt("agent_local")) and
are prepended by the Go API before the request hits the model provider.
Tool definitions (Layer 20 wire form) come from LangChain's bind_tools
path automatically. Conversation history (Layer 60) and current user
message (Layer 70) flow through `agent.astream(messages)` and are not
prompt-string concerns.

```
Priority   Layer                          Owner
─────────────────────────────────────────────────────
0          Identity                       Cloud (router.go)
10         Safety baseline                Cloud (router.go)
20         Tool definitions               LangChain (auto)
30         Developer instructions         Daemon — this file (file-loaded)
40         Active skills hint             Daemon — this file
50         Memory (AGENTS.md cascade)     Daemon — deepagents MemoryMiddleware
55         Runtime context                Daemon — this file (dynamic)
60         Conversation history           Daemon (passed through)
70         Current user message           User
```

The output of `ContextBuilder.build()` is a single string passed as
`instructions=` to `create_deep_agent`. deepagents turns it into a
SystemMessage that arrives at the cloud LLM gateway second (after the
cloud-injected identity SystemMessage).

Budget Management
-----------------
Each layer has a per-layer token cap; total cap defaults to 8 KiB
(~2000 tokens, conservative). When a layer would exceed its cap, we
truncate from the *end* of that layer and append a marker. Layer 30
(developer instructions) is treated as load-bearing and never truncated
— if the cap is too small, the build raises rather than silently
producing a broken agent.

Reload semantics
----------------
The developer-instructions markdown file is read once at module import
and cached. To pick up edits during dev, restart the daemon (or call
`reset_prompt_cache_for_tests()`). This is intentional — we don't want
file I/O on every run.
"""

from __future__ import annotations

import datetime as _dt
import locale as _locale
import logging
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("local_host.agent.context_builder")

_PROMPTS_DIR = Path(__file__).parent / "prompts"
_DEVELOPER_PROMPT_PATH = _PROMPTS_DIR / "developer.md"

# Conservative defaults. The total budget here only governs daemon-side
# layers; the cloud-side identity prompt is small (~250 chars) and not
# counted. Rough rule of thumb: 1 token ≈ 4 chars for English, ~2 chars
# for Chinese. 8 KiB → ~2k–4k tokens worth of system context.
_DEFAULT_TOTAL_BUDGET_CHARS = 8 * 1024
_TRUNCATION_MARKER = "\n…[内容过长已截断]"


@dataclass(frozen=True)
class ContextLayer:
    """One slot in the assembled prompt.

    `name` is for logs/snapshots, `priority` controls assembly order
    (lower = closer to the top), `content` is the rendered text, and
    `max_chars` is the per-layer budget. Layers below a priority of 50
    are considered "structural" (identity-adjacent, developer-controlled)
    and are never truncated — if their content blows the budget, the
    build fails loudly so we notice during dev rather than silently
    shipping a broken agent.
    """

    name: str
    priority: int
    content: str
    max_chars: int = 4096
    truncatable: bool = True


@dataclass
class RuntimeContext:
    """Inputs that go into Layer 55 (runtime context block).

    All fields are optional; missing fields just don't appear in the
    rendered block.
    """

    workspace_root: str | None = None
    locale: str | None = None
    enabled_skills: list[str] = field(default_factory=list)
    now: _dt.datetime | None = None  # injected for tests; defaults to UTC now


class ContextBuilder:
    """Assembles Layer 20-55 of the prompt stack.

    Stateless: a single instance can build many prompts. Tests
    construct with overridden paths/budgets.
    """

    def __init__(
        self,
        *,
        developer_prompt_path: Path = _DEVELOPER_PROMPT_PATH,
        total_budget_chars: int = _DEFAULT_TOTAL_BUDGET_CHARS,
    ) -> None:
        self._developer_prompt_path = developer_prompt_path
        self._total_budget_chars = total_budget_chars
        self._developer_cache: str | None = None

    # ---- public API ----------------------------------------------------

    def build(self, *, runtime: RuntimeContext) -> str:
        """Return the assembled instructions string for create_deep_agent.

        Layers are concatenated in priority order with `\\n\\n` between
        them. The result is what deepagents sees as `instructions=`.
        """
        layers = [
            self._layer_developer(),
            self._layer_skills(runtime.enabled_skills),
            self._layer_runtime_context(runtime),
        ]
        layers = [layer for layer in layers if layer.content.strip()]
        return self._assemble(layers)

    def render_snapshot(self, *, runtime: RuntimeContext) -> dict[str, str]:
        """Return a {layer_name: content} mapping for tests and debug
        dumps. Useful for assertion-by-layer rather than substring
        search on the assembled blob."""
        layers = [
            self._layer_developer(),
            self._layer_skills(runtime.enabled_skills),
            self._layer_runtime_context(runtime),
        ]
        return {layer.name: layer.content for layer in layers}

    # ---- layer builders ------------------------------------------------

    def _layer_developer(self) -> ContextLayer:
        """Layer 30 — agent behavior guidance (file-loaded, non-truncatable).

        Loaded once and cached. To refresh during dev, restart the daemon.
        """
        if self._developer_cache is None:
            try:
                self._developer_cache = self._developer_prompt_path.read_text(encoding="utf-8")
            except OSError as exc:
                log.error(
                    "developer prompt file unreadable at %s: %s",
                    self._developer_prompt_path,
                    exc,
                )
                self._developer_cache = ""
        return ContextLayer(
            name="developer",
            priority=30,
            content=self._developer_cache,
            max_chars=8 * 1024,
            truncatable=False,
        )

    def _layer_skills(self, enabled_skills: list[str]) -> ContextLayer:
        """Layer 40 — names of skills the user has enabled for this run.

        We don't dump the skill body here; deepagents' SkillsMiddleware
        does that on activation. This layer just primes the model that
        the skills are available so it picks them up earlier in the
        decision loop.
        """
        if not enabled_skills:
            return ContextLayer(name="skills", priority=40, content="")
        lines = ["# 用户启用的 Skill", ""]
        for name in enabled_skills:
            lines.append(f"- {name}")
        lines.append("")
        lines.append("如果用户的请求与某个 skill 明显相关，优先使用该 skill 的能力。")
        return ContextLayer(
            name="skills",
            priority=40,
            content="\n".join(lines),
            max_chars=1024,
        )

    def _layer_runtime_context(self, runtime: RuntimeContext) -> ContextLayer:
        """Layer 55 — implicit context the model needs but the user
        didn't say out loud.

        Crucial design point: this is APPENDED to the prompt stack, NOT
        merged into the user message. The user's original words remain
        the user's words. The model sees this block as system-level
        runtime info, separate from the conversational turn.
        """
        now = runtime.now or _dt.datetime.now(_dt.UTC)
        # Convert to local for readability. Falls back to UTC if locale
        # detection is unavailable (CI, tests).
        try:
            local_now = now.astimezone()
        except Exception:
            local_now = now

        lines = ["# 运行时上下文", ""]
        lines.append(f"- 当前时间: {local_now.strftime('%Y-%m-%d %H:%M %Z')}")
        if runtime.workspace_root:
            lines.append(f"- 工作区根目录: `{runtime.workspace_root}`")
        else:
            lines.append("- 工作区: 未授权（仅虚拟文件系统，不能读写真实磁盘文件）")

        loc = runtime.locale or _detect_locale()
        if loc:
            lines.append(f"- 用户语言偏好: {loc}")
        return ContextLayer(
            name="runtime_context",
            priority=55,
            content="\n".join(lines),
            max_chars=2048,
        )

    # ---- assembly ------------------------------------------------------

    def _assemble(self, layers: list[ContextLayer]) -> str:
        """Concat layers in priority order with per-layer + total budget
        enforcement.

        Truncation rules:
          - Non-truncatable layers exceeding their cap raise ValueError
            (loud failure during dev).
          - Truncatable layers exceeding their cap get cut at max_chars
            with a marker appended.
          - If the total assembled length exceeds total_budget_chars,
            truncate trailing truncatable layers until we fit.
        """
        ordered = sorted(layers, key=lambda layer: layer.priority)

        # Per-layer enforcement first.
        rendered: list[tuple[ContextLayer, str]] = []
        for layer in ordered:
            content = layer.content
            if len(content) > layer.max_chars:
                if not layer.truncatable:
                    raise ValueError(
                        f"context layer {layer.name!r} ({len(content)} chars) exceeds "
                        f"its non-truncatable cap of {layer.max_chars}; "
                        f"shrink the source content or raise the cap."
                    )
                content = content[: layer.max_chars - len(_TRUNCATION_MARKER)] + _TRUNCATION_MARKER
                log.warning(
                    "context layer %s truncated from %d to %d chars",
                    layer.name,
                    len(layer.content),
                    len(content),
                )
            rendered.append((layer, content))

        # Total enforcement — walk backwards through truncatable layers
        # and shave until we fit.
        joined = "\n\n".join(content for _, content in rendered)
        if len(joined) <= self._total_budget_chars:
            return joined

        log.warning(
            "assembled context %d chars exceeds total budget %d; trimming",
            len(joined),
            self._total_budget_chars,
        )
        # Greedy from-the-tail strategy: shorten the lowest-priority
        # truncatable layer first, then the next, etc.
        for i in range(len(rendered) - 1, -1, -1):
            layer, content = rendered[i]
            if not layer.truncatable:
                continue
            overflow = len(joined) - self._total_budget_chars
            if overflow <= 0:
                break
            new_len = max(0, len(content) - overflow - len(_TRUNCATION_MARKER))
            new_content = content[:new_len] + _TRUNCATION_MARKER if new_len > 0 else ""
            rendered[i] = (layer, new_content)
            joined = "\n\n".join(c for _, c in rendered if c)
        return joined


# Module-level singleton for the common case. Tests construct their own
# instance with overridden paths.
_default_builder = ContextBuilder()


def build_default_context(runtime: RuntimeContext) -> str:
    """Convenience wrapper around the module-level builder."""
    return _default_builder.build(runtime=runtime)


def reset_prompt_cache_for_tests() -> None:
    """Drop the cached developer prompt so a subsequent build re-reads
    the file. Tests that mutate developer.md call this between cases.

    Production code should NEVER call this — the cache is intentional
    to avoid file I/O per run."""
    _default_builder._developer_cache = None


def _detect_locale() -> str | None:
    """Best-effort locale string for the runtime context block.

    Returns 'zh'/'en'/etc. from the system locale. Returns None when
    detection fails (CI without LANG, etc.) so the layer just omits
    the line instead of asserting a wrong default."""
    try:
        loc = _locale.getlocale()[0]
    except Exception:
        return None
    if not loc:
        return None
    return loc.split("_")[0].lower() if "_" in loc else loc.lower()
