"""Test-wide pytest fixtures.

We auto-disable MCP on-disk discovery in every test. Without this, any
test that builds the agent picks up the developer's actual Claude
Desktop / Cursor / Codex MCP server list — which (a) makes the test
flaky (tries to spawn npx / uv subprocesses that may not exist in CI)
and (b) leaks environment-specific config into otherwise hermetic
tests. Tests that DO want to exercise discovery (test_mcp.py) opt
back in explicitly by setting SHEJANE_LOCAL_MCP_DISCOVERY=on inside
the test body.

We also disable LangSmith/LangChain external tracing. Agent tests create many
LangGraph runs; inheriting a developer shell's LANGSMITH_* credentials turns
unit tests into networked trace ingestion and can produce rate-limit noise.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest


@pytest.fixture(autouse=True)
def _install_test_gateway_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep legacy run-loop fixtures hermetic without shipping a Cloud adapter."""
    from local_host.agent import builder
    from local_host.llm.fake import FakeBackendChatModel
    from tests.gateway_model import BackendChatModel

    original_build_chat_model = builder._build_chat_model

    def _build_test_model(
        settings: Any,
        run_id: str,
        mode: str,
        **kwargs: Any,
    ) -> Any:
        model_binding = kwargs.get("model_binding")
        if isinstance(model_binding, dict) and model_binding.get("provider") == "openai_compatible":
            return original_build_chat_model(settings, run_id, mode, **kwargs)
        if settings.fake_llm:
            return FakeBackendChatModel(
                profile={
                    "tool_calling": True,
                    "max_input_tokens": settings.unknown_model_max_input_tokens,
                    "max_output_tokens": settings.unknown_model_max_output_tokens,
                }
            )
        return BackendChatModel(
            cloud_base_url="http://test-backend",
            cloud_token="test-only",
            mode=mode,
            run_id=run_id,
            request_timeout_s=settings.model_request_timeout_seconds,
            max_output_tokens=settings.unknown_model_max_output_tokens,
            profile={
                "tool_calling": True,
                "max_input_tokens": settings.unknown_model_max_input_tokens,
                "max_output_tokens": settings.unknown_model_max_output_tokens,
            },
        )

    monkeypatch.setattr(builder, "_build_chat_model", _build_test_model)

    from local_host.runs import RunCoordinator

    original_model_binding = RunCoordinator._model_binding
    original_model_binding_error = RunCoordinator._model_binding_error

    async def _model_binding(
        coordinator: Any,
        principal_id: str,
        mode: str,
    ) -> tuple[dict[str, Any] | None, tuple[str, str] | None]:
        if mode == "auto":
            return (
                {
                    "provider": "test_gateway",
                    "model_id": "test-model",
                    "credential_ref": "tests:gateway_model",
                    "requested_model": mode,
                    "profile": {
                        "tool_calling": True,
                        "streaming": True,
                        "max_input_tokens": 128_000,
                        "max_output_tokens": 8_192,
                    },
                    "required_capabilities": ["streaming", "tool_calling"],
                },
                None,
            )
        return await original_model_binding(coordinator, principal_id, mode)

    monkeypatch.setattr(RunCoordinator, "_model_binding", _model_binding)

    async def _model_binding_error(
        coordinator: Any,
        principal_id: str,
        settings_snapshot: dict[str, Any],
    ) -> tuple[str | None, str | None]:
        binding = settings_snapshot.get("_model_binding")
        if isinstance(binding, dict) and binding.get("provider") == "test_gateway":
            return None, None
        return await original_model_binding_error(coordinator, principal_id, settings_snapshot)

    monkeypatch.setattr(RunCoordinator, "_model_binding_error", _model_binding_error)


@pytest.fixture(autouse=True)
def _isolate_skills_disk_scan_by_default(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Keep agent tests from inheriting the developer's real skill library."""
    monkeypatch.setenv("SHEJANE_LOCAL_SKILLS_PATH", str(tmp_path / "empty-skills"))


@pytest.fixture(autouse=True)
def _disable_mcp_disk_scan_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force MCP discovery to skip on-disk sources in every test.

    Honored by `local_host.tools.mcp.discover_servers`: when
    SHEJANE_LOCAL_MCP_DISCOVERY != "on", only the env var
    SHEJANE_LOCAL_MCP_SERVERS is consulted.
    """
    monkeypatch.setenv("SHEJANE_LOCAL_MCP_DISCOVERY", "off")


@pytest.fixture(autouse=True)
def _disable_external_tracing_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep pytest hermetic even when the parent shell has LangSmith enabled."""
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "false")
    monkeypatch.delenv("LANGSMITH_API_KEY", raising=False)
    monkeypatch.delenv("LANGCHAIN_API_KEY", raising=False)
