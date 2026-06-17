from __future__ import annotations

import asyncio
import json
import os
import tempfile
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from local_host.config import reset_settings_for_tests
from local_host.lark.connector import (
    ConnectorCommandResult,
    LarkConnector,
    LarkConnectorStatus,
)
from local_host.server import LarkAutoSyncDispatcher, create_app
from local_host.store.sqlite import LocalStore

HEADERS = {"Authorization": "Bearer tok"}
LARK_IM_SCOPE_ARG = " ".join(
    [
        "im:chat:read",
        "im:message.group_msg:get_as_user",
        "im:message.p2p_msg:get_as_user",
        "im:message.reactions:read",
        "contact:user.base:readonly",
    ]
)


def _stable_lark_hash(kind: str, value: str) -> str:
    return sha256(f"{kind}:{value}".encode()).hexdigest()


def _patched_async_client(handler):
    class _Patched(httpx.AsyncClient):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(**{k: v for k, v in kwargs.items() if k in {"transport", "timeout"}})

    return _Patched


class FakeLarkRunner:
    def __init__(self, *results: ConnectorCommandResult) -> None:
        self.results = list(results)
        self.calls: list[tuple[str, ...]] = []

    async def run(
        self,
        executable_path: str,
        args: list[str],
        *,
        timeout_seconds: float,
    ) -> ConnectorCommandResult:
        assert executable_path == "/fake/lark-cli"
        assert timeout_seconds > 0
        self.calls.append(tuple(args))
        if not self.results:
            raise AssertionError("unexpected lark runner call")
        return self.results.pop(0)

    async def run_until_url(
        self,
        executable_path: str,
        args: list[str],
        *,
        timeout_seconds: float,
    ) -> ConnectorCommandResult:
        return await self.run(executable_path, args, timeout_seconds=timeout_seconds)


@pytest.fixture
def client(monkeypatch) -> TestClient:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-lark-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.setenv("PATH", "")
    monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://localhost:8080",
        data_dir=tmp,
    )
    app = create_app(settings)
    with TestClient(app) as c:
        yield c


async def test_store_ensures_lark_connection_without_secret_columns(tmp_path: Path) -> None:
    store = await LocalStore.open(tmp_path / "local-host.db")
    try:
        connection = await store.ensure_lark_connection()
        assert connection["id"].startswith("lark_conn_")
        assert connection["provider"] == "lark"
        assert connection["status"] == "disconnected"
        assert connection["auth_mode"] == "lark_cli"
        assert connection["cloud_extraction_enabled"] is True
        assert connection["data_retention_days"] == 7
        assert connection["auto_sync_enabled"] is False
        assert connection["auto_sync_interval_minutes"] == 5

        cursor = await store._conn.execute("PRAGMA table_info(local_lark_connections)")
        columns = {row[1] for row in await cursor.fetchall()}
        assert not {"access_token", "refresh_token", "app_secret"} & columns
    finally:
        await store.close()


async def test_store_round_trips_lark_sources_and_todos(tmp_path: Path) -> None:
    store = await LocalStore.open(tmp_path / "local-host.db")
    try:
        source = await store.upsert_lark_source(
            provider_source_id_hash="source_hash_1",
            source_type="group",
            display_label="Project Alpha",
            sync_enabled=False,
        )
        assert source["provider_source_id_hash"] == "source_hash_1"
        assert source["source_type"] == "group"
        assert source["sync_enabled"] is False

        updated_source = await store.update_lark_source(source["id"], sync_enabled=True)
        assert updated_source is not None
        assert updated_source["sync_enabled"] is True

        todo = await store.create_todo_item(
            source_id=source["id"],
            source_message_ids=["msg_local_1", "msg_local_2"],
            priority="today",
            title="确认项目排期",
            summary="群里需要今天确认 Project Alpha 排期。",
            suggested_action="reply",
            confidence=0.82,
            extraction_provider="rules",
            evidence_preview="请今天确认一下排期",
        )
        assert todo["source_message_ids"] == ["msg_local_1", "msg_local_2"]

        updated_todo = await store.update_todo_item(todo["id"], status="completed")
        assert updated_todo is not None
        assert updated_todo["status"] == "completed"

        sources = await store.list_lark_sources()
        todos = await store.list_todo_items(provider="lark")
        assert [item["id"] for item in sources] == [source["id"]]
        assert [item["id"] for item in todos] == [todo["id"]]
    finally:
        await store.close()


