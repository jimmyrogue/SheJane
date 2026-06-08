"""Daemon configuration loaded from environment.

All env vars use the `SHEJANE_LOCAL_` prefix.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SHEJANE_LOCAL_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # HTTP server
    host: str = Field(default="127.0.0.1", alias="SHEJANE_LOCAL_HOST_ADDR")
    port: int = Field(default=17371, alias="SHEJANE_LOCAL_HOST_PORT")
    pairing_token: str = Field(default="", alias="SHEJANE_LOCAL_HOST_TOKEN")

    # Storage
    data_dir: Path = Field(default=Path.home() / ".shejane" / "local-host")
    checkpoint_db_filename: str = "agent.db"
    store_db_filename: str = "store.db"
    local_db_filename: str = "local-host.db"

    # Cloud backend (Phase 1 SSE LLM endpoint)
    cloud_base_url: str = Field(
        default="http://127.0.0.1:8080",
        alias="SHEJANE_CLOUD_BASE_URL",
    )
    cloud_token: str = Field(default="", alias="SHEJANE_CLOUD_TOKEN")

    # When set, the agent uses a deterministic in-process fake LLM instead of
    # the cloud gateway — no network, no key. Used by the SSE contract test to
    # exercise the real run/stream pipeline (event names + envelope) without a
    # live upstream. NEVER enable in production.
    fake_llm: bool = Field(default=False, alias="SHEJANE_FAKE_LLM")

    # Agent runtime knobs
    max_model_calls: int = 20
    max_tool_retries: int = 2
    research_search_limit: int = 3

    # Browser
    browser_headless: bool = True

    # Subagents (Phase 6'+ — deepagents SubAgentMiddleware)
    enable_subagents: bool = True

    # Middleware modes with explicit (non-prefixed) aliases. These are also
    # read directly by their middleware as an env fallback; builder.py now
    # passes them explicitly so a per-run override (the client's Advanced
    # agent-settings panel) can win over the env default.
    #   input_guard_mode: observe | block
    #   plan_first_mode:  off | auto | always
    input_guard_mode: str = Field(default="observe", alias="SHEJANE_LOCAL_INPUT_GUARD")
    plan_first_mode: str = Field(default="off", alias="SHEJANE_PLAN_FIRST")

    # Comma-separated list of fallback model identifiers that
    # ModelFallbackMiddleware should try when the primary model errors out.
    # Format: each entry is "provider:model" (e.g. "anthropic:claude-haiku-4")
    # or any string acceptable to LangChain's init_chat_model. Empty list ⇒
    # ModelFallbackMiddleware not added.
    fallback_models: str = Field(
        default="",
        alias="SHEJANE_LOCAL_FALLBACK_MODELS",
    )

    # Comma-separated list of PII types to detect + redact. Empty ⇒
    # PIIMiddleware not added. Supported types: email, credit_card, ip,
    # mac_address, url. Example: "credit_card,email"
    pii_redact_types: str = Field(
        default="",
        alias="SHEJANE_LOCAL_PII_REDACT",
    )

    # Comma-separated AGENTS.md paths (or directories containing them) that
    # deepagents' MemoryMiddleware should load into the system prompt at
    # run start. Empty ⇒ no memory pre-load. Example:
    #   "~/.shejane/AGENTS.md,/path/to/project/AGENTS.md"
    memory_sources: str = Field(
        default="",
        alias="SHEJANE_LOCAL_MEMORY_PATHS",
    )

    # LLM-driven tool preselection. When the agent has many tools (we ship
    # 20+), a cheap LLM first picks `max_tools` relevant ones before the
    # main model call. 0 ⇒ disabled (default — keep current behavior).
    # Set to e.g. 8 to enable filtering down to 8 most-relevant tools.
    tool_selector_max_tools: int = Field(
        default=0,
        alias="SHEJANE_LOCAL_TOOL_SELECTOR_MAX",
    )

    # Mid-loop tool-result critic mode. After each watched tool returns,
    # a cheap LLM judges whether the result is usable for the task.
    #   off    — middleware not added (default)
    #   watch  — run critic + log only, never mutate ToolMessage
    #   nudge  — prepend ⚠️ warning to ToolMessage when unusable
    #   block  — replace ToolMessage with "retry" signal when unusable
    tool_critic_mode: str = Field(
        default="off",
        alias="SHEJANE_LOCAL_TOOL_CRITIC",
    )

    # Reflection: when enabled, ReflectMiddleware after_agent runs a real
    # critic-reviser LLM call against the final answer (extra cost).
    # Default off — keeps current statistics-only behavior.
    enable_critic_reflection: bool = Field(
        default=False,
        alias="SHEJANE_LOCAL_CRITIC",
    )

    @field_validator("enable_critic_reflection", mode="before")
    @classmethod
    def _coerce_bool_env(cls, value: Any) -> Any:
        # `SHEJANE_LOCAL_CRITIC=` (empty string) is a common shape in
        # .env files where the key exists as documentation but the user
        # hasn't opted in. Pydantic's default bool parser rejects empty
        # strings — that crashes daemon startup AND the test suite. Map
        # empty / whitespace to False here; let other truthy values
        # ("1", "true", "yes") flow through to pydantic's parser.
        if isinstance(value, str) and value.strip() == "":
            return False
        return value

    def ensure_data_dir(self) -> Path:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return self.data_dir

    @property
    def checkpoint_db_path(self) -> Path:
        return self.data_dir / self.checkpoint_db_filename

    @property
    def store_db_path(self) -> Path:
        return self.data_dir / self.store_db_filename

    @property
    def local_db_path(self) -> Path:
        return self.data_dir / self.local_db_filename


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings


def reset_settings_for_tests(**overrides: object) -> Settings:
    """Replace the cached settings with a fresh instance — tests only."""
    global _settings
    _settings = Settings(**overrides)  # type: ignore[arg-type]
    return _settings
