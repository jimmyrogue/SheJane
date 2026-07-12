"""Run coordinator — leases durable SQLite jobs into supervised asyncio
tasks and exposes submit / cancel / resume / stream primitives to FastAPI.

Streaming pipeline
------------------
For each leased run:

  agent.astream(version="v2", stream_mode=[...])
       │ (LangGraph emits typed stream parts)
       ▼
RunCoordinator._drive_run persists each event and signals waiting subscribers
│
▼
/v1/runs/:id/stream reads its own ordered database cursor and yields one
SSE frame per event. In-memory events only reduce notification latency.

Cancellation is a `task.cancel()` on the driver coroutine. LangGraph
propagates CancelledError into the graph and the checkpointer persists
state up to the last superstep.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import uuid
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from langchain_core.load.dump import dumps as lc_dumps
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.store.base import BaseStore
from langgraph.types import Command

from .agent.builder import build_agent
from .agent.context_builder import RuntimeContext
from .config import Settings, clamp_run_budget, get_settings
from .event_translator import translate
from .failure_policy import classify_failure_payload
from .llm.backend import BackendLLMError
from .llm.resolve import resolve_auto_model
from .llm.runtime import bind_runtime_model
from .model_credentials import (
    CredentialStoreError,
    get_model_api_key,
)
from .observability import build_callbacks
from .progress_ledger import build_handoff_snapshot
from .store.fenced_checkpointer import FencedCheckpointer
from .store.sqlite import (
    GraphHeadConflictError,
    LeaseFenceError,
    LocalStore,
    RunAdmissionError,
    WorkspaceAdmissionError,
)
from .tools.memory import extract_memory_write_facts
from .tools.runtime import bind_runtime_tools

log = logging.getLogger("local_host.runs")

RUNTIME_PROTOCOL_VERSION = 1
RUNTIME_CAPABILITIES = frozenset(
    {
        "agent.run",
        "agent.stream",
        "workspace.files",
        "memory",
        "skills",
        "mcp",
        "subagents",
        "code.execute",
        "schedules",
        "hitl",
    }
)


def runtime_capabilities(settings: Settings) -> frozenset[str]:
    """Return capabilities backed by resources that are available now."""
    if settings.cloud_token.strip():
        return RUNTIME_CAPABILITIES
    return RUNTIME_CAPABILITIES - {"code.execute"}


class ExecutionIdentityError(RuntimeError):
    """A durable job cannot prove that it belongs to its Run owner."""


class ExecutionWorkspaceError(RuntimeError):
    """A durable job can no longer use its Run workspace."""


class ExecutionModelBindingError(RuntimeError):
    """A frozen model binding can no longer resolve its credential reference."""


class ExecutionSettlementError(RuntimeError):
    """Authoritative execution records cannot prove a safe terminal result."""


class ExecutionLeaseExpiredError(RuntimeError):
    """An execution lost ownership before it could publish a result."""


class ExecutionShutdownError(RuntimeError):
    """The Runtime stopped an execution during a controlled shutdown."""


RUN_SHUTDOWN_TIMEOUT_SECONDS = 5.0


@dataclass(frozen=True)
class RunOutcome:
    """Authoritative terminal or suspended result produced by one execution attempt."""

    status: str
    event_type: str
    payload: dict[str, Any]


def model_provider_configuration_error(settings: Settings) -> str | None:
    if settings.fake_llm:
        return None
    if not settings.cloud_token.strip():
        return "model provider is not configured"
    parsed = urlparse(settings.cloud_base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return "model provider base URL is invalid"
    return None


def _is_auto_model(model: str) -> bool:
    return model in {"", "auto", "auto.fast", "auto.smart"}


def _auto_intent_from_model(model: str) -> str:
    if model == "auto.fast":
        return "fast"
    if model == "auto.smart":
        return "smart"
    return ""


def _auto_requested_label(model: str) -> str:
    if model == "auto.fast":
        return "更快"
    if model == "auto.smart":
        return "更强"
    return "自动"


class RunNotFoundError(Exception):
    """Raised when an operation references an unknown run."""


class CheckpointNotFoundError(Exception):
    """Raised when a checkpoint fork references an unknown checkpoint."""


def _apply_advanced_overrides(base: Settings, run_settings: dict[str, Any]) -> Settings:
    """Fold the client's "Advanced" agent-settings knobs onto a copy of the
    base Settings.

    Knobs absent from `run_settings` keep the daemon's env/default value, so
    legacy callers (curl, tests, pre-panel client builds) are unaffected.
    `model_copy(update=...)` does NOT re-validate, so each value is coerced to
    its field's type here; unknown keys and unparseable / out-of-range values
    are ignored rather than crashing the run.

    The input guard is a security-posture knob: a per-run override may only
    strengthen the machine/env baseline, never weaken it.
    """
    if run_settings.get("_snapshot_version") == 1:
        snapshot_fields = {
            "max_model_calls": "max_model_calls",
            "max_tool_retries": "max_tool_retries",
            "research_search_limit": "research_search_limit",
            "subagents": "enable_subagents",
            "browser_headless": "browser_headless",
            "input_guard": "input_guard_mode",
            "plan_first": "plan_first_mode",
            "pii_redact": "pii_redact_types",
            "verification_repair_max": "verification_repair_max",
            "repair_workflow_max": "repair_workflow_max",
            "memory_sources": "memory_sources",
        }
        snapshot = {
            field: run_settings[key]
            for key, field in snapshot_fields.items()
            if key in run_settings
        }
        rank = {"off": 0, "observe": 1, "block": 2}
        if rank.get(str(base.input_guard_mode), 0) > rank.get(
            str(snapshot.get("input_guard_mode")), 0
        ):
            snapshot["input_guard_mode"] = base.input_guard_mode
        return base.model_copy(update=snapshot)

    overrides: dict[str, Any] = {}
    # Integer knobs.
    for key, field in (
        ("max_model_calls", "max_model_calls"),
        ("max_tool_retries", "max_tool_retries"),
        ("research_search_limit", "research_search_limit"),
    ):
        raw = run_settings.get(key)
        if raw is None:
            continue
        try:
            value = int(raw)
        except (TypeError, ValueError):
            continue
        overrides[field] = clamp_run_budget(field, value)
    # Boolean knobs (accept real bools or "on"/"true"/"1"/"yes").
    for key, field in (
        ("subagents", "enable_subagents"),
        ("browser_headless", "browser_headless"),
    ):
        raw = run_settings.get(key)
        if raw is None:
            continue
        overrides[field] = (
            raw if isinstance(raw, bool) else str(raw).strip().lower() in {"1", "true", "yes", "on"}
        )
    # Enumerated string knobs — only accepted from a fixed allow-list.
    # NOTE: input_guard is a security-posture knob handled separately below
    # (a per-run override may only strengthen it, never weaken it).
    for key, field, allowed in (("plan_first", "plan_first_mode", {"off", "auto", "always"}),):
        raw = run_settings.get(key)
        if raw is None:
            continue
        val = str(raw).strip().lower()
        if val in allowed:
            overrides[field] = val
    # Security-posture knob — input guard. A per-run override may only RAISE the
    # guard, never lower the machine/env baseline (strength: off < observe <
    # block). A client sending "observe" against a base of "block" is ignored.
    raw = run_settings.get("input_guard")
    if raw is not None:
        val = str(raw).strip().lower()
        rank = {"off": 0, "observe": 1, "block": 2}
        base_rank = rank.get(str(base.input_guard_mode).strip().lower(), 0)
        # Strictly-greater: only a real strengthening is applied; same-or-lower
        # is left at the baseline (same level would be a no-op copy anyway).
        if val in rank and rank[val] > base_rank:
            overrides["input_guard_mode"] = val
    return base.model_copy(update=overrides) if overrides else base


_PUBLIC_RUN_SETTING_KEYS = frozenset(
    {
        "memory",
        "skills",
        "mcp",
        "mcp_disabled",
        "code_exec",
        "max_model_calls",
        "max_tool_retries",
        "research_search_limit",
        "subagents",
        "browser_headless",
        "input_guard",
        "plan_first",
    }
)


def public_run_settings(raw: dict[str, Any] | None) -> dict[str, Any]:
    return {key: value for key, value in (raw or {}).items() if key in _PUBLIC_RUN_SETTING_KEYS}


def sanitize_run_metadata(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Keep only Runtime-owned workflow metadata; never persist arbitrary bags."""
    metadata = raw or {}
    clean: dict[str, Any] = {}
    intent = str(metadata.get("intent") or "").strip().lower()
    if intent in {"repair", "retry"}:
        clean["intent"] = intent
    for key in ("source_run_id", "source_message_id"):
        value = metadata.get(key)
        if isinstance(value, str) and 0 < len(value) <= 128:
            clean[key] = value
    attempt = metadata.get("attempt")
    if isinstance(attempt, int) and not isinstance(attempt, bool) and 1 <= attempt <= 100:
        clean["attempt"] = attempt
    for key in ("failure_category", "failure_action_kind"):
        value = metadata.get(key)
        if (
            isinstance(value, str)
            and 0 < len(value) <= 64
            and all(char.isalnum() or char in "_-" for char in value)
        ):
            clean[key] = value
    return clean


def freeze_run_settings(base: Settings, raw: dict[str, Any] | None) -> dict[str, Any]:
    public = public_run_settings(raw)
    effective = _apply_advanced_overrides(base, public)
    raw_disabled = public.get("mcp_disabled")
    disabled = (
        sorted(
            {
                str(name).strip()
                for name in raw_disabled
                if isinstance(name, str) and str(name).strip()
            }
        )
        if isinstance(raw_disabled, list)
        else []
    )

    def toggle(name: str, default: str = "on") -> str:
        return "off" if str(public.get(name, default)).strip().lower() == "off" else "on"

    return {
        "_snapshot_version": 1,
        "_cloud_tools_available": bool(base.cloud_token.strip()),
        "memory": toggle("memory"),
        "skills": toggle("skills"),
        "mcp": toggle("mcp"),
        "mcp_disabled": disabled,
        "code_exec": toggle("code_exec"),
        "max_model_calls": effective.max_model_calls,
        "max_tool_retries": effective.max_tool_retries,
        "research_search_limit": effective.research_search_limit,
        "subagents": effective.enable_subagents,
        "browser_headless": effective.browser_headless,
        "input_guard": effective.input_guard_mode,
        "plan_first": effective.plan_first_mode,
        "pii_redact": effective.pii_redact_types,
        "verification_repair_max": effective.verification_repair_max,
        "repair_workflow_max": effective.repair_workflow_max,
        "memory_sources": effective.memory_sources,
    }