def test_get_lark_status_returns_default_disconnected_shape(client: TestClient) -> None:
    resp = client.get("/local/v1/lark/status", headers=HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["connection"]["provider"] == "lark"
    assert body["connection"]["status"] == "disconnected"
    assert body["connection"]["tenant_label"] == ""
    assert body["connection"]["account_label"] == ""
    assert body["connection"]["auth_mode"] == "lark_cli"
    assert body["connection"]["cloud_extraction_enabled"] is True
    assert body["connection"]["last_checked_at"] is None
    assert body["connection"]["last_error_code"] == ""
    assert body["connector"]["available"] is False
    assert body["connector"]["source"] == "missing"
    assert body["connector"]["executable_path"] is None


def test_lark_status_requires_pairing_token(client: TestClient) -> None:
    resp = client.get("/local/v1/lark/status")
    assert resp.status_code == 401


def test_lark_sources_and_todos_endpoints_return_empty_lists(client: TestClient) -> None:
    sources_resp = client.get("/local/v1/lark/sources", headers=HEADERS)
    todos_resp = client.get("/local/v1/todos?provider=lark", headers=HEADERS)

    assert sources_resp.status_code == 200
    assert sources_resp.json() == {"sources": []}
    assert todos_resp.status_code == 200
    assert todos_resp.json() == {"todos": []}


def test_lark_source_discovery_imports_chats_without_fetching_messages(monkeypatch) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-lark-discover-sources-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.setenv("PATH", "")
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://localhost:8080",
        data_dir=tmp,
    )
    runner = FakeLarkRunner(
        ConnectorCommandResult(
            returncode=0,
            stdout=(
                '{"ok":true,"identity":"user","data":{"chats":['
                '{"chat_id":"oc_direct","name":"张三","chat_mode":"p2p"},'
                '{"chat_id":"oc_group","name":"项目群","chat_mode":"group"}]}}'
            ),
            stderr="",
        )
    )
    app = create_app(settings)
    app.state.lark_connector_factory = lambda: LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    with TestClient(app) as c:
        c.portal.call(lambda: c.app.state.store.update_lark_connection(status="connected"))
        resp = c.post("/local/v1/lark/sources/discover", headers=HEADERS)

    assert resp.status_code == 200
    sources = resp.json()["sources"]
    assert [source["display_label"] for source in sources] == ["张三", "项目群"]
    assert [source["source_type"] for source in sources] == ["p2p", "group"]
    assert [source["sync_enabled"] for source in sources] == [False, False]
    assert runner.calls == [
        (
            "im",
            "+chat-list",
            "--as",
            "user",
            "--types",
            "p2p,group",
            "--sort",
            "active_time",
            "--page-size",
            "100",
            "--format",
            "json",
        )
    ]


def test_lark_connection_patch_persists_cloud_extraction_preference(client: TestClient) -> None:
    patch_resp = client.patch(
        "/local/v1/lark/connection",
        headers=HEADERS,
        json={"cloud_extraction_enabled": True},
    )
    status_resp = client.get("/local/v1/lark/status", headers=HEADERS)

    assert patch_resp.status_code == 200
    assert patch_resp.json()["cloud_extraction_enabled"] is True
    assert status_resp.json()["connection"]["cloud_extraction_enabled"] is True


def test_lark_connection_patch_persists_privacy_and_auto_sync_preferences(
    client: TestClient,
) -> None:
    patch_resp = client.patch(
        "/local/v1/lark/connection",
        headers=HEADERS,
        json={
            "data_retention_days": 3,
            "auto_sync_enabled": True,
            "auto_sync_interval_minutes": 2,
        },
    )
    status_resp = client.get("/local/v1/lark/status", headers=HEADERS)

    assert patch_resp.status_code == 200
    assert patch_resp.json()["data_retention_days"] == 3
    assert patch_resp.json()["auto_sync_enabled"] is True
    assert patch_resp.json()["auto_sync_interval_minutes"] == 2
    assert status_resp.json()["connection"]["data_retention_days"] == 3
    assert status_resp.json()["connection"]["auto_sync_enabled"] is True
    assert status_resp.json()["connection"]["auto_sync_interval_minutes"] == 2


def test_lark_source_and_todo_updates_return_404_for_missing_records(
    client: TestClient,
) -> None:
    source_resp = client.patch(
        "/local/v1/lark/sources/missing-source",
        headers=HEADERS,
        json={"sync_enabled": True},
    )
    todo_resp = client.patch(
        "/local/v1/todos/missing-todo",
        headers=HEADERS,
        json={"status": "completed"},
    )

    assert source_resp.status_code == 404
    assert todo_resp.status_code == 404


