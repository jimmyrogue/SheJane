from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from contextlib import AsyncExitStack
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import keyring
import pytest
from fastapi.testclient import TestClient

from local_host.agent.builder import _build_chat_model, _register_model_cleanup
from local_host.auth import LOCAL_OWNER_PRINCIPAL_ID
from local_host.config import Settings, reset_settings_for_tests
from local_host.model_credentials import credential_ref
from local_host.runs import RunCoordinator, _run_failed_payload
from local_host.server import create_app
from local_host.store.sqlite import LocalStore
from tests.helpers import run_command


class _OpenAICompatibleHandler(BaseHTTPRequestHandler):
    request_count = 0
    authorization = ""

    def do_GET(self) -> None:
        type(self).authorization = self.headers.get("authorization", "")
        body = json.dumps(
            {
                "object": "list",
                "data": [
                    {"id": "provider/model-a", "name": "Model A", "object": "model"},
                    {"id": "provider/model-b", "object": "model"},
                ],
            }
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        type(self).request_count += 1
        length = int(self.headers.get("content-length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        is_completion_review = "P9 final-answer reviewer" in str(payload)
        has_tool_result = any(message.get("role") == "tool" for message in payload["messages"])
        if is_completion_review:
            chunks = [
                {
                    "id": "chatcmpl-review",
                    "object": "chat.completion.chunk",
                    "model": "qwen3:8b",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "role": "assistant",
                                "content": json.dumps(
                                    {
                                        "decision": "allow",
                                        "reason": "The direct model answer satisfies the goal.",
                                    }
                                ),
                            },
                            "finish_reason": None,
                        }
                    ],
                },
                {
                    "id": "chatcmpl-review",
                    "object": "chat.completion.chunk",
                    "model": "qwen3:8b",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                },
            ]
        elif has_tool_result:
            chunks = [
                {
                    "id": "chatcmpl-2",
                    "object": "chat.completion.chunk",
                    "model": "qwen3:8b",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"role": "assistant", "content": "Direct model done."},
                            "finish_reason": None,
                        }
                    ],
                },
                {
                    "id": "chatcmpl-2",
                    "object": "chat.completion.chunk",
                    "model": "qwen3:8b",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                },
            ]
        else:
            chunks = [
                {
                    "id": "chatcmpl-1",
                    "object": "chat.completion.chunk",
                    "model": "qwen3:8b",
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "role": "assistant",
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call_time",
                                        "type": "function",
                                        "function": {"name": "time.now", "arguments": "{}"},
                                    }
                                ],
                            },
                            "finish_reason": None,
                        }
                    ],
                },
                {
                    "id": "chatcmpl-1",
                    "object": "chat.completion.chunk",
                    "model": "qwen3:8b",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
                },
            ]
        body = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n"
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(body.encode())))
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, _format: str, *_args: object) -> None:
        return