class RunCoordinator:
    def __init__(
        self,
        store: LocalStore,
        checkpointer: AsyncSqliteSaver,
        agent_store: BaseStore | None = None,
        max_concurrent_runs: int = 2,
        lease_seconds: float = 30.0,
        settings: Settings | None = None,
    ) -> None:
        self.store = store
        self.checkpointer = checkpointer
        self.agent_store = agent_store
        self.settings = settings or get_settings()
        self._tasks: dict[str, asyncio.Task[Any]] = {}
        self._wakeups: dict[str, asyncio.Event] = {}
        self._goals: dict[str, str] = {}
        self._user_inputs: dict[str, str] = {}
        self._workspaces: dict[str, str | None] = {}
        self._histories: dict[str, list[dict[str, str]]] = {}
        self._settings_overrides: dict[str, dict[str, Any]] = {}
        self._run_metadata: dict[str, dict[str, Any]] = {}
        # Resolved tier per run (fast|deep|…). Mirrors local_runs.mode; lets a
        # resume after restart continue at the user's chosen tier.
        self._modes: dict[str, str] = {}
        self._worker_id = f"worker_{uuid.uuid4().hex}"
        self._lease_seconds = lease_seconds
        self._slots = asyncio.Semaphore(max(1, max_concurrent_runs))
        self._job_wakeup = asyncio.Event()
        self._dispatcher_task: asyncio.Task[None] | None = None
        self._shutting_down = False
        self._lost_leases: set[asyncio.Task[Any]] = set()
        self._unconfirmed_cleanup: set[asyncio.Task[Any]] = set()
        self._started_jobs: set[asyncio.Task[Any]] = set()
        self._model_provider_locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._agent_definitions: dict[str, Any] = {}
        self._agent_definition_lock = asyncio.Lock()
        self._fenced_checkpointer = (
            FencedCheckpointer(checkpointer, store) if checkpointer is not None else None
        )

    def start(self) -> None:
        if self._dispatcher_task is None or self._dispatcher_task.done():
            self._shutting_down = False
            self._dispatcher_task = asyncio.create_task(
                self._dispatch_jobs(), name="run-job-dispatcher"
            )
            self._job_wakeup.set()

    async def stop(self) -> None:
        self._shutting_down = True
        if self._dispatcher_task is not None:
            self._dispatcher_task.cancel()
            try:
                await self._dispatcher_task
            except asyncio.CancelledError:
                pass
            self._dispatcher_task = None
        tasks = list(self._tasks.values())
        if not tasks:
            return
        for task in tasks:
            task.cancel()
        _done, pending = await asyncio.wait(tasks, timeout=RUN_SHUTDOWN_TIMEOUT_SECONDS)
        if pending:
            raise RuntimeError(
                "runtime shutdown could not confirm cleanup for "
                f"{len(pending)} execution attempt(s)"
            )

    async def emit_for_run(
        self,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        """Persist an HTTP-originated event and wake live subscribers.

        Used by HTTP handlers to surface side-effects (`permission.resolved`,
        `question.answered`) that originate from the API surface rather
        than the LangGraph stream itself. If the stream already closed at a
        waiting point, the event is still persisted so the resume stream can
        replay it before `run.resumed`.
        """
        wakeup = self._wakeups.get(run_id)
        await self._enqueue(wakeup, run_id, event_type, payload)

    def wake_run(self, run_id: str) -> None:
        """Wake subscribers after an HTTP decision and its event commit together."""
        wakeup = self._wakeups.get(run_id)
        if wakeup is not None:
            wakeup.set()

    # ---- public API ----

    async def _model_binding(
        self,
        principal_id: str,
        requested_model: str,
    ) -> tuple[dict[str, Any], RunAdmissionError | None]:
        if self.settings.fake_llm:
            return {
                "provider": "fake",
                "credential_ref": None,
                "requested_model": requested_model,
                "required_capabilities": ["streaming", "tool_calling"],
            }, None
        if requested_model.startswith("local:"):
            parts = requested_model.split(":", 2)
            if len(parts) != 3 or not parts[1] or not parts[2]:
                return {}, RunAdmissionError(
                    "model_spec_invalid",
                    "local model spec must be local:<provider>:<model>",
                )
            provider_id, model_id = parts[1], parts[2]
            async with self._model_provider_lock(principal_id, provider_id):
                return await self._local_model_binding_locked(
                    principal_id=principal_id,
                    provider_id=provider_id,
                    model_id=model_id,
                    requested_model=requested_model,
                )

        configuration_error = model_provider_configuration_error(self.settings)
        if configuration_error == "model provider is not configured":
            return {}, RunAdmissionError(
                "model_provider_missing",
                configuration_error,
            )
        if configuration_error is not None:
            return {}, RunAdmissionError(
                "model_provider_invalid",
                configuration_error,
            )
        return {
            "provider": "gateway",
            "credential_ref": "runtime:cloud_session",
            "requested_model": requested_model,
            "required_capabilities": ["streaming", "tool_calling"],
        }, None

    @asynccontextmanager
    async def _model_admission(
        self,
        principal_id: str,
        requested_model: str,
    ) -> AsyncIterator[tuple[dict[str, Any], RunAdmissionError | None]]:
        """Keep a local provider stable until its Run is durably admitted."""
        if not requested_model.startswith("local:"):
            yield await self._model_binding(principal_id, requested_model)
            return
        parts = requested_model.split(":", 2)
        if len(parts) != 3 or not parts[1] or not parts[2]:
            yield (
                {},
                RunAdmissionError(
                    "model_spec_invalid",
                    "local model spec must be local:<provider>:<model>",
                ),
            )
            return
        provider_id, model_id = parts[1], parts[2]
        async with self._model_provider_lock(principal_id, provider_id):
            yield await self._local_model_binding_locked(
                principal_id=principal_id,
                provider_id=provider_id,
                model_id=model_id,
                requested_model=requested_model,
            )

    async def _local_model_binding_locked(
        self,
        *,
        principal_id: str,
        provider_id: str,
        model_id: str,
        requested_model: str,
    ) -> tuple[dict[str, Any], RunAdmissionError | None]:
        provider = await self.store.get_model_provider(
            principal_id=principal_id,
            provider_id=provider_id,
        )
        if provider is None or not bool(provider.get("enabled")):
            return {}, RunAdmissionError(
                "model_provider_missing",
                "local model provider is not configured",
            )
        try:
            models = json.loads(provider.get("models_json") or "[]")
        except (json.JSONDecodeError, TypeError):
            models = []
        profile = next(
            (
                model
                for model in models
                if isinstance(model, dict) and model.get("model_id") == model_id
            ),
            None,
        )
        if profile is None:
            return {}, RunAdmissionError(
                "model_not_found",
                "model is not configured for this provider",
            )
        if not bool(profile.get("tool_calling")) or not bool(profile.get("streaming")):
            return {}, RunAdmissionError(
                "model_capability_unavailable",
                "model must support streaming and tool calling",
            )
        if bool(provider.get("requires_api_key")):
            try:
                if not await get_model_api_key(
                    principal_id,
                    provider_id,
                    str(provider["credential_ref"]),
                ):
                    return {}, RunAdmissionError(
                        "model_provider_missing",
                        "model provider credential is not configured",
                    )
            except CredentialStoreError as exc:
                return {}, RunAdmissionError(
                    "model_credential_store_unavailable",
                    str(exc),
                )
        return {
            "provider": "openai_compatible",
            "provider_id": provider_id,
            "provider_version": int(provider.get("version") or 1),
            "base_url": str(provider["base_url"]),
            "requires_api_key": bool(provider.get("requires_api_key")),
            "credential_ref": str(provider["credential_ref"]),
            "requested_model": requested_model,
            "model_id": model_id,
            "profile": profile,
            "required_capabilities": ["streaming", "tool_calling"],
        }, None

    async def _model_binding_error(
        self,
        principal_id: str,
        settings_snapshot: dict[str, Any],
    ) -> tuple[str | None, str | None]:
        # Runs accepted before settings snapshots existed remain resumable.
        # Every newly accepted Run is versioned and must pass the strict check.
        if "_snapshot_version" not in settings_snapshot:
            return None, None
        if settings_snapshot.get("_snapshot_version") != 1:
            return "run settings snapshot version is unsupported", None
        binding = settings_snapshot.get("_model_binding")
        if not isinstance(binding, dict):
            return "run model binding snapshot is missing", None
        if binding.get("provider") == "fake":
            return (
                (None, None)
                if self.settings.fake_llm
                else ("fake model provider is disabled", None)
            )
        if binding.get("provider") == "openai_compatible":
            provider_id = binding.get("provider_id")
            if not isinstance(provider_id, str):
                return "run model credential reference is invalid", None
            async with self._model_provider_lock(principal_id, provider_id):
                return await self._model_binding_error_locked(
                    principal_id=principal_id,
                    provider_id=provider_id,
                    binding=binding,
                )
        if binding.get("credential_ref") != "runtime:cloud_session":
            return "run model credential reference is invalid", None
        if not self.settings.cloud_token.strip():
            return "model provider credential is no longer configured", None
        return None, None

    async def _model_binding_error_locked(
        self,
        *,
        principal_id: str,
        provider_id: str,
        binding: dict[str, Any],
    ) -> tuple[str | None, str | None]:
        provider = await self.store.get_model_provider(
            principal_id=principal_id,
            provider_id=provider_id,
        )
        if (
            provider is None
            or not bool(provider.get("enabled"))
            or int(provider.get("version") or 0) != binding.get("provider_version")
            or binding.get("credential_ref") != provider.get("credential_ref")
        ):
            return "model provider configuration was changed or revoked", None
        if not bool(binding.get("requires_api_key")):
            return None, None
        try:
            api_key = await get_model_api_key(
                principal_id,
                provider_id,
                str(binding["credential_ref"]),
            )
        except CredentialStoreError as exc:
            return str(exc), None
        if not api_key:
            return "model provider credential is no longer configured", None
        return None, api_key

    async def start_run(
        self,
        *,
        principal_id: str,
        command_id: str,
        client_message_id: str,
        protocol_version: int,
        required_capabilities: list[str],
        goal: str,
        thread_id: str | None = None,
        user_input: str | None = None,
        assistant_message_id: str | None = None,
        thread_title: str | None = None,
        thread_metadata: dict[str, Any] | None = None,
        user_item_metadata: dict[str, Any] | None = None,
        replace_from_client_id: str | None = None,
        workspace_path: str | None = None,
        mode: str = "fast",
        history: list[dict[str, str]] | None = None,
        parent_run_id: str | None = None,
        settings: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        settings_are_frozen: bool = False,
        metadata_is_trusted: bool = False,
    ) -> dict[str, Any]:
        """Start a new agent run.

        `history`, `parent_run_id`, `settings` are the optional fields
        the client sends in the POST /runs body (see TS `createLocalRun`
        in client/src/shared/local-host/client.ts). Previously they
        were silently dropped — meaning every conversation turn restarted
        the agent with zero context (multi-turn memory broken in local
        mode). We persist them on the run row and feed `history` into
        the initial state.
        """
        admission_error: RunAdmissionError | None = None
        if protocol_version != RUNTIME_PROTOCOL_VERSION:
            admission_error = RunAdmissionError(
                "protocol_version_unsupported",
                f"runtime protocol version {protocol_version} is not supported",
            )
        missing = sorted(set(required_capabilities) - runtime_capabilities(self.settings))
        if admission_error is None and missing:
            admission_error = RunAdmissionError(
                "capability_unavailable",
                f"runtime capabilities are unavailable: {', '.join(missing)}",
            )
        if settings_are_frozen:
            if not isinstance(settings, dict) or settings.get("_snapshot_version") != 1:
                raise RunAdmissionError(
                    "settings_snapshot_unsupported",
                    "run settings snapshot version is unsupported",
                )
            public_settings = dict(settings)
        else:
            public_settings = public_run_settings(settings)
        public_metadata = (
            dict(metadata or {}) if metadata_is_trusted else sanitize_run_metadata(metadata)
        )
        async with self._model_admission(principal_id, mode) as (
            model_binding,
            model_error,
        ):
            if admission_error is None:
                admission_error = model_error
            settings_snapshot = (
                dict(public_settings)
                if settings_are_frozen
                else freeze_run_settings(self.settings, public_settings)
            )
            settings_snapshot["_model_binding"] = model_binding

            run, _created = await self.store.accept_run_command(
                principal_id=principal_id,
                command_id=command_id,
                client_message_id=client_message_id,
                command_payload={
                    "type": "run.start",
                    "thread_id": thread_id,
                    "user_input": user_input,
                    "assistant_message_id": assistant_message_id,
                    "thread_title": thread_title,
                    "thread_metadata": thread_metadata,
                    "user_item_metadata": user_item_metadata,
                    "replace_from_client_id": replace_from_client_id,
                    "protocol_version": protocol_version,
                    "required_capabilities": sorted(set(required_capabilities)),
                    "goal": goal,
                    "workspace_path": workspace_path,
                    "model": mode,
                    "history": history or [],
                    "parent_run_id": parent_run_id,
                    "settings": public_settings,
                    "metadata": public_metadata,
                },
                goal=goal,
                thread_id=thread_id,
                user_input=user_input,
                assistant_message_id=assistant_message_id,
                thread_title=thread_title,
                thread_metadata=thread_metadata,
                user_item_metadata=user_item_metadata,
                replace_from_client_id=replace_from_client_id,
                workspace_path=workspace_path,
                mode=mode,
                history=history,
                parent_run_id=parent_run_id,
                settings=settings_snapshot,
                metadata=public_metadata,
                admission_error=admission_error,
            )
        self._job_wakeup.set()
        return run

    async def fork_run(
        self,
        *,
        principal_id: str,
        source_run_id: str,
        command_id: str,
        client_message_id: str,
        assistant_message_id: str,
        thread_id: str,
        protocol_version: int,
        required_capabilities: list[str],
        checkpoint_id: str,
        goal: str | None = None,
        user_input: str,
        thread_title: str | None = None,
        thread_metadata: dict[str, Any] | None = None,
        user_item_metadata: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Create a new product thread rooted at an existing graph checkpoint."""
        fork_metadata = sanitize_run_metadata(metadata)
        fork_metadata.update(
            {
                "intent": "checkpoint_fork",
                "source_run_id": source_run_id,
                "source_checkpoint_id": checkpoint_id.strip(),
            }
        )
        command_payload = {
            "type": "run.fork",
            "source_run_id": source_run_id,
            "protocol_version": protocol_version,
            "required_capabilities": sorted(set(required_capabilities)),
            "checkpoint_id": checkpoint_id.strip(),
            "thread_id": thread_id,
            "assistant_message_id": assistant_message_id,
            "goal": goal,
            "user_input": user_input,
            "thread_title": thread_title,
            "thread_metadata": thread_metadata,
            "user_item_metadata": user_item_metadata,
            "metadata": fork_metadata,
        }
        accepted = await self.store.accepted_run_for_command(
            principal_id=principal_id,
            command_id=command_id,
            client_message_id=client_message_id,
            command_payload=command_payload,
        )
        if accepted is not None:
            return accepted

        if protocol_version != RUNTIME_PROTOCOL_VERSION:
            raise RunAdmissionError(
                "protocol_version_unsupported",
                f"runtime protocol version {protocol_version} is not supported",
            )
        missing = sorted(set(required_capabilities) - runtime_capabilities(self.settings))
        if missing:
            raise RunAdmissionError(
                "capability_unavailable",
                f"runtime capabilities are unavailable: {', '.join(missing)}",
            )

        source = await self.store.get_run_for_principal(
            principal_id=principal_id,
            run_id=source_run_id,
        )
        if source is None:
            raise RunNotFoundError(source_run_id)
        workspace_error = await self.store.workspace_admission_error(
            principal_id=str(source["principal_id"]),
            path=source.get("workspace_path"),
        )
        if workspace_error is not None:
            raise WorkspaceAdmissionError(workspace_error)
        if source.get("status") in {"queued", "running", "cleanup_required"} and not source.get(
            "graph_checkpoint_id"
        ):
            raise CheckpointNotFoundError(checkpoint_id)
        if source.get("status") in {"queued", "running", "cleanup_required"}:
            raise ValueError("cannot fork a run while it is executing")
        source = await self._reconcile_graph_head(source)
        checkpoint_id = checkpoint_id.strip()
        if not checkpoint_id:
            raise CheckpointNotFoundError(checkpoint_id)

        graph_thread_id = str(source.get("graph_thread_id") or source_run_id)
        source_head_id = source.get("graph_checkpoint_id")
        if not isinstance(source_head_id, str) or not source_head_id:
            raise CheckpointNotFoundError(checkpoint_id)
        if not await _checkpoint_is_ancestor(
            self.checkpointer,
            graph_thread_id=graph_thread_id,
            head_checkpoint_id=source_head_id,
            candidate_checkpoint_id=checkpoint_id,
        ):
            raise CheckpointNotFoundError(checkpoint_id)

        fork_goal = (goal or source.get("goal") or "").strip()
        if not fork_goal:
            raise ValueError("goal required")
        fork_mode = str(source.get("mode") or "auto")
        source_settings = _json_object(source.get("settings_json"))
        if "_snapshot_version" not in source_settings:
            fork_settings = freeze_run_settings(self.settings, source_settings)
        elif source_settings.get("_snapshot_version") == 1:
            fork_settings = source_settings
        else:
            raise RunAdmissionError(
                "settings_snapshot_unsupported",
                "source run settings snapshot version is unsupported",
            )
        run, _created = await self.store.accept_run_command(
            principal_id=str(source["principal_id"]),
            command_id=command_id,
            client_message_id=client_message_id,
            command_payload=command_payload,
            goal=fork_goal,
            thread_id=thread_id,
            user_input=user_input,
            assistant_message_id=assistant_message_id,
            thread_title=thread_title,
            thread_metadata=thread_metadata,
            user_item_metadata=user_item_metadata,
            require_new_thread=True,
            workspace_path=source.get("workspace_path"),
            parent_run_id=source_run_id,
            settings=fork_settings,
            metadata=fork_metadata,
            mode=fork_mode,
            graph_thread_id=graph_thread_id,
            graph_checkpoint_id=checkpoint_id,
            graph_definition_id=source.get("graph_definition_id"),
            graph_input_kind="fork",
        )
        self._job_wakeup.set()
        return run

    async def _reconcile_graph_head(self, run: dict[str, Any]) -> dict[str, Any]:
        """Advance a stale product head from checkpoint metadata after a crash."""
        if self.checkpointer is None:
            return run
        run_id = str(run["id"])
        graph_thread_id = str(run.get("graph_thread_id") or run_id)
        current_head = run.get("graph_checkpoint_id")
        latest_id: str | None = None
        async for item in self.checkpointer.alist(
            {"configurable": {"thread_id": graph_thread_id, "checkpoint_ns": ""}},
            filter={"runtime_run_id": run_id},
            limit=1,
        ):
            latest_id = _checkpoint_id_from_config(item.config)
        if latest_id is None or latest_id == current_head:
            return run
        if (
            isinstance(current_head, str)
            and current_head
            and not await _checkpoint_is_ancestor(
                self.checkpointer,
                graph_thread_id=graph_thread_id,
                head_checkpoint_id=latest_id,
                candidate_checkpoint_id=current_head,
            )
        ):
            raise GraphHeadConflictError(f"run {run_id} checkpoint journal diverged")
        await self.store.advance_graph_checkpoint(
            run_id,
            graph_thread_id=graph_thread_id,
            expected_checkpoint_id=current_head,
            checkpoint_id=latest_id,
        )
        return {**run, "graph_checkpoint_id": latest_id}

    async def recover_orphans(self) -> None:
        """At boot, reconcile runs left non-terminal by the previous process.
        Runs backed by a pending/leased durable job remain owned by the job
        system. Legacy queued/running rows without a job are failed. Paused
        checkpointed runs remain available for a future resume command."""
        try:
            active = await self.store.list_active_runs()
        except Exception:
            log.exception("recover_orphans: failed to list active runs")
            return
        failed = 0
        kept = 0
        for run in active:
            run_id = run.get("id")
            if not run_id:
                continue
            try:
                run = await self._reconcile_graph_head(run)
            except Exception:
                log.exception("recover_orphans: graph head reconciliation failed for %s", run_id)
                try:
                    await self.store.commit_run_result(
                        run_id,
                        status="failed",
                        event_type="run.failed",
                        payload={
                            "error": "The graph checkpoint head could not be reconciled.",
                            "type": "GraphHeadConflictError",
                            "retryable": False,
                            "category": "checkpoint_incompatible",
                        },
                        orphan_recovery=True,
                    )
                    failed += 1
                except Exception:
                    log.exception("recover_orphans: failed to fail run %s", run_id)
                continue
            status = run.get("status")
            if status in ("queued", "running"):
                active_job = await self.store.get_active_run_job(run_id)
                if active_job is not None:
                    kept += 1
                    continue
                try:
                    await self.store.commit_run_result(
                        run_id,
                        status="failed",
                        event_type="run.failed",
                        payload={
                            "error": "The local runtime stopped before this run completed.",
                            "type": "RuntimeInterruptedError",
                            "retryable": True,
                            "category": "runtime_interrupted",
                        },
                        orphan_recovery=True,
                    )
                    failed += 1
                except Exception:
                    log.exception("recover_orphans: failed to fail run %s", run_id)
            elif status in {"waiting_permission", "waiting_input"}:
                resume_payload = await self.store.latest_resolved_wait_cycle_payload(run_id)
                if resume_payload is not None:
                    await self.resume_run(run_id=run_id, decision=resume_payload)
                kept += 1
        if failed or kept:
            log.info(
                "recover_orphans: %d orphaned run(s) marked failed, "
                "%d waiting run(s) left resumable",
                failed,
                kept,
            )

    async def _dispatch_jobs(self) -> None:
        try:
            while True:
                await self._slots.acquire()
                self._job_wakeup.clear()
                try:
                    job = await self.store.claim_run_job(
                        worker_id=self._worker_id,
                        lease_seconds=self._lease_seconds,
                    )
                except asyncio.CancelledError:
                    self._slots.release()
                    raise
                except Exception:
                    self._slots.release()
                    log.exception("run job claim failed")
                    await asyncio.sleep(0.5)
                    continue
                if job is None:
                    self._slots.release()
                    try:
                        await asyncio.wait_for(self._job_wakeup.wait(), timeout=0.5)
                    except TimeoutError:
                        pass
                    continue
                run_id = str(job["run_id"])
                task = asyncio.create_task(
                    self._execute_claimed_job(job),
                    name=f"run-job:{run_id}:{job['lease_generation']}",
                )
                self._tasks[run_id] = task
        except asyncio.CancelledError:
            raise

    async def _execute_claimed_job(self, job: dict[str, Any]) -> None:
        run_id = str(job["run_id"])
        generation = int(job["lease_generation"])
        execution_attempt_id = f"{job['id']}:{generation}"
        try:
            input_payload = json.loads(job.get("input_json") or "{}")
        except (json.JSONDecodeError, TypeError):
            input_payload = {}
        resume_payload: dict[str, Any] | None = None
        if job.get("resume_json"):
            try:
                decoded_resume = json.loads(job["resume_json"])
                if isinstance(decoded_resume, dict):
                    resume_payload = decoded_resume
            except (json.JSONDecodeError, TypeError):
                pass

        self._goals[run_id] = str(input_payload.get("goal") or "")
        self._user_inputs[run_id] = str(
            input_payload.get("user_input") or input_payload.get("goal") or ""
        )
        self._workspaces[run_id] = input_payload.get("workspace_path")
        self._histories[run_id] = list(input_payload.get("history") or [])
        self._settings_overrides[run_id] = dict(input_payload.get("settings") or {})
        self._run_metadata[run_id] = dict(input_payload.get("metadata") or {})
        self._modes[run_id] = str(input_payload.get("mode") or "auto")
        wakeup = asyncio.Event()
        self._wakeups[run_id] = wakeup

        owner_task = asyncio.current_task()
        assert owner_task is not None
        self._started_jobs.add(owner_task)
        heartbeat = asyncio.create_task(
            self._heartbeat_job(job, owner_task),
            name=f"run-job-heartbeat:{run_id}:{generation}",
        )
        try:
            with self.store.bind_execution_lease(
                job_id=str(job["id"]),
                run_id=run_id,
                lease_owner=self._worker_id,
                lease_generation=generation,
            ):
                run = await self.store.get_run(run_id)
                principal_id = input_payload.get("principal_id")
                identity_error: str | None = None
                if run is None:
                    identity_error = f"run {run_id} is missing for claimed job"
                elif not isinstance(principal_id, str) or not principal_id:
                    identity_error = f"run job {job['id']} is missing principal_id"
                elif principal_id != run.get("principal_id"):
                    identity_error = f"run job {job['id']} principal_id does not match its run"
                elif input_payload.get("workspace_path") != run.get("workspace_path"):
                    identity_error = f"run job {job['id']} workspace_path does not match its run"
                elif input_payload.get("mode") != run.get("mode"):
                    identity_error = f"run job {job['id']} model does not match its run"
                frozen_settings = _json_object(run.get("settings_json")) if run is not None else {}
                if identity_error is None and input_payload.get("settings") != frozen_settings:
                    identity_error = f"run job {job['id']} settings snapshot does not match its run"
                binding = frozen_settings.get("_model_binding")
                if (
                    identity_error is None
                    and job.get("kind") == "start"
                    and frozen_settings.get("_snapshot_version") == 1
                    and (
                        not isinstance(binding, dict)
                        or binding.get("requested_model") != run.get("mode")
                    )
                ):
                    identity_error = f"run job {job['id']} model binding does not match its run"
                if identity_error is not None:
                    log.error(identity_error)
                    if run is None:
                        await self.store.finish_run_job(
                            str(job["id"]),
                            lease_owner=self._worker_id,
                            lease_generation=generation,
                            status="dead",
                        )
                        return
                    outcome = await self._settle_execution_outcome(
                        run_id=run_id,
                        execution_attempt_id=execution_attempt_id,
                        outcome=RunOutcome(
                            "failed",
                            "run.failed",
                            _run_failed_payload(ExecutionIdentityError(identity_error)),
                        ),
                        cleanup_report={"status": "completed"},
                    )
                    await self._commit_run_result(
                        wakeup,
                        run_id,
                        outcome.event_type,
                        outcome.payload,
                        status=outcome.status,
                    )
                    return
                assert isinstance(principal_id, str)
                run = await self._reconcile_graph_head(run)
                self._modes[run_id] = str(run.get("mode") or "auto")
                workspace_path = run.get("workspace_path")
                workspace_error = await self.store.workspace_admission_error(
                    principal_id=principal_id,
                    path=str(workspace_path) if workspace_path is not None else None,
                )
                if workspace_error is not None:
                    outcome = await self._settle_execution_outcome(
                        run_id=run_id,
                        execution_attempt_id=execution_attempt_id,
                        outcome=RunOutcome(
                            "failed",
                            "run.failed",
                            _run_failed_payload(ExecutionWorkspaceError(workspace_error)),
                        ),
                        cleanup_report={"status": "completed"},
                    )
                    await self._commit_run_result(
                        wakeup,
                        run_id,
                        outcome.event_type,
                        outcome.payload,
                        status=outcome.status,
                    )
                    return
                binding_error, model_api_key = await self._model_binding_error(
                    principal_id,
                    frozen_settings,
                )
                if binding_error is not None:
                    outcome = await self._settle_execution_outcome(
                        run_id=run_id,
                        execution_attempt_id=execution_attempt_id,
                        outcome=RunOutcome(
                            "failed",
                            "run.failed",
                            _run_failed_payload(ExecutionModelBindingError(binding_error)),
                        ),
                        cleanup_report={"status": "completed"},
                    )
                    await self._commit_run_result(
                        wakeup,
                        run_id,
                        outcome.event_type,
                        outcome.payload,
                        status=outcome.status,
                    )
                    return
                self._workspaces[run_id] = workspace_path
                self._settings_overrides[run_id] = frozen_settings
                outcome: RunOutcome | None = None
                cleanup_report: dict[str, Any] = {"status": "completed"}
                resource_stack = AsyncExitStack()
                await resource_stack.__aenter__()
                drive_error: BaseException | None = None
                try:
                    outcome = await self._drive_run(
                        run_id=run_id,
                        principal_id=principal_id,
                        resume_payload=resume_payload,
                        mode=self._modes[run_id],
                        checkpointer=self._fenced_checkpointer,
                        model_api_key=model_api_key,
                        resource_stack=resource_stack,
                        graph_thread_id=str(run["graph_thread_id"]),
                        graph_checkpoint_id=run.get("graph_checkpoint_id"),
                        graph_input_kind=str(run.get("graph_input_kind") or "new"),
                        execution_attempt_id=execution_attempt_id,
                    )
                except BaseException as exc:
                    drive_error = exc

                cleanup_error: BaseException | None = None
                try:
                    await resource_stack.aclose()
                except BaseException as exc:
                    cleanup_error = exc

                if cleanup_error is not None:
                    # Set before the quarantine transaction. Once cleanup has
                    # failed, no concurrent heartbeat/shutdown cancellation may
                    # reinterpret this attempt as safely cleaned.
                    self._unconfirmed_cleanup.add(owner_task)
                    cleanup_report = {
                        "status": "failed",
                        "error_type": type(cleanup_error).__name__,
                    }
                    log.error(
                        "run %s resource cleanup failed: %s",
                        run_id,
                        type(cleanup_error).__name__,
                    )
                    quarantine_payload = {
                        "error": (
                            "The Runtime could not prove that all execution resources stopped. "
                            "This run is quarantined and cannot be retried automatically."
                        ),
                        "type": type(cleanup_error).__name__,
                        "retryable": False,
                        "category": "execution_cleanup_unconfirmed",
                        "cleanup": cleanup_report,
                    }
                    try:
                        await self.store.quarantine_execution_attempt(
                            run_id,
                            reason="execution_cleanup_unconfirmed",
                            payload=quarantine_payload,
                        )
                        wakeup.set()
                    except LeaseFenceError:
                        # The lease reaper may have quarantined this exact
                        # generation first. Leaving it sealed is the safe result.
                        self._lost_leases.add(owner_task)
                    outcome = None
                elif isinstance(drive_error, (asyncio.CancelledError, LeaseFenceError)):
                    lease_lost = owner_task in self._lost_leases or isinstance(
                        drive_error, LeaseFenceError
                    )
                    if lease_lost:
                        await self._confirm_lost_attempt_cleanup(
                            wakeup=wakeup,
                            run_id=run_id,
                            execution_attempt_id=execution_attempt_id,
                            job_id=str(job["id"]),
                            lease_generation=generation,
                            cleanup_report=cleanup_report,
                        )
                        outcome = None
                    elif self._shutting_down:
                        outcome = RunOutcome(
                            "failed",
                            "run.failed",
                            _run_failed_payload(
                                ExecutionShutdownError(
                                    "The Runtime shut down before this run completed."
                                )
                            ),
                        )
                    else:
                        outcome = RunOutcome("canceled", "run.canceled", {})
                elif isinstance(drive_error, Exception):
                    outcome = RunOutcome(
                        status="failed",
                        event_type="run.failed",
                        payload=_run_failed_payload(
                            drive_error,
                            secrets=(model_api_key,) if model_api_key else (),
                        ),
                    )
                elif drive_error is not None:
                    raise drive_error

                if outcome is not None:
                    outcome = await self._settle_execution_outcome(
                        run_id=run_id,
                        execution_attempt_id=execution_attempt_id,
                        outcome=outcome,
                        cleanup_report=cleanup_report,
                    )
                    await self._commit_run_result(
                        wakeup,
                        run_id,
                        outcome.event_type,
                        outcome.payload,
                        status=outcome.status,
                    )
        except LeaseFenceError:
            self._lost_leases.add(owner_task)
            log.info("run %s stopped after losing lease generation %s", run_id, generation)
            await self._confirm_lost_attempt_cleanup(
                wakeup=wakeup,
                run_id=run_id,
                execution_attempt_id=execution_attempt_id,
                job_id=str(job["id"]),
                lease_generation=generation,
                cleanup_report={"status": "completed"},
            )
        except asyncio.CancelledError:
            try:
                if owner_task in self._unconfirmed_cleanup:
                    # A cleanup failure is already or is about to be durably
                    # quarantined. Never submit a positive cleanup proof.
                    pass
                elif owner_task in self._lost_leases:
                    await self._confirm_lost_attempt_cleanup(
                        wakeup=wakeup,
                        run_id=run_id,
                        execution_attempt_id=execution_attempt_id,
                        job_id=str(job["id"]),
                        lease_generation=generation,
                        cleanup_report={"status": "completed"},
                    )
                else:
                    with self.store.bind_execution_lease(
                        job_id=str(job["id"]),
                        run_id=run_id,
                        lease_owner=self._worker_id,
                        lease_generation=generation,
                    ):
                        interrupted = (
                            RunOutcome(
                                "failed",
                                "run.failed",
                                _run_failed_payload(
                                    ExecutionShutdownError(
                                        "The Runtime shut down before this run completed."
                                    )
                                ),
                            )
                            if self._shutting_down
                            else RunOutcome("canceled", "run.canceled", {})
                        )
                        interrupted = await self._settle_execution_outcome(
                            run_id=run_id,
                            execution_attempt_id=execution_attempt_id,
                            outcome=interrupted,
                            cleanup_report={"status": "completed"},
                        )
                        await self._commit_run_result(
                            wakeup,
                            run_id,
                            interrupted.event_type,
                            interrupted.payload,
                            status=interrupted.status,
                        )
            except LeaseFenceError:
                self._lost_leases.add(owner_task)
        except Exception:
            log.exception("run %s execution attempt crashed before result commit", run_id)
        finally:
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
            if not self._shutting_down and owner_task not in self._lost_leases:
                run = await self.store.get_run(run_id)
                run_status = str((run or {}).get("status") or "")
                job_status = {
                    "completed": "completed",
                    "failed": "dead",
                    "canceled": "canceled",
                    "waiting_permission": "completed",
                    "waiting_input": "completed",
                }.get(run_status)
                if job_status is not None:
                    await self.store.finish_run_job(
                        str(job["id"]),
                        lease_owner=self._worker_id,
                        lease_generation=generation,
                        status=job_status,
                    )
            self._lost_leases.discard(owner_task)
            self._unconfirmed_cleanup.discard(owner_task)
            self._started_jobs.discard(owner_task)
            wakeup.set()
            if self._tasks.get(run_id) is owner_task:
                self._tasks.pop(run_id, None)
            if self._wakeups.get(run_id) is wakeup:
                self._wakeups.pop(run_id, None)
            self._goals.pop(run_id, None)
            self._user_inputs.pop(run_id, None)
            self._workspaces.pop(run_id, None)
            self._histories.pop(run_id, None)
            self._settings_overrides.pop(run_id, None)
            self._run_metadata.pop(run_id, None)
            self._modes.pop(run_id, None)
            self._slots.release()
            self._job_wakeup.set()

    async def _confirm_lost_attempt_cleanup(
        self,
        *,
        wakeup: asyncio.Event,
        run_id: str,
        execution_attempt_id: str,
        job_id: str,
        lease_generation: int,
        cleanup_report: dict[str, Any],
    ) -> None:
        accepted, quarantine_event = await self.store.ensure_lost_execution_quarantined(
            run_id,
            job_id=job_id,
            lease_owner=self._worker_id,
            lease_generation=lease_generation,
        )
        if not accepted:
            return
        if quarantine_event is not None:
            wakeup.set()
        outcome = RunOutcome(
            "failed",
            "run.failed",
            _run_failed_payload(
                ExecutionLeaseExpiredError("The execution lease expired before cleanup completed.")
            ),
        )
        outcome = await self._settle_execution_outcome(
            run_id=run_id,
            execution_attempt_id=execution_attempt_id,
            outcome=outcome,
            cleanup_report=cleanup_report,
            lease_state="lost",
        )
        event = await self.store.confirm_quarantined_cleanup(
            run_id,
            job_id=job_id,
            lease_owner=self._worker_id,
            lease_generation=lease_generation,
            payload=outcome.payload,
        )
        if event is not None:
            wakeup.set()

    async def _settle_execution_outcome(
        self,
        *,
        run_id: str,
        execution_attempt_id: str,
        outcome: RunOutcome,
        cleanup_report: dict[str, Any],
        lease_state: str = "current",
    ) -> RunOutcome:
        """Build one deterministic P11 result from durable Runtime records."""
        snapshot = await self.store.execution_settlement_snapshot(run_id)
        model_statuses = snapshot["model_statuses"]
        tool_statuses = snapshot["tool_statuses"]
        violations: list[str] = []
        if any(model_statuses.get(status, 0) for status in ("reserved", "streaming")):
            violations.append("model calls are still active")
        if tool_statuses.get("running", 0):
            violations.append("tool calls are still active")

        assistant = snapshot.get("assistant")
        if outcome.status == "completed":
            if not isinstance(assistant, dict) or not str(assistant.get("content") or "").strip():
                violations.append("final assistant draft is missing")
            else:
                try:
                    pending_calls = json.loads(assistant.get("tool_calls_json") or "[]")
                except (json.JSONDecodeError, TypeError):
                    pending_calls = ["invalid"]
                if pending_calls:
                    violations.append("final assistant draft still contains tool calls")
            if any(
                tool_statuses.get(status, 0) for status in ("prepared", "paused", "outcome_unknown")
            ):
                violations.append("completed run has unsettled tool receipts")
            if model_statuses.get("outcome_unknown", 0):
                violations.append("completed run has unknown model outcomes")

        if violations:
            error = ExecutionSettlementError("; ".join(violations))
            outcome = RunOutcome(
                status="failed",
                event_type="run.failed",
                payload=_run_failed_payload(error),
            )

        run = await self.store.get_run(run_id)
        usage = snapshot["usage"]
        assistant_ref = (
            {
                "message_key": str(assistant["message_key"]),
                "revision": int(assistant["revision"]),
            }
            if isinstance(assistant, dict)
            else None
        )
        execution = {
            "attempt_id": execution_attempt_id,
            "lease": lease_state,
            "checkpoint_id": (run or {}).get("graph_checkpoint_id"),
            "assistant": assistant_ref,
            "model_calls": {
                "statuses": model_statuses,
                **usage,
            },
            "tool_receipts": {"statuses": tool_statuses},
            "artifacts": snapshot["artifacts"],
            "verification": snapshot["verification"],
            "cleanup": cleanup_report,
        }
        payload = {**outcome.payload, "execution": execution}
        if outcome.status == "completed" and isinstance(assistant, dict):
            payload.update(
                {
                    "final_text": str(assistant["content"]),
                    "final_answer_ref": assistant_ref,
                    **usage,
                }
            )
        return RunOutcome(
            status=outcome.status,
            event_type=outcome.event_type,
            payload=payload,
        )

    async def _heartbeat_job(
        self,
        job: dict[str, Any],
        owner_task: asyncio.Task[Any],
    ) -> None:
        generation = int(job["lease_generation"])
        try:
            while True:
                renewed, cancel_requested = await self.store.renew_run_job(
                    str(job["id"]),
                    lease_owner=self._worker_id,
                    lease_generation=generation,
                    lease_seconds=self._lease_seconds,
                )
                if not renewed:
                    current = await self.store.get_run_job(str(job["id"]))
                    if (
                        owner_task in self._unconfirmed_cleanup
                        and current is not None
                        and current.get("status") == "leased"
                        and current.get("quarantined_at") is not None
                        and current.get("lease_owner") == self._worker_id
                        and int(current.get("lease_generation") or 0) == generation
                    ):
                        return
                    if (
                        current is not None
                        and current.get("status") in {"completed", "canceled", "dead"}
                        and current.get("lease_owner") == self._worker_id
                        and int(current.get("lease_generation") or 0) == generation
                    ):
                        return
                    self._lost_leases.add(owner_task)
                    owner_task.cancel()
                    return
                if cancel_requested:
                    owner_task.cancel()
                    return
                await asyncio.sleep(max(1.0, self._lease_seconds / 3))
        except asyncio.CancelledError:
            raise

    async def resume_run(
        self,
        *,
        run_id: str,
        decision: dict[str, Any],
    ) -> bool:
        """Resume a paused run with a decision payload (e.g. permission
        approve/deny). Returns False if the run isn't paused or unknown."""
        run = await self.store.get_run(run_id)
        if run is None or run.get("status") not in {"waiting_permission", "waiting_input"}:
            return False
        await self._reconcile_graph_head(run)
        try:
            job = await self.store.enqueue_run_job(
                run_id,
                kind="resume",
                resume_payload=decision,
            )
        except WorkspaceAdmissionError:
            return False
        if job is None or job.get("status") != "pending":
            return False
        # commit_run_result atomically settles the previous leased job before
        # publishing run.waiting. A still-present task entry only means that
        # the previous coroutine is finishing its in-memory bookkeeping; it
        # must not reject this durable resume command.
        self._job_wakeup.set()
        return True

    async def reconcile_resume_head(self, run_id: str) -> bool:
        run = await self.store.get_run(run_id)
        if run is None:
            return False
        await self._reconcile_graph_head(run)
        return True

    def wake_jobs(self) -> None:
        self._job_wakeup.set()

    async def cancel_run(self, run_id: str) -> bool:
        state = await self.store.request_run_cancel(run_id)
        if state is None:
            return False
        task = self._tasks.get(run_id)
        if task is not None and task in self._started_jobs:
            task.cancel()
        self._job_wakeup.set()
        return True

    async def cancel_model_provider_runs(
        self,
        *,
        principal_id: str,
        provider_id: str,
    ) -> int:
        """Cancel active runs before mutating a provider credential or binding."""
        run_ids: list[str] = []
        for run_id, settings in list(self._settings_overrides.items()):
            if run_id not in self._tasks:
                continue
            binding = settings.get("_model_binding")
            if not isinstance(binding, dict) or binding.get("provider_id") != provider_id:
                continue
            run = await self.store.get_run(run_id)
            if run is not None and run.get("principal_id") == principal_id:
                run_ids.append(run_id)
        tasks = [self._tasks[run_id] for run_id in run_ids if run_id in self._tasks]
        for run_id in run_ids:
            canceled = await self.cancel_run(run_id)
            if not canceled:
                task = self._tasks.get(run_id)
                if task is not None:
                    task.cancel()
        if tasks:
            _done, pending = await asyncio.wait(tasks, timeout=5.0)
            if pending:
                raise RuntimeError("active model provider runs did not stop")
        return len(run_ids)

    def _model_provider_lock(self, principal_id: str, provider_id: str) -> asyncio.Lock:
        key = (principal_id, provider_id)
        lock = self._model_provider_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._model_provider_locks[key] = lock
        return lock

    @asynccontextmanager
    async def model_provider_mutation(
        self,
        *,
        principal_id: str,
        provider_id: str,
    ) -> AsyncIterator[None]:
        """Fence admission and execution while a provider binding changes."""
        async with self._model_provider_lock(principal_id, provider_id):
            await self.cancel_model_provider_runs(
                principal_id=principal_id,
                provider_id=provider_id,
            )
            yield

    async def stream(self, run_id: str) -> AsyncIterator[dict[str, Any]]:
        """Yield AgentRunEvent envelopes (matching the TS interface):
            {id, run_id, seq, event_type, payload, created_at}

        Every subscriber owns an independent cursor over `local_events`.
        The in-memory Event is only a latency optimization; reconnects and
        daemon restarts recover from the same durable event log.
        """
        wakeup = self._wakeups.get(run_id) or asyncio.Event()
        after_seq = 0
        while True:
            # Notifications are deliberately lossy. Clear before reading so
            # this subscriber usually observes the next signal; the durable
            # cursor and timeout poll close all notification races.
            wakeup.clear()
            events = await self.store.events_since(run_id, after_seq=after_seq)
            for event in events:
                yield {
                    "id": event["id"],
                    "run_id": event["run_id"],
                    "seq": event["seq"],
                    "event_type": event["event_type"],
                    "payload": json.loads(event["payload_json"] or "{}"),
                    "created_at": event["created_at"],
                }
                after_seq = int(event["seq"])

            run = await self.store.get_run(run_id)
            if run is None:
                return
            active_job = await self.store.get_active_run_job(run_id)
            if run.get("status") not in {"queued", "running"} and active_job is None:
                return
            try:
                await asyncio.wait_for(wakeup.wait(), timeout=0.5)
            except TimeoutError:
                # Polling is the recovery path when another process commits
                # an event or this Runtime restarts between notifications.
                pass

    # ---- driver ----

    async def _drive_run(
        self,
        *,
        run_id: str,
        principal_id: str,
        resume_payload: dict[str, Any] | None,
        mode: str,
        graph_thread_id: str,
        graph_checkpoint_id: str | None,
        graph_input_kind: str,
        execution_attempt_id: str,
        checkpointer: Any | None = None,
        model_api_key: str | None = None,
        resource_stack: AsyncExitStack | None = None,
    ) -> RunOutcome:
        wakeup = self._wakeups[run_id]
        workspace_path = self._workspaces.get(run_id)
        goal = self._goals.get(run_id, "")
        repair_context: dict[str, Any] | None = None
        retry_context: dict[str, Any] | None = None

        try:
            settings = self.settings
            # Mark the run as started FIRST — before model resolution and the
            # (slow) agent build. The client treats run.started as "the daemon
            # accepted this run"; emitting it late opened a window where a
            # quick cancel produced a stream with run.canceled but no
            # run.started (flaked test_cancel_midflight on slow CI runners).
            if resume_payload is None:
                await self._enqueue(wakeup, run_id, "run.started", {"goal": goal})

                repair_context = _repair_context_from_metadata(
                    self._run_metadata.get(run_id) or {},
                    max_attempts=settings.repair_workflow_max,
                )
                if repair_context is not None:
                    if _repair_context_rejected(repair_context):
                        await self._enqueue(
                            wakeup,
                            run_id,
                            "repair.workflow",
                            _repair_workflow_payload(
                                repair_context,
                                status="rejected",
                                reason="repair attempt limit exceeded",
                            ),
                        )
                        return RunOutcome(
                            status="failed",
                            event_type="run.failed",
                            payload=_repair_rejected_failure_payload(repair_context),
                        )
                    await self._enqueue(
                        wakeup,
                        run_id,
                        "repair.workflow",
                        _repair_workflow_payload(repair_context, status="started"),
                    )
                retry_context = _retry_context_from_metadata(self._run_metadata.get(run_id) or {})

            # The cloud owns model resolution (flat catalog). The daemon
            # forwards the user's selection; "pro" stays a wire alias for the
            # legacy "deep" tier for any old caller.
            resolved_model = "deep" if mode == "pro" else mode
            requested_model = resolved_model or "auto"
            run_settings = self._settings_overrides.get(run_id) or {}
            model_binding = run_settings.get("_model_binding")

            # "Auto": ask the cloud's task-aware classifier ONCE per run which
            # catalog model fits this goal, and surface model.selected so the
            # UI badges "Auto → <label> · reason". On any failure we stay on
            # "auto" — the cloud LLM endpoint maps that to the default model
            # per turn, so the run still works (just without the badge).
            if (
                resume_payload is None
                and not settings.fake_llm
                and isinstance(model_binding, dict)
                and model_binding.get("provider") == "gateway"
                and _is_auto_model(resolved_model)
            ):
                picked = await resolve_auto_model(
                    goal,
                    cloud_base_url=settings.cloud_base_url,
                    cloud_token=settings.cloud_token,
                    intent=_auto_intent_from_model(resolved_model),
                    run_id=run_id,
                )
                if picked:
                    resolved_model = picked["model_id"]
                    await self._enqueue(
                        wakeup,
                        run_id,
                        "model.selected",
                        {
                            "requested_model": requested_model,
                            "requested_label": _auto_requested_label(requested_model),
                            "resolved_model_id": picked["model_id"],
                            "label": picked["label"],
                            "reason": picked["reason"],
                        },
                    )

            # Persist the resolved value so a resume (incl. after a daemon
            # restart) continues with the same model instead of a default.
            self._modes[run_id] = resolved_model
            if resume_payload is None:
                try:
                    await self.store.update_run_mode(run_id, resolved_model)
                except Exception:
                    log.warning("failed to persist model for run %s", run_id)

            # Per-run effective settings = base daemon settings with any
            # "Advanced" knobs the client sent folded on top.
            effective_settings = _apply_advanced_overrides(settings, run_settings)

            # The ingress schema and 1 MiB request limit are the safety boundary.
            # Context compaction belongs to Deep Agents' token-aware
            # SummarizationMiddleware; do not apply a second message-count policy
            # or manufacture a heuristic summary here.
            history = self._histories.get(run_id, [])
            full_messages: list[dict[str, str]] = [
                {"role": str(item.get("role", "user")), "content": str(item.get("content", ""))}
                for item in history
                if item.get("content")
            ]
            # +1 for the current user goal that gets appended below.
            turn_count = len(full_messages) + 1

            # Defaults: memory + skills + mcp all ON. The client's
            # agent settings panel has them enabled by default; legacy
            # callers (curl, tests) that don't send any settings
            # inherit the same default. Only an explicit "off" disables.
            memory_enabled = str(run_settings.get("memory", "on")).lower() != "off"
            skills_enabled = str(run_settings.get("skills", "on")).lower() != "off"
            mcp_enabled = str(run_settings.get("mcp", "on")).lower() != "off"
            # Code execution defaults ON now (since v7 of the client
            # storage, ~2026-05-26). The original opt-in toggle was
            # removed from the UI — first-call friction was costing
            # more than it was protecting (files only upload when the
            # LLM explicitly calls code.execute with files_in, which
            # already passes the daemon-side sensitive-filename
            # blacklist + size cap). The setting is still honored if
            # explicitly passed as "off" — leaves an env-level kill
            # switch for future enterprise/regulated deployments.
            code_exec_enabled = str(run_settings.get("code_exec", "on")).lower() != "off"
            cloud_tools_enabled = bool(run_settings.get("_cloud_tools_available")) and bool(
                self.settings.cloud_token.strip()
            )
            # Per-server opt-out from the MCP tab. The client persists
            # a list of names the user disabled and ships it on every
            # run. Defensive coercion: drop non-strings and dedupe so
            # a buggy renderer can't crash the loop.
            raw_disabled = run_settings.get("mcp_disabled") or []
            mcp_disabled_servers: set[str] = {
                str(name) for name in raw_disabled if isinstance(name, str)
            }

            async def emit_steering_event(event_type: str, payload: dict[str, Any]) -> None:
                await self._enqueue(wakeup, run_id, event_type, payload)

            runtime_context = RuntimeContext(
                run_id=run_id,
                principal_id=principal_id,
                store=self.store,
                steering_emit=emit_steering_event,
                memory_enabled=memory_enabled,
                memory_write_facts=extract_memory_write_facts(self._user_inputs.get(run_id, goal)),
                execution_attempt_id=execution_attempt_id,
                workspace_root=workspace_path,
                task_goal=goal,
                mode=resolved_model,
                turn_count=turn_count,
                repair_intent=bool(repair_context),
                repair_attempt=(repair_context or {}).get("attempt"),
                repair_max_attempts=(repair_context or {}).get("max_attempts"),
                repair_source_run_id=(repair_context or {}).get("source_run_id"),
                repair_source_message_id=(repair_context or {}).get("source_message_id"),
                repair_failure_category=(repair_context or {}).get("failure_category"),
                repair_failure_action_kind=(repair_context or {}).get("failure_action_kind"),
                retry_intent=bool(retry_context),
                retry_attempt=(retry_context or {}).get("attempt"),
                retry_source_run_id=(retry_context or {}).get("source_run_id"),
                retry_source_message_id=(retry_context or {}).get("source_message_id"),
                retry_failure_category=(retry_context or {}).get("failure_category"),
                retry_failure_action_kind=(retry_context or {}).get("failure_action_kind"),
            )
            agent = await build_agent(
                store=self.store,
                checkpointer=checkpointer or self.checkpointer,
                agent_store=self.agent_store,
                workspace_root=workspace_path,
                run_id=run_id,
                mode=resolved_model,
                task_goal=goal,
                turn_count=turn_count,
                memory_enabled=memory_enabled,
                skills_enabled=skills_enabled,
                mcp_enabled=mcp_enabled,
                mcp_disabled_servers=mcp_disabled_servers or None,
                code_exec_enabled=code_exec_enabled,
                cloud_tools_enabled=cloud_tools_enabled,
                settings=effective_settings,
                model_binding=model_binding if isinstance(model_binding, dict) else None,
                model_api_key=model_api_key,
                resource_stack=resource_stack,
                execution_attempt_id=execution_attempt_id,
                runtime_context=runtime_context,
                definition_cache=self._agent_definitions,
                definition_cache_lock=self._agent_definition_lock,
                repair_context=repair_context,
                retry_context=retry_context,
                steering_emit=emit_steering_event,
            )
            if not runtime_context.graph_definition_id:
                raise RuntimeError("agent definition id is missing")
            await self.store.bind_graph_definition(
                run_id,
                runtime_context.graph_definition_id,
            )
            config = {
                "configurable": {
                    "thread_id": graph_thread_id,
                    "checkpoint_ns": "",
                    "workspace_root": workspace_path or "",
                    "runtime_principal_id": principal_id,
                    "runtime_run_id": run_id,
                    "runtime_attempt_id": execution_attempt_id,
                    **(
                        {"checkpoint_id": graph_checkpoint_id}
                        if graph_checkpoint_id is not None
                        else {}
                    ),
                },
                "callbacks": build_callbacks(),
            }
            if resume_payload is not None:
                input_payload: Any = Command(resume=resume_payload)
                await self._enqueue(wakeup, run_id, "run.resumed", {"payload": resume_payload})
            else:
                if graph_input_kind not in {"new", "fork"}:
                    raise RuntimeError(f"unsupported graph input kind: {graph_input_kind}")
                messages = list(full_messages)
                messages.append(
                    HumanMessage(
                        content=goal,
                        additional_kwargs={
                            "runtime_kind": "task_input",
                            "runtime_run_id": run_id,
                        },
                    )
                )
                input_payload = {"messages": messages}
                # run.started + the "running" status were already emitted at
                # the top of the try block (before resolution/agent build).

            # Auto-approve loop. We may iterate multiple times if the
            # run hits successive HITL gates and every gated tool has
            # an in-run `scope=run` grant. Each iteration drains one
            # astream() cycle; on every paused state we either:
            #   • surface to the user (one-shot approval or a tool the
            #     user hasn't granted run-scope on), OR
            #   • build a synthetic Command(resume={"decisions": [...]})
            #     and loop again — making the pause invisible to the UI.
            current_checkpoint_id = graph_checkpoint_id
            while True:
                latest_checkpoint: dict[str, Any] | None = None
                if runtime_context.model is None:
                    raise RuntimeError("agent model is not bound")
                with (
                    bind_runtime_model(runtime_context.model),  # type: ignore[arg-type]
                    bind_runtime_tools(runtime_context.dynamic_tools),  # type: ignore[arg-type]
                ):
                    async for part in agent.astream(
                        input_payload,
                        config=config,
                        context=runtime_context,
                        stream_mode=["updates", "messages", "custom", "checkpoints"],
                        durability="sync",
                        version="v2",
                    ):
                        if not isinstance(part, dict):
                            continue
                        kind = part.get("type")
                        payload = part.get("data")
                        if not isinstance(kind, str):
                            continue
                        if kind == "checkpoints":
                            checkpoint_id = _checkpoint_id_from_stream(payload)
                            if checkpoint_id is not None:
                                await self.store.advance_graph_checkpoint(
                                    run_id,
                                    graph_thread_id=graph_thread_id,
                                    expected_checkpoint_id=current_checkpoint_id,
                                    checkpoint_id=checkpoint_id,
                                )
                                current_checkpoint_id = checkpoint_id
                                latest_checkpoint = payload
                            continue
                        if kind == "updates" and not part.get("ns"):
                            draft = _assistant_draft_from_update(payload)
                            if draft is not None:
                                await self.store.update_assistant_draft(
                                    run_id=run_id,
                                    **draft,
                                )
                        for translated in translate(kind, payload):
                            data = (
                                translated["data"]
                                if isinstance(translated["data"], dict)
                                else {"value": translated["data"]}
                            )
                            await self._enqueue(wakeup, run_id, translated["event"], data)

                if current_checkpoint_id is None:
                    raise RuntimeError("graph execution produced no checkpoint")
                if latest_checkpoint is None:
                    raise RuntimeError("graph execution produced no checkpoint payload")
                config = {
                    **config,
                    "configurable": {
                        **config["configurable"],
                        "checkpoint_id": current_checkpoint_id,
                    },
                }
                # v2 checkpoint parts are emitted before pending interrupt
                # writes are folded into tasks. The public state read at this
                # exact branch head includes them; v3 lifecycle streams can
                # replace this once that API is stable.
                snapshot = await agent.aget_state(config)
                next_nodes = list(snapshot.next)
                if not next_nodes:
                    completion_failure = _completion_failure_payload(
                        snapshot.values,
                        current_run_id=run_id,
                    )
                    if completion_failure is not None:
                        if repair_context is not None:
                            await self._enqueue(
                                wakeup,
                                run_id,
                                "repair.workflow",
                                _repair_workflow_payload(
                                    repair_context,
                                    status="failed",
                                    reason=str(completion_failure["error"]),
                                ),
                            )
                        return RunOutcome(
                            status="failed",
                            event_type="run.failed",
                            payload=completion_failure,
                        )
                    draft = await self.store.get_assistant_draft(run_id)
                    if draft is None:
                        raise ExecutionSettlementError("final assistant draft is missing")
                    if repair_context is not None:
                        await self._enqueue(
                            wakeup,
                            run_id,
                            "repair.workflow",
                            _repair_workflow_payload(repair_context, status="completed"),
                        )
                    return RunOutcome(
                        status="completed",
                        event_type="run.completed",
                        payload={},
                    )

                # Gather interrupts from BOTH places LangGraph stores them:
                #   • snapshot.interrupts — aggregated top-level list
                #     (LangGraph 1.x). Reliable when present.
                #   • snapshot.tasks[*].interrupts — per-task lists. With
                #     parallel tool calls (e.g. ToolNode dispatches 3
                #     web.search + 1 user.ask in one step), each tool
                #     gets its own task; the user.ask interrupt lands in
                #     whichever task index ran it, NOT necessarily
                #     tasks[0]. Earlier code only checked tasks[0] and
                #     missed the interrupt → run stalled with empty
                #     interrupts and `next=["tools"]`.
                # We prefer the top-level list and fall back to scanning
                # every task. Dedupe by interrupt id so neither source
                # double-counts.
                interrupts_top = list(getattr(snapshot, "interrupts", ()) or ())
                interrupts_per_task = [
                    intr for task in (snapshot.tasks or ()) for intr in _task_interrupts(task)
                ]
                seen_ids: set[Any] = set()
                interrupts: list[Any] = []
                for intr in interrupts_top + interrupts_per_task:
                    key = getattr(intr, "id", None)
                    if key is None:
                        interrupts.append(intr)
                        continue
                    if key in seen_ids:
                        continue
                    seen_ids.add(key)
                    interrupts.append(intr)
                interrupt_ids = [
                    str(getattr(interrupt, "id", None) or f"anonymous-{index}")
                    for index, interrupt in enumerate(interrupts)
                ]
                wait_cycle_id = (
                    "wait_"
                    + hashlib.sha256(
                        f"{run_id}\0{current_checkpoint_id}\0".encode()
                        + "\0".join(interrupt_ids).encode()
                    ).hexdigest()[:32]
                )
                # Surface to user.
                for snap_interrupt in interrupts:
                    await self._handle_interrupt(
                        wakeup,
                        run_id,
                        snap_interrupt,
                        wait_cycle_id=wait_cycle_id,
                    )
                return RunOutcome(
                    status=_waiting_status_for_interrupts(interrupts),
                    event_type="run.waiting",
                    payload={
                        "next": next_nodes,
                        "wait_cycle_id": wait_cycle_id,
                        "interrupts": [
                            {"value": getattr(i, "value", None), "id": getattr(i, "id", None)}
                            for i in interrupts
                        ],
                        "handoff": await self._build_waiting_handoff(run_id),
                    },
                )

        except asyncio.CancelledError:
            current_task = asyncio.current_task()
            if self._shutting_down or current_task in self._lost_leases:
                raise
            if repair_context is not None:
                await self._enqueue(
                    wakeup,
                    run_id,
                    "repair.workflow",
                    _repair_workflow_payload(repair_context, status="canceled"),
                )
            return RunOutcome(
                status="canceled",
                event_type="run.canceled",
                payload={},
            )
        except Exception as exc:
            failure_payload = _run_failed_payload(
                exc,
                secrets=(model_api_key,) if model_api_key else (),
            )
            if model_api_key:
                log.error(
                    "run %s failed type=%s error=%s",
                    run_id,
                    type(exc).__name__,
                    failure_payload.get("error", "model provider request failed"),
                )
            else:
                log.exception("run %s failed", run_id)
            if isinstance(exc, BackendLLMError):
                await self._enqueue(wakeup, run_id, "llm.error", failure_payload)
            if repair_context is not None:
                await self._enqueue(
                    wakeup,
                    run_id,
                    "repair.workflow",
                    _repair_workflow_payload(
                        repair_context,
                        status="failed",
                        reason=str(failure_payload.get("error") or exc),
                    ),
                )
            return RunOutcome(
                status="failed",
                event_type="run.failed",
                payload=failure_payload,
            )

    async def _build_waiting_handoff(self, run_id: str) -> dict[str, Any]:
        raw_events = await self.store.events_since(run_id, after_seq=0)
        events: list[dict[str, Any]] = []
        for event in raw_events:
            try:
                payload = json.loads(event.get("payload_json") or "{}")
            except json.JSONDecodeError:
                payload = {}
            events.append(
                {
                    "id": event.get("id"),
                    "run_id": event.get("run_id"),
                    "seq": event.get("seq"),
                    "event_type": event.get("event_type"),
                    "payload": payload,
                    "created_at": event.get("created_at"),
                }
            )
        artifacts = await self.store.list_artifacts_for_run(run_id)
        return build_handoff_snapshot(events, artifacts)

    async def _handle_interrupt(
        self,
        wakeup: asyncio.Event,
        run_id: str,
        snap_interrupt: Any,
        *,
        wait_cycle_id: str,
    ) -> None:
        """Bridge a LangGraph `interrupt(...)` into either:

        * `permission.required` (for the Runtime's parameter-bound tool
          review gate) — persisted in `local_permissions` so the
          renderer can resume after reload, and the POST resolver can
          look up `run_id` from the `permission_id` alone.
        * `question.asked` (for the `user.ask` tool) — persisted in
          `local_questions`.
        * `plan.approval_required` (for Plan Mode `write_todos`) —
          persisted in `local_plan_approvals`.

        Without this bridge, both flows surface only as the generic
        `run.waiting` and the UI can't render approval bars or question
        prompts — the agent silently stalls forever from the user's
        point of view.
        """
        value = getattr(snap_interrupt, "value", None)
        if isinstance(value, dict) and value.get("kind") == "tool_reconciliation":
            operation_id = str(value.get("operation_id") or "")
            interrupt_id = str(getattr(snap_interrupt, "id", None) or "")
            if not operation_id or not interrupt_id:
                raise RuntimeError("tool reconciliation is missing durable identity")
            record = await self.store.create_tool_reconciliation(
                run_id=run_id,
                operation_id=operation_id,
                wait_cycle_id=wait_cycle_id,
                interrupt_id=interrupt_id,
                payload=value,
            )
            await self._enqueue(
                wakeup,
                run_id,
                "tool.reconciliation_required",
                {
                    "request_id": record["id"],
                    "operation_id": operation_id,
                    "tool_name": str(value.get("tool_name") or ""),
                    "arguments_hash": str(value.get("arguments_hash") or ""),
                    "risk": str(value.get("risk") or ""),
                    "allowed_decisions": value.get("allowed_decisions") or [],
                    "wait_cycle_id": wait_cycle_id,
                    "interrupt_id": interrupt_id,
                },
            )
            return
        if isinstance(value, dict) and value.get("kind") == "plan_approval":
            todos = normalize_todos(value.get("todos"))
            tool_call_id = str(
                value.get("tool_call_id") or getattr(snap_interrupt, "id", None) or ""
            )
            summary = str(value.get("summary") or summarize_todos(todos))
            record = await self.store.create_plan_approval(
                run_id=run_id,
                tool_call_id=tool_call_id,
                todos=todos,
                summary=summary,
                wait_cycle_id=wait_cycle_id,
                interrupt_id=str(getattr(snap_interrupt, "id", None) or ""),
            )
            await self._enqueue(
                wakeup,
                run_id,
                "plan.approval_required",
                {
                    "request_id": record["id"],
                    "tool_call_id": tool_call_id,
                    "todos": record["todos"],
                    "summary": record["summary"],
                    "wait_cycle_id": wait_cycle_id,
                    "interrupt_id": record["interrupt_id"],
                },
            )
            return

        if isinstance(value, dict) and value.get("kind") == "question":
            question_text = str(value.get("question", ""))
            options_raw = value.get("options") or []
            # The `user.ask` tool signature is `options: list[str]`, but
            # the TS `AgentQuestionChoice` contract is `{label, description?}`.
            # Normalize at this boundary — every option becomes an object
            # with `label`. If the agent ever upgrades to passing dicts
            # (e.g. with descriptions), we pass those through unchanged.
            # Without this conversion the renderer's parseQuestionPayload
            # filters out every string option and silently shows nothing.
            options = _normalize_question_options(options_raw)
            questions = [
                {
                    "question": question_text,
                    "options": options,
                }
            ]
            record = await self.store.create_question(
                run_id=run_id,
                tool_call_id=getattr(snap_interrupt, "id", None),
                questions=questions,
                wait_cycle_id=wait_cycle_id,
                interrupt_id=str(getattr(snap_interrupt, "id", None) or ""),
            )
            # Attach the persisted id back onto each question so the
            # renderer's answer-binding code has a stable key.
            for q in questions:
                q["id"] = record["id"]
            await self._enqueue(
                wakeup,
                run_id,
                "question.asked",
                {
                    "request_id": record["id"],
                    "questions": questions,
                },
            )
            return

        # Parameter-bound tool review. The middleware includes the original
        # tool call id, operation id, arguments hash, and risk class. Persist
        # them verbatim so resume can prove it is authorizing this exact call.
        action_requests: list[dict[str, Any]] = []
        if isinstance(value, dict):
            ar_raw = value.get("action_requests")
            if isinstance(ar_raw, list):
                action_requests = [a for a in ar_raw if isinstance(a, dict)]
        if not action_requests:
            # Legacy / non-HITL interrupt shape — fall back to a single
            # generic record so we still surface something.
            action_requests = [{"name": "", "args": {}}]
        interrupt_id = str(getattr(snap_interrupt, "id", None) or "")
        for action_index, action in enumerate(action_requests):
            tool_name = str(action.get("name", ""))
            args_raw = action.get("args") or {}
            arguments = args_raw if isinstance(args_raw, dict) else {"value": args_raw}
            description = action.get("description") or ""
            record = await self.store.create_permission(
                run_id=run_id,
                tool_call_id=str(action.get("tool_call_id") or ""),
                tool_name=tool_name,
                tool_version=str(action.get("tool_version") or ""),
                arguments=arguments,
                operation_id=str(action.get("operation_id") or "") or None,
                arguments_hash=str(action.get("arguments_hash") or "") or None,
                risk=str(action.get("risk") or "") or None,
                wait_cycle_id=wait_cycle_id,
                interrupt_id=interrupt_id,
                action_index=action_index,
            )
            await self._enqueue(
                wakeup,
                run_id,
                "permission.required",
                {
                    "request_id": record["id"],
                    "tool": tool_name,
                    "tool_name": tool_name,
                    "arguments": arguments,
                    "description": description,
                    "tool_call_id": record.get("tool_call_id"),
                    "operation_id": record.get("operation_id"),
                    "arguments_hash": record.get("arguments_hash"),
                    "risk": record.get("risk"),
                    "allowed_decisions": action.get("allowed_decisions") or ["approve", "reject"],
                    "wait_cycle_id": wait_cycle_id,
                    "interrupt_id": interrupt_id,
                },
            )

    async def _enqueue(
        self,
        wakeup: asyncio.Event | None,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        """Persist an authoritative event, then wake interested subscribers."""
        await self.store.append_event(run_id, event_type, payload)
        if wakeup is not None:
            wakeup.set()

    async def _commit_run_result(
        self,
        wakeup: asyncio.Event,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
        *,
        status: str,
    ) -> None:
        """Persist the authoritative result before notifying live subscribers."""
        _event, created = await self.store.commit_run_result(
            run_id,
            status=status,
            event_type=event_type,
            payload=payload,
        )
        if not created:
            return
        wakeup.set()
        if status in {"waiting_permission", "waiting_input"}:
            resume_payload = await self.store.latest_resolved_wait_cycle_payload(run_id)
            if resume_payload is not None:
                await self.resume_run(run_id=run_id, decision=resume_payload)


# ---- helpers ----


def _serialize_payload(payload: Any) -> dict[str, Any]:
    """Best-effort conversion of LangGraph stream payloads into JSON-safe dicts."""
    try:
        return json.loads(lc_dumps(payload))
    except Exception:
        try:
            return json.loads(json.dumps(payload, default=str))
        except Exception:
            return {"repr": str(payload)}


def _json_object(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return dict(raw)
    if not isinstance(raw, str) or not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return dict(parsed) if isinstance(parsed, dict) else {}


def _checkpoint_id_from_stream(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    config = payload.get("config")
    return _checkpoint_id_from_config(config)


def _checkpoint_id_from_config(config: Any) -> str | None:
    if not isinstance(config, dict):
        return None
    configurable = config.get("configurable")
    if not isinstance(configurable, dict):
        return None
    checkpoint_id = configurable.get("checkpoint_id")
    return checkpoint_id if isinstance(checkpoint_id, str) and checkpoint_id else None


def _task_interrupts(task: Any) -> tuple[Any, ...] | list[Any]:
    if isinstance(task, dict):
        return task.get("interrupts") or ()
    return getattr(task, "interrupts", ()) or ()


async def _checkpoint_is_ancestor(
    checkpointer: AsyncSqliteSaver,
    *,
    graph_thread_id: str,
    head_checkpoint_id: str,
    candidate_checkpoint_id: str,
) -> bool:
    """Follow public parent configs; sibling branch checkpoints are not valid heads."""
    current = head_checkpoint_id
    seen: set[str] = set()
    while current and current not in seen:
        if current == candidate_checkpoint_id:
            return True
        seen.add(current)
        item = await checkpointer.aget_tuple(
            {
                "configurable": {
                    "thread_id": graph_thread_id,
                    "checkpoint_ns": "",
                    "checkpoint_id": current,
                }
            }
        )
        if item is None or not isinstance(item.parent_config, dict):
            return False
        parent = item.parent_config.get("configurable")
        current = parent.get("checkpoint_id") if isinstance(parent, dict) else None
    return False


def _repair_context_from_metadata(
    metadata: dict[str, Any],
    *,
    max_attempts: int,
) -> dict[str, Any] | None:
    if str(metadata.get("intent", "")).strip().lower() != "repair":
        return None
    return {
        "attempt": _positive_int(metadata.get("attempt"), default=1),
        "max_attempts": max(0, int(max_attempts)),
        "source_run_id": _non_empty_str(metadata.get("source_run_id")),
        "source_message_id": _non_empty_str(metadata.get("source_message_id")),
        "failure_category": _non_empty_str(metadata.get("failure_category")),
        "failure_action_kind": _non_empty_str(metadata.get("failure_action_kind")),
    }


def _retry_context_from_metadata(metadata: dict[str, Any]) -> dict[str, Any] | None:
    if str(metadata.get("intent", "")).strip().lower() != "retry":
        return None
    return {
        "attempt": _positive_int(metadata.get("attempt"), default=1),
        "source_run_id": _non_empty_str(metadata.get("source_run_id")),
        "source_message_id": _non_empty_str(metadata.get("source_message_id")),
        "failure_category": _non_empty_str(metadata.get("failure_category")),
        "failure_action_kind": _non_empty_str(metadata.get("failure_action_kind")),
    }


def _repair_context_rejected(context: dict[str, Any]) -> bool:
    max_attempts = int(context.get("max_attempts") or 0)
    attempt = int(context.get("attempt") or 1)
    return max_attempts <= 0 or attempt > max_attempts


def _repair_workflow_payload(
    context: dict[str, Any],
    *,
    status: str,
    reason: str | None = None,
) -> dict[str, Any]:
    payload = {
        "status": status,
        "attempt": int(context.get("attempt") or 1),
        "max_attempts": int(context.get("max_attempts") or 0),
        "source_run_id": context.get("source_run_id"),
        "source_message_id": context.get("source_message_id"),
        "failure_category": context.get("failure_category"),
        "failure_action_kind": context.get("failure_action_kind"),
        "reason": reason,
    }
    return {key: value for key, value in payload.items() if value is not None}


def _repair_rejected_failure_payload(context: dict[str, Any]) -> dict[str, Any]:
    return {
        "error": "repair attempt limit exceeded",
        "type": "RepairWorkflowRejected",
        "category": "validation",
        "recoverable": True,
        "retryable": False,
        "action_kind": "repair",
        "suggested_action": (
            "Review the previous repair attempts and adjust the task or inputs before retrying."
        ),
        "attempt": int(context.get("attempt") or 1),
        "max_attempts": int(context.get("max_attempts") or 0),
    }


def _positive_int(value: Any, *, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _non_empty_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _run_failed_payload(
    exc: Exception,
    *,
    secrets: tuple[str, ...] = (),
) -> dict[str, Any]:
    if isinstance(exc, BackendLLMError):
        payload = exc.to_event_payload()
    else:
        payload = {"error": str(exc), "type": type(exc).__name__}
        code = getattr(exc, "code", None)
        retryable = getattr(exc, "retryable", None)
        if isinstance(code, str) and code:
            payload["code"] = code
        if isinstance(retryable, bool):
            payload["retryable"] = retryable
    payload = _redact_failure_value(payload, secrets=secrets)
    classification = classify_failure_payload("run.failed", payload)
    for key in (
        "category",
        "recoverable",
        "retryable",
        "action_kind",
        "recovery_action",
        "suggested_action",
    ):
        payload.setdefault(key, classification[key])
    if classification.get("code"):
        payload.setdefault("error_code", classification["code"])
    return payload


def _redact_failure_value(value: Any, *, secrets: tuple[str, ...]) -> Any:
    if isinstance(value, dict):
        return {key: _redact_failure_value(item, secrets=secrets) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact_failure_value(item, secrets=secrets) for item in value]
    if not isinstance(value, str):
        return value
    redacted = re.sub(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", value)
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "[REDACTED]")
    return redacted


def _waiting_status_for_interrupts(interrupts: list[Any]) -> str:
    if not interrupts:
        raise ExecutionSettlementError("graph paused without a durable interrupt")
    if interrupts and all(_is_user_input_interrupt(item) for item in interrupts):
        return "waiting_input"
    return "waiting_permission"


def _is_user_input_interrupt(interrupt: Any) -> bool:
    return _is_question_interrupt(interrupt) or _is_plan_approval_interrupt(interrupt)


def _is_question_interrupt(interrupt: Any) -> bool:
    value = getattr(interrupt, "value", None)
    return isinstance(value, dict) and value.get("kind") == "question"


def _is_plan_approval_interrupt(interrupt: Any) -> bool:
    value = getattr(interrupt, "value", None)
    return isinstance(value, dict) and value.get("kind") == "plan_approval"


def normalize_todos(value: Any) -> list[dict[str, str]]:
    """Decode legacy plan-approval payloads kept for old persisted events."""
    if not isinstance(value, list):
        return []
    todos: list[dict[str, str]] = []
    for item in value:
        if isinstance(item, dict):
            content = str(item.get("content") or "").strip()
            status = str(item.get("status") or "pending").strip()
        else:
            content = str(item).strip()
            status = "pending"
        if content:
            todos.append(
                {
                    "content": content,
                    "status": (
                        status if status in {"pending", "in_progress", "completed"} else "pending"
                    ),
                }
            )
    return todos


def summarize_todos(todos: list[dict[str, str]]) -> str:
    return "; ".join(item["content"] for item in todos[:5])


def _completion_failure_payload(
    state_values: Any,
    *,
    current_run_id: str | None = None,
) -> dict[str, Any] | None:
    if not isinstance(state_values, dict):
        route: dict[str, Any] = {}
    else:
        value = state_values.get("completion_route")
        route = value if isinstance(value, dict) else {}
    if current_run_id is not None and route.get("run_id") != current_run_id:
        route = {
            "decision": "failed",
            "reason": "completion_route_scope_mismatch",
            "message": "The graph ended without a completion decision owned by this run.",
            "recoverable": False,
            "run_id": current_run_id,
        }
    if route.get("decision") not in {"failed", "blocked"}:
        return None
    reason = str(route.get("reason") or "model_output_invalid")
    message = str(route.get("message") or "The model did not produce a valid result.")
    payload = {
        "error": message,
        "error_code": reason,
        "source": "completion_router",
        "failure_category": ("verification" if reason == "verification_failed" else "model_output"),
        "recoverable": bool(route.get("recoverable")),
        "retryable": False,
        "details": {
            key: route[key] for key in ("attempts", "max_attempts", "tool_call_id") if key in route
        },
    }
    classification = classify_failure_payload("run.failed", payload)
    for key in (
        "category",
        "action_kind",
        "recovery_action",
        "suggested_action",
    ):
        payload[key] = classification[key]
    return payload


def _assistant_draft_from_update(payload: Any) -> dict[str, Any] | None:
    """Extract the latest fully assembled top-level AI message from an update."""
    if not isinstance(payload, dict):
        return None
    for delta in reversed(list(payload.values())):
        if not isinstance(delta, dict):
            continue
        messages = delta.get("messages")
        if not isinstance(messages, list):
            continue
        for message in reversed(messages):
            if getattr(message, "type", None) != "ai":
                continue
            content = _assistant_content_text(getattr(message, "content", None))
            tool_calls = [
                dict(item)
                for item in (getattr(message, "tool_calls", None) or [])
                if isinstance(item, dict)
            ]
            identity = {
                "id": getattr(message, "id", None),
                "content": content,
                "tool_calls": tool_calls,
            }
            message_key = hashlib.sha256(
                json.dumps(
                    identity,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    default=str,
                ).encode()
            ).hexdigest()
            return {
                "message_key": message_key,
                "content": content,
                "tool_calls": tool_calls,
            }
    return None


def _assistant_content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            parts.append(str(item.get("text") or ""))
        elif isinstance(item, str):
            parts.append(item)
    return "".join(parts)


def _normalize_question_options(raw: Any) -> list[dict[str, str]]:
    """Coerce `user.ask` options into the {label, description?} shape the
    TS `AgentQuestionChoice` contract expects.

    The tool signature is `options: list[str]`, so the agent typically
    emits bare strings. Earlier behavior shipped these through unchanged,
    which the client's parseQuestionPayload silently filtered out
    (typeof option !== 'object' → undefined) leaving the question UI
    with zero options to render — the run looked stuck even though
    everything else was fine.

    Accepts:
        - a string         → {label: string}
        - a {label, ...}   → passed through, coerced to strings
        - anything else    → skipped
    """
    if not isinstance(raw, list):
        return []
    options: list[dict[str, str]] = []
    for item in raw:
        if isinstance(item, str):
            label = item.strip()
            if label:
                options.append({"label": label})
            continue
        if isinstance(item, dict):
            label = str(item.get("label", "")).strip()
            if not label:
                continue
            entry: dict[str, str] = {"label": label}
            description = item.get("description")
            if isinstance(description, str) and description.strip():
                entry["description"] = description.strip()
            options.append(entry)
    return options