def test_todo_quote_endpoint_returns_local_redacted_context(client: TestClient) -> None:
    store = client.app.state.store
    source = client.portal.call(
        lambda: store.upsert_lark_source(
            provider_source_id_hash="source_hash_quote",
            source_type="group",
            display_label="合同群",
            sync_enabled=True,
        )
    )
    todo = client.portal.call(
        lambda: store.create_todo_item(
            source_id=source["id"],
            source_message_ids=["msg_local_quote"],
            priority="now",
            title="确认合同",
            summary="今天需要回复合同评审。",
            suggested_action="reply",
            confidence=0.91,
            extraction_provider="rules",
            evidence_preview="请今天回复 [email] 的合同评审",
        )
    )

    resp = client.post(f"/local/v1/todos/{todo['id']}/quote", headers=HEADERS, json={})

    assert resp.status_code == 200
    body = resp.json()
    assert body["todo_id"] == todo["id"]
    assert "确认合同" in body["text"]
    assert "今天需要回复合同评审。" in body["text"]
    assert "请今天回复 [email] 的合同评审" in body["text"]
    assert "@example.com" not in body["text"]


def test_lark_sources_and_todos_require_pairing_token(client: TestClient) -> None:
    assert client.get("/local/v1/lark/sources").status_code == 401
    assert (
        client.patch(
            "/local/v1/lark/connection", json={"cloud_extraction_enabled": True}
        ).status_code
        == 401
    )
    assert client.get("/local/v1/todos?provider=lark").status_code == 401
    assert client.post("/local/v1/todos/missing-todo/quote", json={}).status_code == 401


async def test_connector_status_parses_logged_in_json() -> None:
    runner = FakeLarkRunner(
        ConnectorCommandResult(
            returncode=0,
            stdout='{"tenant_name":"ColdFlame","user_email":"me@example.com"}',
            stderr="",
        )
    )
    connector = LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    status = await connector.probe_auth_status()

    assert runner.calls == [("auth", "status", "--json")]
    assert status.status == "connected"
    assert status.tenant_label == "ColdFlame"
    assert status.account_label == "me@example.com"


async def test_connector_status_maps_missing_login_to_needs_auth() -> None:
    runner = FakeLarkRunner(ConnectorCommandResult(returncode=1, stdout="", stderr="not logged in"))
    connector = LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    status = await connector.probe_auth_status()

    assert status.status == "needs_auth"
    assert status.last_error_code == "lark_auth_required"


async def test_connector_status_maps_not_configured_to_needs_auth() -> None:
    runner = FakeLarkRunner(
        ConnectorCommandResult(
            returncode=3,
            stdout='{"ok":false,"error":{"type":"config","subtype":"not_configured","message":"not configured"}}',
            stderr="",
        )
    )
    connector = LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    status = await connector.probe_auth_status()

    assert runner.calls == [("auth", "status", "--json")]
    assert status.status == "needs_auth"
    assert status.last_error_code == "lark_auth_required"


async def test_connector_status_requires_user_identity_for_lark_sync() -> None:
    runner = FakeLarkRunner(
        ConnectorCommandResult(
            returncode=0,
            stdout=(
                '{"identities":{"bot":{"available":true},'
                '"user":{"available":false,"message":"need_user_authorization"}}}'
            ),
            stderr="",
        )
    )
    connector = LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    status = await connector.probe_auth_status()

    assert status.status == "needs_auth"
    assert status.last_error_code == "lark_user_auth_required"


async def test_connector_login_uses_no_wait_and_returns_authorization_url() -> None:
    runner = FakeLarkRunner(
        ConnectorCommandResult(
            returncode=0,
            stdout='{"authorization_url":"https://accounts.example.test/auth","device_code":"dev-1"}',
            stderr="",
        )
    )
    connector = LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    result = await connector.start_login()

    assert runner.calls == [
        ("auth", "login", "--recommend", "--scope", LARK_IM_SCOPE_ARG, "--no-wait", "--json")
    ]
    assert result.status == "needs_auth"
    assert result.authorization_url == "https://accounts.example.test/auth"
    assert result.device_code == "dev-1"


async def test_connector_complete_login_exchanges_device_code_and_probes_user_status() -> None:
    runner = FakeLarkRunner(
        ConnectorCommandResult(returncode=0, stdout="{}", stderr=""),
        ConnectorCommandResult(
            returncode=0,
            stdout=(
                '{"tenant_name":"ColdFlame","user_email":"me@example.com",'
                '"identities":{"user":{"available":true}}}'
            ),
            stderr="",
        ),
    )
    connector = LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    status = await connector.complete_login("dev-1")

    assert runner.calls == [
        ("auth", "login", "--device-code", "dev-1", "--json"),
        ("auth", "status", "--json"),
    ]
    assert status.status == "connected"
    assert status.tenant_label == "ColdFlame"
    assert status.account_label == "me@example.com"


