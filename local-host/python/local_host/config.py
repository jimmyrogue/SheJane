"""Daemon configuration loaded from environment.

All env vars use the `SHEJANE_LOCAL_` prefix.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

RUN_BUDGET_LIMITS: dict[str, tuple[int, int]] = {
    "max_model_calls": (1, 100),
    "max_tool_retries": (0, 5),
    "research_search_limit": (1, 20),
}


def clamp_run_budget(field: str, value: int) -> int:
    lower, upper = RUN_BUDGET_LIMITS[field]
    return max(lower, min(upper, value))


def _empty_string_default(value: Any, default: int) -> Any:
    if isinstance(value, str) and value.strip() == "":
        return default
    return value


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SHEJANE_LOCAL_",
        env_file=".env",
        env_file_encoding="utf-8",
        validate_by_alias=True,
        validate_by_name=True,
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
    unknown_model_max_input_tokens: int = Field(
        default=32_768,
        alias="SHEJANE_LOCAL_UNKNOWN_MODEL_MAX_INPUT_TOKENS",
        ge=8_192,
        le=10_000_000,
    )
    unknown_model_max_output_tokens: int = Field(
        default=8_192,
        alias="SHEJANE_LOCAL_UNKNOWN_MODEL_MAX_OUTPUT_TOKENS",
        ge=128,
        le=1_000_000,
    )
    model_request_timeout_seconds: float = Field(
        default=120.0,
        alias="SHEJANE_LOCAL_MODEL_REQUEST_TIMEOUT_SECONDS",
        ge=5.0,
        le=900.0,
    )

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

    # Deprecated compatibility field. Runtime and the optional Go gateway both
    # reject automatic model switching; changing model requires a new explicit
    # command from the user/client.
    fallback_models: str = Field(
        default="",
        alias="SHEJANE_LOCAL_FALLBACK_MODELS",
    )

    # Compatibility deployment policy. Applied only to the outbound request
    # copy for external providers; it never rewrites LangGraph state.
    pii_redact_types: str = Field(default="", alias="SHEJANE_LOCAL_PII_REDACT")

    # Comma-separated AGENTS.md paths (or directories containing them) that
    # deepagents' MemoryMiddleware should load into the system prompt at
    # run start. Empty ⇒ no memory pre-load. Example:
    #   "~/.shejane/AGENTS.md,/path/to/project/AGENTS.md"
    memory_sources: str = Field(
        default="",
        alias="SHEJANE_LOCAL_MEMORY_PATHS",
    )

    # Bounded verification repair. When task.verify returns ok=false and the
    # model tries to finalize, jump back to the model with a repair instruction
    # this many times. 0 disables the loop.
    verification_repair_max: int = Field(
        default=1,
        alias="SHEJANE_LOCAL_VERIFY_REPAIR_MAX",
    )
    repair_workflow_max: int = Field(
        default=3,
        alias="SHEJANE_LOCAL_REPAIR_WORKFLOW_MAX",
    )

    @field_validator("verification_repair_max", mode="before")
    @classmethod
    def _coerce_verification_repair_max(cls, value: Any) -> Any:
        if isinstance(value, str) and value.strip() == "":
            return 1
        return value

    @field_validator("verification_repair_max")
    @classmethod
    def _clamp_verification_repair_max(cls, value: int) -> int:
        return max(0, min(3, value))

    @field_validator("repair_workflow_max", mode="before")
    @classmethod
    def _coerce_repair_workflow_max(cls, value: Any) -> Any:
        if isinstance(value, str) and value.strip() == "":
            return 3
        return value

    @field_validator("repair_workflow_max")
    @classmethod
    def _clamp_repair_workflow_max(cls, value: int) -> int:
        return max(0, min(5, value))

    @field_validator("max_model_calls", mode="before")
    @classmethod
    def _coerce_max_model_calls(cls, value: Any) -> Any:
        return _empty_string_default(value, 20)

    @field_validator("max_model_calls")
    @classmethod
    def _clamp_max_model_calls(cls, value: int) -> int:
        return clamp_run_budget("max_model_calls", value)

    @field_validator("max_tool_retries", mode="before")
    @classmethod
    def _coerce_max_tool_retries(cls, value: Any) -> Any:
        return _empty_string_default(value, 2)

    @field_validator("max_tool_retries")
    @classmethod
    def _clamp_max_tool_retries(cls, value: int) -> int:
        return clamp_run_budget("max_tool_retries", value)

    @field_validator("research_search_limit", mode="before")
    @classmethod
    def _coerce_research_search_limit(cls, value: Any) -> Any:
        return _empty_string_default(value, 3)

    @field_validator("research_search_limit")
    @classmethod
    def _clamp_research_search_limit(cls, value: int) -> int:
        return clamp_run_budget("research_search_limit", value)

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