class _AnthropicModelsHandler(BaseHTTPRequestHandler):
    api_key = ""
    path = ""

    def do_GET(self) -> None:
        type(self).api_key = self.headers.get("x-api-key", "")
        type(self).path = self.path
        body = json.dumps(
            {
                "data": [
                    {
                        "id": "claude-sonnet-4-6",
                        "display_name": "Claude Sonnet 4.6",
                        "type": "model",
                    }
                ],
                "has_more": False,
            }
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


@pytest.fixture
def credential_vault(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    values: dict[str, str] = {}

    def get_password(_service: str, account: str) -> str | None:
        return values.get(account)

    def set_password(_service: str, account: str, password: str) -> None:
        values[account] = password

    def delete_password(_service: str, account: str) -> None:
        values.pop(account, None)

    monkeypatch.setattr(keyring, "get_password", get_password)
    monkeypatch.setattr(keyring, "set_password", set_password)
    monkeypatch.setattr(keyring, "delete_password", delete_password)
    return values


def _provider_payload(**updates: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "name": "Local Ollama",
        "kind": "openai_compatible",
        "base_url": "http://127.0.0.1:11434/v1",
        "requires_api_key": True,
        "api_key": "provider-secret",
        "models": [
            {
                "model_id": "qwen3:8b",
                "display_name": "Qwen 3 8B",
                "tool_calling": True,
                "streaming": True,
                "image_inputs": True,
                "max_input_tokens": 32768,
                "max_output_tokens": 4096,
            }
        ],
        "enabled": True,
    }
    payload.update(updates)
    return payload


def test_provider_api_persists_config_but_not_api_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    credential_vault: dict[str, str],
) -> None:
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp_path,
    )
    monkeypatch.setattr(RunCoordinator, "start", lambda _self: None)
    with TestClient(create_app(settings)) as client:
        headers = {"Authorization": "Bearer tok"}
        created = client.put(
            "/local/v1/model-providers/ollama",
            headers=headers,
            json=_provider_payload(),
        )
        assert created.status_code == 200
        assert created.json()["credential_configured"] is True
        assert "api_key" not in created.json()

        runtime = client.get("/local/v1/runtime", headers=headers).json()
        catalog = client.get("/local/v1/models", headers=headers).json()["models"]
        assert runtime["model_provider_configured"] is True
        assert "code.execute" not in runtime["capabilities"]
        assert catalog == [
            {
                "spec": "local:ollama:qwen3:8b",
                "model_id": "qwen3:8b",
                "display_name": "Qwen 3 8B",
                "provider_id": "ollama",
                "provider_name": "Local Ollama",
                "tool_calling": True,
                "streaming": True,
                "image_inputs": True,
                "max_input_tokens": 32768,
                "max_output_tokens": 4096,
                "available": True,
            }
        ]

        run = client.post(
            "/local/v1/runs",
            headers=headers,
            json=run_command("inspect", model="local:ollama:qwen3:8b"),
        )
        assert run.status_code == 200
        snapshot = json.loads(run.json()["settings_json"])
        assert snapshot["_model_binding"]["provider"] == "openai_compatible"
        assert snapshot["_model_binding"]["model_id"] == "qwen3:8b"
        assert snapshot["_model_binding"]["profile"]["image_inputs"] is True
        assert "provider-secret" not in run.json()["settings_json"]

        row = asyncio.run(
            client.app.state.store.get_model_provider(
                principal_id=LOCAL_OWNER_PRINCIPAL_ID,
                provider_id="ollama",
            )
        )
        assert row is not None
        assert "provider-secret" not in json.dumps(row)
        assert list(credential_vault.values()) == ["provider-secret"]


def test_identical_provider_put_preserves_version_and_credential_reference(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    credential_vault: dict[str, str],
) -> None:
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp_path,
    )
    monkeypatch.setattr(RunCoordinator, "start", lambda _self: None)
    with TestClient(create_app(settings)) as client:
        headers = {"Authorization": "Bearer tok"}
        assert (
            client.put(
                "/local/v1/model-providers/ollama",
                headers=headers,
                json=_provider_payload(),
            ).status_code
            == 200
        )
        first = asyncio.run(
            client.app.state.store.get_model_provider(
                principal_id=LOCAL_OWNER_PRINCIPAL_ID,
                provider_id="ollama",
            )
        )

        assert (
            client.put(
                "/local/v1/model-providers/ollama",
                headers=headers,
                json=_provider_payload(),
            ).status_code
            == 200
        )
        replay = asyncio.run(
            client.app.state.store.get_model_provider(
                principal_id=LOCAL_OWNER_PRINCIPAL_ID,
                provider_id="ollama",
            )
        )

    assert replay == first
    assert list(credential_vault.values()) == ["provider-secret"]