async def test_connector_login_requests_im_scopes_for_local_todo_sync() -> None:
    runner = FakeLarkRunner(
        ConnectorCommandResult(
            returncode=0,
            stdout='{"authorization_url":"https://accounts.example.test/auth"}',
            stderr="",
        )
    )
    connector = LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    await connector.start_login()

    call = runner.calls[0]
    assert "--scope" in call
    requested_scopes = call[call.index("--scope") + 1].split()
    assert "im:chat:read" in requested_scopes
    assert "im:message.group_msg:get_as_user" in requested_scopes
    assert "im:message.p2p_msg:get_as_user" in requested_scopes
    assert "contact:user.base:readonly" in requested_scopes


async def test_connector_login_initializes_config_when_cli_is_not_configured() -> None:
    runner = FakeLarkRunner(
        ConnectorCommandResult(
            returncode=3,
            stdout='{"ok":false,"error":{"subtype":"not_configured","message":"not configured"}}',
            stderr="",
        ),
        ConnectorCommandResult(
            returncode=0,
            stdout="Open this URL to continue: https://open.feishu.cn/cli/setup?code=abc",
            stderr="",
        ),
    )
    connector = LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    result = await connector.start_login()

    assert runner.calls == [
        ("auth", "login", "--recommend", "--scope", LARK_IM_SCOPE_ARG, "--no-wait", "--json"),
        ("config", "init", "--new", "--brand", "feishu", "--lang", "zh"),
    ]
    assert result.status == "needs_auth"
    assert result.authorization_url == "https://open.feishu.cn/cli/setup?code=abc"
    assert result.last_error_code == "lark_config_required"


async def test_connector_login_reports_config_init_failure_without_setup_url() -> None:
    runner = FakeLarkRunner(
        ConnectorCommandResult(
            returncode=3,
            stdout='{"ok":false,"error":{"subtype":"not_configured","message":"not configured"}}',
            stderr="",
        ),
        ConnectorCommandResult(returncode=1, stdout="", stderr="config init failed"),
    )
    connector = LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    result = await connector.start_login()

    assert result.status == "error"
    assert result.last_error_code == "lark_config_init_failed"


async def test_connector_logout_runs_auth_logout() -> None:
    runner = FakeLarkRunner(ConnectorCommandResult(returncode=0, stdout="{}", stderr=""))
    connector = LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    result = await connector.logout()

    assert runner.calls == [("auth", "logout", "--json")]
    assert result.status == "disconnected"


async def test_connector_logout_is_idempotent_when_not_logged_in() -> None:
    runner = FakeLarkRunner(ConnectorCommandResult(returncode=1, stdout="", stderr="not logged in"))
    connector = LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    result = await connector.logout()

    assert runner.calls == [("auth", "logout", "--json")]
    assert result.status == "disconnected"


async def test_connector_fetches_sources_then_messages_with_read_only_commands() -> None:
    runner = FakeLarkRunner(
        ConnectorCommandResult(
            returncode=0,
            stdout='{"items":[{"chat_id":"oc_alpha","name":"Project Alpha","chat_type":"group"}]}',
            stderr="",
        ),
        ConnectorCommandResult(
            returncode=0,
            stdout=(
                '{"items":[{"message_id":"om_1","msg_type":"text",'
                '"sender":{"id":"ou_sender"},'
                '"body":{"content":"{\\"text\\":\\"请今天确认 Project Alpha 排期\\"}"},'
                '"create_time":"2026-06-15T09:00:00+08:00"}]}'
            ),
            stderr="",
        ),
    )
    connector = LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    sources = await connector.fetch_recent_im_sources(chat_limit=1)
    snapshot = await connector.fetch_recent_im_messages_for_sources(
        sources,
        messages_per_chat=2,
    )

    assert runner.calls == [
        (
            "im",
            "+chat-list",
            "--as",
            "user",
            "--types",
            "p2p,group",
            "--sort",
            "active_time",
            "--page-size",
            "1",
            "--format",
            "json",
        ),
        (
            "im",
            "+chat-messages-list",
            "--as",
            "user",
            "--chat-id",
            "oc_alpha",
            "--page-size",
            "2",
            "--order",
            "desc",
            "--format",
            "json",
            "--no-reactions",
        ),
    ]
    assert sources[0].provider_source_id == "oc_alpha"
    assert sources[0].display_label == "Project Alpha"
    assert sources[0].source_type == "group"
    assert snapshot.sources == sources
    assert snapshot.messages[0].source_provider_id == "oc_alpha"
    assert snapshot.messages[0].provider_message_id == "om_1"
    assert snapshot.messages[0].sender_id == "ou_sender"
    assert snapshot.messages[0].message_type == "text"
    assert snapshot.messages[0].created_at_lark == "2026-06-15T09:00:00+08:00"