def test_anthropic_provider_persists_kind_and_binding(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    credential_vault: dict[str, str],
) -> None:
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp_path,
    )
    monkeypatch.setattr(RunCoordinator, "start", lambda _self: None)
    with TestClient(create_app(settings)) as client:
        headers = {"Authorization": "Bearer tok"}
        created = client.put(
            "/local/v1/model-providers/anthropic",
            headers=headers,
            json=_provider_payload(
                name="Anthropic",
                kind="anthropic",
                base_url="https://api.anthropic.com",
                models=[
                    {
                        "model_id": "claude-sonnet-4-6",
                        "display_name": "Claude Sonnet 4.6",
                    }
                ],
            ),
        )
        run = client.post(
            "/local/v1/runs",
            headers=headers,
            json=run_command(
                "inspect",
                model="local:anthropic:claude-sonnet-4-6",
            ),
        )

    assert created.status_code == 200
    assert created.json()["kind"] == "anthropic"
    assert run.status_code == 200
    binding = json.loads(run.json()["settings_json"])["_model_binding"]
    assert binding["provider"] == "anthropic"
    assert binding["model_id"] == "claude-sonnet-4-6"
    assert list(credential_vault.values()) == ["provider-secret"]


async def test_model_provider_kind_migration_preserves_existing_rows(tmp_path: Path) -> None:
    db_path = tmp_path / "local.db"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "CREATE TABLE local_model_providers ("
            "principal_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, "
            "kind TEXT NOT NULL CHECK (kind IN ('openai_compatible')), "
            "base_url TEXT NOT NULL, requires_api_key INTEGER NOT NULL DEFAULT 1, "
            "credential_ref TEXT NOT NULL, models_json TEXT NOT NULL, "
            "enabled INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, "
            "created_at TEXT NOT NULL, updated_at TEXT NOT NULL, "
            "PRIMARY KEY (principal_id, id))"
        )
        conn.execute(
            "INSERT INTO local_model_providers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                LOCAL_OWNER_PRINCIPAL_ID,
                "openai",
                "OpenAI",
                "openai_compatible",
                "https://api.openai.com/v1",
                1,
                credential_ref("openai"),
                "[]",
                1,
                1,
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z",
            ),
        )

    store = await LocalStore.open(db_path)
    try:
        existing = await store.get_model_provider(
            principal_id=LOCAL_OWNER_PRINCIPAL_ID,
            provider_id="openai",
        )
        created = await store.upsert_model_provider(
            principal_id=LOCAL_OWNER_PRINCIPAL_ID,
            provider_id="anthropic",
            name="Anthropic",
            kind="anthropic",
            base_url="https://api.anthropic.com",
            requires_api_key=True,
            credential_ref=credential_ref("anthropic"),
            models=[],
            enabled=True,
        )
    finally:
        await store.close()

    assert existing is not None and existing["kind"] == "openai_compatible"
    assert created["kind"] == "anthropic"


def test_provider_api_discovers_model_ids_and_display_names(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp_path,
    )
    monkeypatch.setattr(RunCoordinator, "start", lambda _self: None)
    _OpenAICompatibleHandler.authorization = ""
    upstream = ThreadingHTTPServer(("127.0.0.1", 0), _OpenAICompatibleHandler)
    thread = threading.Thread(target=upstream.serve_forever, daemon=True)
    thread.start()
    try:
        with TestClient(create_app(settings)) as client:
            response = client.post(
                "/local/v1/model-providers/discover-models",
                headers={"Authorization": "Bearer tok"},
                json={
                    "base_url": f"http://127.0.0.1:{upstream.server_port}/v1",
                    "api_key": "provider-secret",
                },
            )

        assert response.status_code == 200
        assert response.json() == {
            "models": [
                {"model_id": "provider/model-a", "display_name": "Model A"},
                {"model_id": "provider/model-b", "display_name": "provider/model-b"},
            ]
        }
        assert _OpenAICompatibleHandler.authorization == "Bearer provider-secret"
        assert "provider-secret" not in response.text
    finally:
        upstream.shutdown()
        upstream.server_close()
        thread.join(timeout=2)