async def test_connector_parses_current_lark_cli_data_chats_and_messages_shape() -> None:
    runner = FakeLarkRunner(
        ConnectorCommandResult(
            returncode=0,
            stdout=(
                '{"ok":true,"identity":"user","data":{"chats":['
                '{"chat_id":"oc_direct","name":"张三","chat_mode":"p2p"}]}}'
            ),
            stderr="",
        ),
        ConnectorCommandResult(
            returncode=0,
            stdout=(
                '{"ok":true,"identity":"user","data":{"messages":['
                '{"message_id":"om_direct_1","msg_type":"text",'
                '"sender":{"id":"ou_sender"},'
                '"content":"{\\"text\\":\\"明天下午之前交一份 lark cli的连接优化方案。\\"}",'
                '"create_time":"2026-06-15T21:00:00+08:00"}]}}'
            ),
            stderr="",
        ),
    )
    connector = LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    sources = await connector.fetch_recent_im_sources(chat_limit=1)
    snapshot = await connector.fetch_recent_im_messages_for_sources(
        sources,
        messages_per_chat=2,
    )

    assert len(sources) == 1
    assert sources[0].provider_source_id == "oc_direct"
    assert sources[0].source_type == "p2p"
    assert len(snapshot.messages) == 1
    assert snapshot.messages[0].provider_message_id == "om_direct_1"


async def test_connector_fetch_sources_reports_missing_lark_scopes() -> None:
    runner = FakeLarkRunner(
        ConnectorCommandResult(
            returncode=3,
            stdout="",
            stderr=(
                '{"ok":false,"error":{"type":"authentication","subtype":"token_missing",'
                '"message":"need_user_authorization",'
                '"hint":"current command requires scope(s): im:chat:read"}}'
            ),
        )
    )
    connector = LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    with pytest.raises(RuntimeError, match="lark_auth_scope_required"):
        await connector.fetch_recent_im_sources(chat_limit=1)


async def test_store_prunes_lark_messages_older_than_retention_days(
    tmp_path: Path,
) -> None:
    store = await LocalStore.open(tmp_path / "local-host.db")
    try:
        await store.update_lark_connection(data_retention_days=7)
        source = await store.upsert_lark_source(
            provider_source_id_hash="source_hash_retention",
            source_type="group",
            display_label="项目群",
            sync_enabled=True,
        )
        old_raw = tmp_path / "old-lark-message.json"
        old_raw.write_text("{}", encoding="utf-8")
        old_message = await store.create_lark_message(
            source_id=source["id"],
            provider_message_id_hash="message_hash_old",
            sender_hash="sender_hash_retention",
            message_type="text",
            text="旧消息",
            redacted_text="旧消息",
            raw_json_path=str(old_raw),
        )
        new_message = await store.create_lark_message(
            source_id=source["id"],
            provider_message_id_hash="message_hash_new",
            sender_hash="sender_hash_retention",
            message_type="text",
            text="新消息",
            redacted_text="新消息",
        )
        await store._conn.execute(
            "UPDATE local_lark_messages SET received_at = ? WHERE id = ?",
            ("2000-01-01T00:00:00+00:00", old_message["id"]),
        )
        await store._conn.commit()

        deleted = await store.prune_lark_messages()
        remaining = await store.list_lark_messages_for_sync(limit=10)

        assert deleted == 1
        assert [message["id"] for message in remaining] == [new_message["id"]]
        assert not old_raw.exists()
    finally:
        await store.close()