def test_provider_api_discovers_anthropic_models(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp_path,
    )
    monkeypatch.setattr(RunCoordinator, "start", lambda _self: None)
    _AnthropicModelsHandler.api_key = ""
    _AnthropicModelsHandler.path = ""
    upstream = ThreadingHTTPServer(("127.0.0.1", 0), _AnthropicModelsHandler)
    thread = threading.Thread(target=upstream.serve_forever, daemon=True)
    thread.start()
    try:
        with TestClient(create_app(settings)) as client:
            response = client.post(
                "/local/v1/model-providers/discover-models",
                headers={"Authorization": "Bearer tok"},
                json={
                    "kind": "anthropic",
                    "base_url": f"http://127.0.0.1:{upstream.server_port}",
                    "api_key": "anthropic-secret",
                },
            )

        assert response.status_code == 200
        assert response.json() == {
            "models": [
                {
                    "model_id": "claude-sonnet-4-6",
                    "display_name": "Claude Sonnet 4.6",
                }
            ]
        }
        assert _AnthropicModelsHandler.api_key == "anthropic-secret"
        assert _AnthropicModelsHandler.path == "/v1/models"
        assert "anthropic-secret" not in response.text
    finally:
        upstream.shutdown()
        upstream.server_close()
        thread.join(timeout=2)


def test_model_discovery_reuses_a_saved_key_only_for_its_saved_url(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    credential_vault: dict[str, str],
) -> None:
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp_path,
    )
    monkeypatch.setattr(RunCoordinator, "start", lambda _self: None)
    _OpenAICompatibleHandler.authorization = ""
    upstream = ThreadingHTTPServer(("127.0.0.1", 0), _OpenAICompatibleHandler)
    thread = threading.Thread(target=upstream.serve_forever, daemon=True)
    thread.start()
    try:
        base_url = f"http://127.0.0.1:{upstream.server_port}/v1"
        with TestClient(create_app(settings)) as client:
            headers = {"Authorization": "Bearer tok"}
            created = client.put(
                "/local/v1/model-providers/ollama",
                headers=headers,
                json=_provider_payload(base_url=base_url),
            )
            assert created.status_code == 200
            assert list(credential_vault.values()) == ["provider-secret"]

            discovered = client.post(
                "/local/v1/model-providers/discover-models",
                headers=headers,
                json={"provider_id": "ollama", "base_url": base_url},
            )
            mismatched = client.post(
                "/local/v1/model-providers/discover-models",
                headers=headers,
                json={
                    "provider_id": "ollama",
                    "base_url": "http://127.0.0.1:1/v1",
                },
            )

        assert discovered.status_code == 200
        assert _OpenAICompatibleHandler.authorization == "Bearer provider-secret"
        assert mismatched.status_code == 400
        assert "saved provider URL" in mismatched.json()["detail"]
    finally:
        upstream.shutdown()
        upstream.server_close()
        thread.join(timeout=2)


def test_provider_api_rejects_invalid_models_and_deletes_credential(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    credential_vault: dict[str, str],
) -> None:
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp_path,
    )
    monkeypatch.setattr(RunCoordinator, "start", lambda _self: None)
    with TestClient(create_app(settings)) as client:
        headers = {"Authorization": "Bearer tok"}
        duplicate = _provider_payload(
            models=[
                {"model_id": "same", "display_name": "One"},
                {"model_id": "same", "display_name": "Two"},
            ]
        )
        assert (
            client.put(
                "/local/v1/model-providers/ollama",
                headers=headers,
                json=duplicate,
            ).status_code
            == 400
        )
        assert (
            client.put(
                "/local/v1/model-providers/ollama",
                headers=headers,
                json=_provider_payload(base_url="https://user:secret@example.com/v1"),
            ).status_code
            == 400
        )

        created = client.put(
            "/local/v1/model-providers/ollama",
            headers=headers,
            json=_provider_payload(),
        )
        assert created.status_code == 200
        no_key = client.put(
            "/local/v1/model-providers/ollama",
            headers=headers,
            json=_provider_payload(requires_api_key=False, api_key=None),
        )
        assert no_key.status_code == 200
        assert credential_vault == {}
        credential_vault[f"{LOCAL_OWNER_PRINCIPAL_ID}:ollama"] = "orphaned-secret"
        unavailable_model = client.post(
            "/local/v1/runs",
            headers=headers,
            json=run_command("inspect", model="local:ollama:missing"),
        )
        assert unavailable_model.status_code == 409
        assert unavailable_model.json()["detail"]["code"] == "model_not_found"

        deleted = client.delete("/local/v1/model-providers/ollama", headers=headers)
        assert deleted.status_code == 200
        assert credential_vault == {}