def test_lark_auto_sync_dispatcher_runs_due_cloud_sync(monkeypatch) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-lark-auto-sync-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.setenv("PATH", "")
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://localhost:8080",
        SHEJANE_CLOUD_TOKEN="cloud-jwt",
        data_dir=tmp,
    )
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read()
        payload = json.loads(captured["body"].decode("utf-8"))
        candidate_id = payload["candidates"][0]["id"]
        return httpx.Response(
            200,
            json={
                "code": 0,
                "message": "ok",
                "data": {
                    "requestId": "req_auto_sync",
                    "provider": "cloud_redacted",
                    "todos": [
                        {
                            "candidateId": candidate_id,
                            "title": "确认 Project Alpha 排期",
                            "summary": "需要在 2026年6月15日 18:00 前确认 Project Alpha 排期。",
                            "priority": "today",
                            "dueAt": "2026-06-15T18:00:00+08:00",
                            "suggestedAction": "reply",
                            "confidence": 0.9,
                        }
                    ],
                },
            },
        )

    monkeypatch.setattr(
        "local_host.lark.extractors.httpx.AsyncClient", _patched_async_client(handler)
    )
    runner = FakeLarkRunner(
        ConnectorCommandResult(
            returncode=0,
            stdout='{"items":[{"chat_id":"oc_alpha","name":"Project Alpha","chat_type":"group"}]}',
            stderr="",
        ),
        ConnectorCommandResult(
            returncode=0,
            stdout=(
                '{"items":[{"message_id":"om_auto_1","msg_type":"text",'
                '"sender":{"id":"ou_sender"},'
                '"body":{"content":"{\\"text\\":\\"请今天确认 Project Alpha 排期\\"}"},'
                '"create_time":"2026-06-15T09:00:00+08:00"}]}'
            ),
            stderr="",
        ),
    )
    app = create_app(settings)
    app.state.lark_connector_factory = lambda: LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    with TestClient(app) as c:
        store = c.app.state.store
        c.portal.call(
            lambda: store.update_lark_connection(
                status="connected",
                auto_sync_enabled=True,
                auto_sync_interval_minutes=1,
            )
        )
        c.portal.call(
            lambda: store.upsert_lark_source(
                provider_source_id_hash=_stable_lark_hash("source", "oc_alpha"),
                source_type="group",
                display_label="Project Alpha",
                sync_enabled=True,
            )
        )
        dispatcher = LarkAutoSyncDispatcher(c.app, poll_interval_seconds=0.1)
        ran = c.portal.call(lambda: dispatcher.tick(now=datetime(2026, 6, 15, 10, 0, tzinfo=UTC)))
        todos_resp = c.get("/local/v1/todos?provider=lark", headers=HEADERS)
        connection = c.portal.call(lambda: store.ensure_lark_connection())

    assert ran is True
    assert runner.calls[0][:2] == ("im", "+chat-list")
    assert runner.calls[1][:2] == ("im", "+chat-messages-list")
    todos = todos_resp.json()["todos"]
    assert len(todos) == 1
    assert todos[0]["title"] == "确认 Project Alpha 排期"
    assert todos[0]["extraction_provider"] == "cloud_redacted"
    payload = json.loads(captured["body"].decode("utf-8"))
    assert payload["candidates"][0]["source_label"] == "chat_1"
    assert connection["last_auto_synced_at"] is not None


def test_lark_sync_marks_connection_needs_auth_when_cli_scopes_are_missing(monkeypatch) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-lark-sync-auth-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.setenv("PATH", "")
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://localhost:8080",
        data_dir=tmp,
    )
    runner = FakeLarkRunner(
        ConnectorCommandResult(
            returncode=3,
            stdout="",
            stderr=(
                '{"ok":false,"error":{"type":"authentication","subtype":"token_missing",'
                '"message":"need_user_authorization",'
                '"hint":"current command requires scope(s): im:chat:read"}}'
            ),
        )
    )
    app = create_app(settings)
    app.state.lark_connector_factory = lambda: LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    with TestClient(app) as c:
        store = c.app.state.store
        c.portal.call(lambda: store.update_lark_connection(status="connected"))
        sync_resp = c.post(
            "/local/v1/lark/sync",
            headers=HEADERS,
            json={"limit": 10, "extraction_provider": "rules"},
        )
        connection = c.portal.call(lambda: store.ensure_lark_connection())

    assert sync_resp.status_code == 409
    assert sync_resp.json()["detail"] == "lark_auth_scope_required"
    assert connection["status"] == "needs_auth"
    assert connection["last_error_code"] == "lark_auth_scope_required"