def test_provider_update_restores_credential_when_database_write_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    credential_vault: dict[str, str],
) -> None:
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp_path,
    )
    monkeypatch.setattr(RunCoordinator, "start", lambda _self: None)
    with TestClient(create_app(settings)) as client:
        headers = {"Authorization": "Bearer tok"}
        assert (
            client.put(
                "/local/v1/model-providers/ollama",
                headers=headers,
                json=_provider_payload(api_key="old-secret"),
            ).status_code
            == 200
        )

        async def fail_write(*_args: object, **_kwargs: object) -> dict[str, object]:
            raise RuntimeError("database unavailable")

        monkeypatch.setattr(client.app.state.store, "upsert_model_provider", fail_write)
        with pytest.raises(RuntimeError, match="database unavailable"):
            client.put(
                "/local/v1/model-providers/ollama",
                headers=headers,
                json=_provider_payload(api_key="new-secret"),
            )

    assert list(credential_vault.values()) == ["old-secret"]


def test_direct_provider_failure_payload_redacts_known_and_bearer_credentials() -> None:
    secret = "provider-secret-value"
    payload = _run_failed_payload(
        RuntimeError(f"upstream echoed Authorization: Bearer {secret}; raw={secret}"),
        secrets=(secret,),
    )

    assert secret not in json.dumps(payload)
    assert "[REDACTED]" in payload["error"]


@pytest.mark.asyncio
async def test_provider_mutation_cancels_active_runs_bound_to_that_provider(tmp_path: Path) -> None:
    store = await LocalStore.open(tmp_path / "agent.db")
    coordinator = RunCoordinator(  # type: ignore[arg-type]
        store=store,
        checkpointer=None,
        agent_store=None,
    )
    try:
        run = await store.create_run(
            principal_id=LOCAL_OWNER_PRINCIPAL_ID,
            goal="active",
            workspace_path=None,
            settings={
                "_model_binding": {
                    "provider": "openai_compatible",
                    "provider_id": "ollama",
                    "provider_version": 1,
                }
            },
            mode="local:ollama:qwen3:8b",
        )
        await store.update_run_status(run["id"], "running")
        task = asyncio.create_task(asyncio.sleep(60))
        coordinator._tasks[run["id"]] = task
        coordinator._started_jobs.add(task)
        coordinator._settings_overrides[run["id"]] = json.loads(run["settings_json"])

        canceled = await coordinator.cancel_model_provider_runs(
            principal_id=LOCAL_OWNER_PRINCIPAL_ID,
            provider_id="ollama",
        )
        await asyncio.gather(task, return_exceptions=True)

        assert canceled == 1
        assert task.cancelled()
    finally:
        await store.close()


def test_provider_validation_error_does_not_echo_api_key(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    credential_vault: dict[str, str],
) -> None:
    del credential_vault
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp_path,
    )
    monkeypatch.setattr(RunCoordinator, "start", lambda _self: None)
    with TestClient(create_app(settings)) as client:
        secret = "s" * 9000
        response = client.put(
            "/local/v1/model-providers/ollama",
            headers={"Authorization": "Bearer tok"},
            json=_provider_payload(api_key=secret),
        )

    assert response.status_code == 422
    assert secret not in response.text
    assert all("input" not in error for error in response.json()["detail"])


def test_openai_compatible_binding_builds_direct_chat_model() -> None:
    model = _build_chat_model(
        Settings(),
        "run_test",
        "local:ollama:qwen3:8b",
        model_binding={
            "provider": "openai_compatible",
            "model_id": "qwen3:8b",
            "base_url": "http://127.0.0.1:11434/v1",
            "profile": {"tool_calling": True, "max_input_tokens": 32768},
        },
        model_api_key="direct-secret",
    )

    assert model.model_name == "qwen3:8b"
    assert str(model.openai_api_base).rstrip("/") == "http://127.0.0.1:11434/v1"
    assert model.openai_api_key.get_secret_value() == "direct-secret"