def test_lark_sync_creates_todo_from_current_cli_shape_for_direct_message(monkeypatch) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-lark-sync-current-cli-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.setenv("PATH", "")
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://localhost:8080",
        data_dir=tmp,
    )
    runner = FakeLarkRunner(
        ConnectorCommandResult(
            returncode=0,
            stdout=(
                '{"ok":true,"identity":"user","data":{"chats":['
                '{"chat_id":"oc_direct","name":"张三","chat_mode":"p2p"}]}}'
            ),
            stderr="",
        ),
        ConnectorCommandResult(
            returncode=0,
            stdout=(
                '{"ok":true,"identity":"user","data":{"chats":['
                '{"chat_id":"oc_direct","name":"张三","chat_mode":"p2p"}]}}'
            ),
            stderr="",
        ),
        ConnectorCommandResult(
            returncode=0,
            stdout=(
                '{"ok":true,"identity":"user","data":{"messages":['
                '{"message_id":"om_direct_1","msg_type":"text",'
                '"sender":{"id":"ou_sender"},'
                '"content":"{\\"text\\":\\"明天下午之前交一份 lark cli的连接优化方案。\\"}",'
                '"create_time":"2026-06-15T21:00:00+08:00"}]}}'
            ),
            stderr="",
        ),
    )
    app = create_app(settings)
    app.state.lark_connector_factory = lambda: LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    with TestClient(app) as c:
        c.portal.call(lambda: c.app.state.store.update_lark_connection(status="connected"))
        discover_resp = c.post("/local/v1/lark/sources/discover", headers=HEADERS)
        source_id = discover_resp.json()["sources"][0]["id"]
        c.patch(
            f"/local/v1/lark/sources/{source_id}",
            headers=HEADERS,
            json={"sync_enabled": True},
        )
        sync_resp = c.post(
            "/local/v1/lark/sync",
            headers=HEADERS,
            json={"limit": 10, "extraction_provider": "rules"},
        )
        todos_resp = c.get("/local/v1/todos?provider=lark", headers=HEADERS)
        sources = c.portal.call(lambda: c.app.state.store.list_lark_sources())

    assert discover_resp.status_code == 200
    assert sync_resp.status_code == 200
    assert sync_resp.json()["processed_messages"] == 1
    assert sync_resp.json()["created_todos"] == 1
    assert sources[0]["sync_enabled"] is True
    todos = todos_resp.json()["todos"]
    assert len(todos) == 1
    assert todos[0]["title"] == "明天下午之前交一份 lark cli的连接优化方案。"
    assert todos[0]["priority"] == "later"


def test_lark_connect_and_disconnect_update_local_connection(monkeypatch) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-lark-connect-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.setenv("PATH", "")
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://localhost:8080",
        data_dir=tmp,
    )
    runner = FakeLarkRunner(
        ConnectorCommandResult(
            returncode=0,
            stdout='{"authorization_url":"https://accounts.example.test/auth"}',
            stderr="",
        ),
        ConnectorCommandResult(returncode=0, stdout="{}", stderr=""),
    )
    app = create_app(settings)
    app.state.lark_connector_factory = lambda: LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    with TestClient(app) as c:
        connect_resp = c.post("/local/v1/lark/connect", headers=HEADERS)
        disconnect_resp = c.post("/local/v1/lark/disconnect", headers=HEADERS)

    assert connect_resp.status_code == 200
    assert connect_resp.json()["connection"]["status"] == "needs_auth"
    assert connect_resp.json()["authorization_url"] == "https://accounts.example.test/auth"
    assert disconnect_resp.status_code == 200
    assert disconnect_resp.json()["connection"]["status"] == "disconnected"
    assert runner.calls == [
        ("auth", "login", "--recommend", "--scope", LARK_IM_SCOPE_ARG, "--no-wait", "--json"),
        ("auth", "logout", "--json"),
    ]


def test_lark_connect_completes_device_code_in_background(monkeypatch) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-lark-connect-device-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.setenv("PATH", "")
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://localhost:8080",
        data_dir=tmp,
    )
    runner = FakeLarkRunner(
        ConnectorCommandResult(
            returncode=0,
            stdout='{"authorization_url":"https://accounts.example.test/auth","device_code":"dev-1"}',
            stderr="",
        ),
        ConnectorCommandResult(returncode=0, stdout="{}", stderr=""),
        ConnectorCommandResult(
            returncode=0,
            stdout=(
                '{"tenant_name":"ColdFlame","user_email":"me@example.com",'
                '"identities":{"user":{"available":true}}}'
            ),
            stderr="",
        ),
    )
    app = create_app(settings)
    app.state.lark_connector_factory = lambda: LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    with TestClient(app) as c:
        connect_resp = c.post("/local/v1/lark/connect", headers=HEADERS)
        c.portal.call(lambda: asyncio.sleep(0.05))
        connection = c.portal.call(lambda: c.app.state.store.ensure_lark_connection())

    assert connect_resp.status_code == 200
    assert connect_resp.json()["connection"]["status"] == "needs_auth"
    assert connect_resp.json()["device_code"] == "dev-1"
    assert connection["status"] == "connected"
    assert connection["tenant_label"] == "ColdFlame"
    assert connection["account_label"] == "me@example.com"
    assert runner.calls == [
        ("auth", "login", "--recommend", "--scope", LARK_IM_SCOPE_ARG, "--no-wait", "--json"),
        ("auth", "login", "--device-code", "dev-1", "--json"),
        ("auth", "status", "--json"),
    ]