async def test_anthropic_binding_builds_direct_chat_model() -> None:
    model = _build_chat_model(
        Settings(),
        "run_test",
        "local:anthropic:claude-sonnet-4-6",
        model_binding={
            "provider": "anthropic",
            "model_id": "claude-sonnet-4-6",
            "base_url": "https://api.anthropic.com",
            "profile": {"tool_calling": True, "max_input_tokens": 200000},
        },
        model_api_key="anthropic-secret",
    )

    assert model.model == "claude-sonnet-4-6"
    assert model.anthropic_api_url == "https://api.anthropic.com"
    assert model.anthropic_api_key.get_secret_value() == "anthropic-secret"

    async with AsyncExitStack() as stack:
        _register_model_cleanup(model, stack)

    assert model._client.is_closed()
    assert model._async_client.is_closed()


async def test_openai_compatible_clients_are_owned_by_one_execution() -> None:
    binding = {
        "provider": "openai_compatible",
        "model_id": "qwen3:8b",
        "base_url": "http://127.0.0.1:11434/v1",
        "profile": {"tool_calling": True, "max_input_tokens": 32768},
    }
    first = _build_chat_model(
        Settings(),
        "run_first",
        "local:ollama:qwen3:8b",
        model_binding=binding,
        model_api_key="direct-secret",
    )
    second = _build_chat_model(
        Settings(),
        "run_second",
        "local:ollama:qwen3:8b",
        model_binding=binding,
        model_api_key="direct-secret",
    )

    assert first.root_async_client._client is not second.root_async_client._client
    assert first.root_client._client is not second.root_client._client

    async with AsyncExitStack() as stack:
        _register_model_cleanup(first, stack)

    assert first.root_async_client._client.is_closed
    assert first.root_client._client.is_closed
    assert not second.root_async_client._client.is_closed
    assert not second.root_client._client.is_closed

    await second.root_async_client.close()
    second.root_client.close()


async def test_provider_update_revokes_an_already_queued_binding(
    tmp_path: Path,
    credential_vault: dict[str, str],
) -> None:
    store = await LocalStore.open(tmp_path / "local.db")
    credential_vault[f"{LOCAL_OWNER_PRINCIPAL_ID}:ollama"] = "provider-secret"
    provider = await store.upsert_model_provider(
        principal_id=LOCAL_OWNER_PRINCIPAL_ID,
        provider_id="ollama",
        name="Ollama",
        kind="openai_compatible",
        base_url="http://127.0.0.1:11434/v1",
        requires_api_key=True,
        credential_ref=credential_ref("ollama"),
        models=[
            {
                "model_id": "qwen3:8b",
                "display_name": "Qwen",
                "tool_calling": True,
                "streaming": True,
                "max_input_tokens": 32768,
            }
        ],
        enabled=True,
    )
    coordinator = RunCoordinator(store=store, checkpointer=None)  # type: ignore[arg-type]
    try:
        run = await coordinator.start_run(
            principal_id=LOCAL_OWNER_PRINCIPAL_ID,
            command_id="cmd_provider_version",
            client_message_id="msg_provider_version",
            protocol_version=1,
            required_capabilities=["agent.run", "agent.stream"],
            goal="inspect",
            mode="local:ollama:qwen3:8b",
        )
        await store.upsert_model_provider(
            principal_id=LOCAL_OWNER_PRINCIPAL_ID,
            provider_id="ollama",
            name="Ollama changed",
            kind="openai_compatible",
            base_url="http://127.0.0.1:11434/v1",
            requires_api_key=True,
            credential_ref=credential_ref("ollama"),
            models=json.loads(provider["models_json"]),
            enabled=True,
        )
        job = await store.claim_run_job(worker_id=coordinator._worker_id)
        assert job is not None

        await coordinator._execute_claimed_job(job)

        failed = await store.get_run(run["id"])
        assert failed is not None and failed["status"] == "failed"
        events = await store.events_since(run["id"], after_seq=0)
        assert json.loads(events[-1]["payload_json"])["type"] == "ExecutionModelBindingError"
    finally:
        await store.close()


async def test_provider_mutation_fences_admission_and_execution_checks(tmp_path: Path) -> None:
    store = await LocalStore.open(tmp_path / "local.db")
    provider = await store.upsert_model_provider(
        principal_id=LOCAL_OWNER_PRINCIPAL_ID,
        provider_id="ollama",
        name="Ollama",
        kind="openai_compatible",
        base_url="http://127.0.0.1:11434/v1",
        requires_api_key=False,
        credential_ref=credential_ref("ollama"),
        models=[
            {
                "model_id": "qwen3:8b",
                "display_name": "Qwen",
                "tool_calling": True,
                "streaming": True,
                "max_input_tokens": 32768,
            }
        ],
        enabled=True,
    )
    coordinator = RunCoordinator(store=store, checkpointer=None)  # type: ignore[arg-type]
    try:
        old_binding, error = await coordinator._model_binding(
            LOCAL_OWNER_PRINCIPAL_ID,
            "local:ollama:qwen3:8b",
        )
        assert error is None
        old_snapshot = {"_snapshot_version": 1, "_model_binding": old_binding}

        async with coordinator.model_provider_mutation(
            principal_id=LOCAL_OWNER_PRINCIPAL_ID,
            provider_id="ollama",
        ):
            admission = asyncio.create_task(
                coordinator.start_run(
                    principal_id=LOCAL_OWNER_PRINCIPAL_ID,
                    command_id="cmd_provider_fence",
                    client_message_id="msg_provider_fence",
                    protocol_version=1,
                    required_capabilities=["agent.run", "agent.stream"],
                    goal="fenced admission",
                    mode="local:ollama:qwen3:8b",
                )
            )
            execution = asyncio.create_task(
                coordinator._model_binding_error(
                    LOCAL_OWNER_PRINCIPAL_ID,
                    old_snapshot,
                )
            )
            await asyncio.sleep(0)
            assert not admission.done()
            assert not execution.done()
            await store.upsert_model_provider(
                principal_id=LOCAL_OWNER_PRINCIPAL_ID,
                provider_id="ollama",
                name="Ollama changed",
                kind="openai_compatible",
                base_url="http://127.0.0.1:11434/v1",
                requires_api_key=False,
                credential_ref=credential_ref("ollama"),
                models=json.loads(provider["models_json"]),
                enabled=True,
            )

        admitted_run, (execution_error, _api_key) = await asyncio.gather(
            admission,
            execution,
        )
        new_binding = json.loads(admitted_run["settings_json"])["_model_binding"]
        assert new_binding["provider_version"] == old_binding["provider_version"] + 1
        assert execution_error == "model provider configuration was changed or revoked"
    finally:
        await store.close()


def test_openai_compatible_provider_completes_model_tool_model_loop(
    tmp_path: Path,
    credential_vault: dict[str, str],
) -> None:
    del credential_vault
    _OpenAICompatibleHandler.request_count = 0
    upstream = ThreadingHTTPServer(("127.0.0.1", 0), _OpenAICompatibleHandler)
    thread = threading.Thread(target=upstream.serve_forever, daemon=True)
    thread.start()
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp_path,
    )
    try:
        with TestClient(create_app(settings)) as client:
            headers = {"Authorization": "Bearer tok"}
            configured = client.put(
                "/local/v1/model-providers/ollama",
                headers=headers,
                json=_provider_payload(
                    base_url=f"http://127.0.0.1:{upstream.server_port}/v1",
                    requires_api_key=False,
                    api_key=None,
                ),
            )
            assert configured.status_code == 200
            run = client.post(
                "/local/v1/runs",
                headers=headers,
                json=run_command(
                    "read the current time",
                    model="local:ollama:qwen3:8b",
                    settings={"memory": "off", "skills": "off", "mcp": "off"},
                ),
            )
            assert run.status_code == 200
            stream = client.get(
                f"/local/v1/runs/{run.json()['id']}/stream",
                headers=headers,
            ).text

            assert "tool.completed" in stream
            assert "run.completed" in stream
            assert "Direct model done." in stream
            assert _OpenAICompatibleHandler.request_count == 3
    finally:
        upstream.shutdown()
        thread.join(timeout=2)