def test_lark_disconnect_clears_local_lark_cache(monkeypatch) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-lark-disconnect-cache-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.setenv("PATH", "")
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://localhost:8080",
        data_dir=tmp,
    )
    runner = FakeLarkRunner(ConnectorCommandResult(returncode=0, stdout="{}", stderr=""))
    app = create_app(settings)
    app.state.lark_connector_factory = lambda: LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    with TestClient(app) as c:
        store = c.app.state.store
        source = c.portal.call(
            lambda: store.upsert_lark_source(
                provider_source_id_hash="source_hash_disconnect",
                source_type="group",
                display_label="项目群",
                sync_enabled=True,
            )
        )
        message = c.portal.call(
            lambda: store.create_lark_message(
                source_id=source["id"],
                provider_message_id_hash="message_hash_disconnect",
                sender_hash="sender_hash_disconnect",
                message_type="text",
                text="请今天确认排期",
                redacted_text="请今天确认排期",
            )
        )
        c.portal.call(
            lambda: store.create_todo_item(
                source_id=source["id"],
                source_message_ids=[message["id"]],
                priority="today",
                title="确认排期",
                summary="",
                suggested_action="reply",
                extraction_provider="rules",
                evidence_preview="请今天确认排期",
            )
        )

        disconnect_resp = c.post("/local/v1/lark/disconnect", headers=HEADERS)
        sources_resp = c.get("/local/v1/lark/sources", headers=HEADERS)
        todos_resp = c.get("/local/v1/todos?provider=lark", headers=HEADERS)

    assert disconnect_resp.status_code == 200
    assert disconnect_resp.json()["connection"]["status"] == "disconnected"
    assert sources_resp.json()["sources"] == []
    assert todos_resp.json()["todos"] == []


def test_lark_status_probes_available_connector(monkeypatch) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-lark-status-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.setenv("PATH", "")
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://localhost:8080",
        data_dir=tmp,
    )
    runner = FakeLarkRunner(
        ConnectorCommandResult(
            returncode=0,
            stdout='{"tenant_name":"ColdFlame","user_email":"me@example.com"}',
            stderr="",
        )
    )
    app = create_app(settings)
    app.state.lark_connector_factory = lambda: LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    with TestClient(app) as c:
        resp = c.get("/local/v1/lark/status", headers=HEADERS)

    assert resp.status_code == 200
    body = resp.json()
    assert body["connection"]["status"] == "connected"
    assert body["connection"]["tenant_label"] == "ColdFlame"
    assert body["connection"]["account_label"] == "me@example.com"
    assert runner.calls == [("auth", "status", "--json")]


def test_discovers_bundled_windows_lark_cli(tmp_path: Path) -> None:
    from local_host.lark.connector import discover_lark_connector

    bundled_dir = tmp_path / "resources" / "connectors" / "lark" / "win32-x64"
    bundled_dir.mkdir(parents=True)
    bundled = bundled_dir / "lark-cli.exe"
    bundled.write_text("", encoding="utf-8")

    status = discover_lark_connector(
        resources_path=tmp_path / "resources",
        path_env="",
        platform_name="win32",
        arch="x64",
    )

    assert status.available is True
    assert status.source == "bundled"
    assert status.executable_path == str(bundled)


def test_discovers_system_windows_lark_cli_when_bundle_missing(tmp_path: Path) -> None:
    from local_host.lark.connector import discover_lark_connector

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    system_cli = bin_dir / "lark-cli.exe"
    system_cli.write_text("", encoding="utf-8")

    status = discover_lark_connector(
        resources_path=tmp_path / "missing-resources",
        path_env=str(bin_dir),
        platform_name="win32",
        arch="x64",
    )

    assert status.available is True
    assert status.source == "system"
    assert status.executable_path == str(system_cli)


def test_connector_discovery_reports_missing_without_shell_lookup(tmp_path: Path) -> None:
    from local_host.lark.connector import discover_lark_connector

    status = discover_lark_connector(
        resources_path=tmp_path / "missing-resources",
        path_env="",
        platform_name="win32",
        arch="x64",
    )

    assert status.available is False
    assert status.source == "missing"
    assert status.executable_path is None


def test_discovers_bundled_macos_lark_cli(tmp_path: Path) -> None:
    from local_host.lark.connector import discover_lark_connector

    bundled_dir = tmp_path / "resources" / "connectors" / "lark" / "darwin-arm64"
    bundled_dir.mkdir(parents=True)
    bundled = bundled_dir / "lark-cli"
    bundled.write_text("", encoding="utf-8")

    status = discover_lark_connector(
        resources_path=tmp_path / "resources",
        path_env="",
        platform_name="darwin",
        arch="arm64",
    )

    assert status.available is True
    assert status.source == "bundled"
    assert status.executable_path == str(bundled)
