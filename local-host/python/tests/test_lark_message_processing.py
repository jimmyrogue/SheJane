from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from local_host.config import reset_settings_for_tests
from local_host.lark.candidates import classify_lark_candidate
from local_host.lark.connector import (
    ConnectorCommandResult,
    LarkConnector,
    LarkConnectorStatus,
)
from local_host.lark.extractors import (
    CloudRedactedTodoExtractor,
    TodoExtractionCandidate,
)
from local_host.lark.normalize import normalize_lark_message
from local_host.server import create_app

HEADERS = {"Authorization": "Bearer tok"}


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


def _patched_async_client(handler):
    class _Patched(httpx.AsyncClient):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(**{k: v for k, v in kwargs.items() if k in {"transport", "timeout"}})

    return _Patched


def test_normalizes_text_post_interactive_and_media_messages() -> None:
    assert (
        normalize_lark_message(
            {
                "message_type": "text",
                "body": {"content": '{"text":"请今天确认排期"}'},
            }
        ).text
        == "请今天确认排期"
    )

    post = normalize_lark_message(
        {
            "message_type": "post",
            "body": {
                "content": {
                    "zh_cn": {
                        "title": "项目更新",
                        "content": [[{"tag": "text", "text": "请 review PR"}]],
                    }
                }
            },
        }
    )
    assert post.text == "项目更新\n请 review PR"

    interactive = normalize_lark_message(
        {
            "message_type": "interactive",
            "body": {
                "content": {
                    "header": {"title": {"content": "审批提醒"}},
                    "elements": [{"tag": "div", "text": {"content": "请今天处理"}}],
                }
            },
        }
    )
    assert interactive.text == "审批提醒\n请今天处理"

    assert normalize_lark_message({"message_type": "file"}).text == "[file]"


def test_classifies_direct_mentions_deadlines_and_fyi() -> None:
    direct = classify_lark_candidate(
        "请今天下班前确认预算初稿？",
        source_type="p2p",
        mentions_user=False,
        high_priority_source=False,
    )
    assert direct.is_actionable is True
    assert direct.priority == "now"
    assert "deadline" in direct.reasons
    assert "request" in direct.reasons

    mentioned = classify_lark_candidate(
        "@小明 帮忙 review 一下 PR",
        source_type="group",
        mentions_user=True,
        high_priority_source=False,
    )
    assert mentioned.is_actionable is True
    assert mentioned.priority == "today"
    assert "mention" in mentioned.reasons

    fyi = classify_lark_candidate(
        "FYI：下周例会纪要已归档",
        source_type="group",
        mentions_user=False,
        high_priority_source=False,
    )
    assert fyi.is_actionable is False
    assert fyi.priority == "fyi"


def test_classifies_direct_submission_deadline_as_later_todo() -> None:
    candidate = classify_lark_candidate(
        "明天下午之前交一份 lark cli的连接优化方案。",
        source_type="p2p",
        mentions_user=False,
        high_priority_source=False,
    )

    assert candidate.is_actionable is True
    assert candidate.priority == "later"
    assert candidate.suggested_action == "reply"
    assert "request" in candidate.reasons
    assert "deadline" in candidate.reasons


@pytest.mark.asyncio
async def test_cloud_redacted_extractor_posts_only_redacted_candidates(monkeypatch) -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("Authorization", "")
        captured["body"] = request.read()
        return httpx.Response(
            200,
            json={
                "code": 0,
                "message": "ok",
                "data": {
                    "requestId": "req_1",
                    "provider": "cloud_redacted",
                    "todos": [
                        {
                            "candidateId": "msg_1",
                            "title": "交付 Lark CLI 连接优化方案",
                            "summary": "需要在截止时间前提交一份 Lark CLI 连接优化方案。",
                            "priority": "later",
                            "dueAt": "2026-06-16T18:00:00+08:00",
                            "suggestedAction": "reply",
                            "confidence": 0.88,
                        }
                    ],
                    "usage": {"credits_cost": 12},
                },
            },
        )

    monkeypatch.setattr(
        "local_host.lark.extractors.httpx.AsyncClient", _patched_async_client(handler)
    )
    extractor = CloudRedactedTodoExtractor(
        cloud_base_url="http://api.test",
        cloud_token="cloud-jwt",
        model="chat.fast",
    )

    result = await extractor.extract(
        [
            TodoExtractionCandidate(
                message_id="msg_1",
                source_id="source_1",
                source_label="产品群",
                source_type="group",
                raw_text="明天下午之前交一份 lark cli的连接优化方案。",
                redacted_text="明天下午之前交一份 lark cli的连接优化方案。",
                priority_hint="later",
                suggested_action="reply",
                confidence=0.75,
                created_at="2026-06-15T09:34:45+08:00",
            )
        ]
    )

    body = captured["body"].decode("utf-8")
    assert captured["url"] == "http://api.test/api/v1/agent/extract-todos"
    assert captured["auth"] == "Bearer cloud-jwt"
    assert "产品群" not in body
    payload = json.loads(body)
    assert payload["schema_version"] == "lark_todo_extract.v1"
    assert payload["source"] == "lark"
    assert payload["locale"]
    assert payload["timezone"]
    assert payload["candidates"][0]["source_label"] == "chat_1"
    assert payload["candidates"][0]["created_at"] == "2026-06-15T09:34:00+08:00"
    assert payload["candidates"][0]["due_at_hint"] == "2026-06-16T18:00:00+08:00"
    assert result.error_code is None
    assert len(result.todos) == 1
    assert result.todos[0].title == "交付 Lark CLI 连接优化方案"
    assert result.todos[0].summary == "需要在截止时间前提交一份 Lark CLI 连接优化方案。"
    assert result.todos[0].due_at == "2026-06-16T18:00:00+08:00"


@pytest.fixture
def client(monkeypatch) -> TestClient:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-lark-sync-"))
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


def test_rules_only_sync_creates_todo_from_local_lark_message(client: TestClient) -> None:
    store = client.app.state.store
    source = client.portal.call(
        lambda: store.upsert_lark_source(
            provider_source_id_hash="source_hash_1",
            source_type="p2p",
            display_label="Project Alpha",
            sync_enabled=True,
        )
    )
    client.portal.call(
        lambda: store.create_lark_message(
            source_id=source["id"],
            provider_message_id_hash="message_hash_1",
            sender_hash="sender_hash_1",
            message_type="text",
            text="请今天下班前确认 Project Alpha 排期",
            redacted_text="请今天下班前确认 Project Alpha 排期",
            created_at_lark="2026-06-15T09:00:00+08:00",
        )
    )

    sync_resp = client.post(
        "/local/v1/lark/sync",
        headers=HEADERS,
        json={"extraction_provider": "rules"},
    )
    todos_resp = client.get("/local/v1/todos?provider=lark", headers=HEADERS)

    assert sync_resp.status_code == 200
    assert sync_resp.json()["created_todos"] == 1
    assert sync_resp.json()["processed_messages"] == 1
    todos = todos_resp.json()["todos"]
    assert len(todos) == 1
    assert todos[0]["title"] == "请今天下班前确认 Project Alpha 排期"
    assert todos[0]["due_at"] == "2026-06-15T18:00:00+08:00"
    assert todos[0]["priority"] == "now"
    assert todos[0]["extraction_provider"] == "rules"


def test_rules_only_sync_merges_similar_candidates_from_same_source(client: TestClient) -> None:
    store = client.app.state.store
    source = client.portal.call(
        lambda: store.upsert_lark_source(
            provider_source_id_hash="source_hash_merge",
            source_type="p2p",
            display_label="Project Alpha",
            sync_enabled=True,
        )
    )
    first = client.portal.call(
        lambda: store.create_lark_message(
            source_id=source["id"],
            provider_message_id_hash="message_hash_merge_1",
            sender_hash="sender_hash_merge",
            message_type="text",
            text="请今天确认 Project Alpha 排期",
            redacted_text="请今天确认 Project Alpha 排期",
            created_at_lark="2026-06-15T09:00:00+08:00",
        )
    )
    second = client.portal.call(
        lambda: store.create_lark_message(
            source_id=source["id"],
            provider_message_id_hash="message_hash_merge_2",
            sender_hash="sender_hash_merge",
            message_type="text",
            text="麻烦今天确认一下 Project Alpha 排期",
            redacted_text="麻烦今天确认一下 Project Alpha 排期",
            created_at_lark="2026-06-15T09:03:00+08:00",
        )
    )

    sync_resp = client.post(
        "/local/v1/lark/sync",
        headers=HEADERS,
        json={"limit": 10, "extraction_provider": "rules"},
    )
    todos_resp = client.get("/local/v1/todos?provider=lark", headers=HEADERS)
    second_sync_resp = client.post(
        "/local/v1/lark/sync",
        headers=HEADERS,
        json={"limit": 10, "extraction_provider": "rules"},
    )

    assert sync_resp.status_code == 200
    assert sync_resp.json()["processed_messages"] == 2
    assert sync_resp.json()["created_todos"] == 1
    assert second_sync_resp.status_code == 200
    assert second_sync_resp.json()["created_todos"] == 0
    todos = todos_resp.json()["todos"]
    assert len(todos) == 1
    assert set(todos[0]["source_message_ids"]) == {first["id"], second["id"]}


def test_dismissing_todo_suppresses_similar_same_source_candidates_for_the_day(
    client: TestClient,
) -> None:
    store = client.app.state.store
    source = client.portal.call(
        lambda: store.upsert_lark_source(
            provider_source_id_hash="source_hash_dismiss",
            source_type="p2p",
            display_label="Project Alpha",
            sync_enabled=True,
        )
    )
    client.portal.call(
        lambda: store.create_lark_message(
            source_id=source["id"],
            provider_message_id_hash="message_hash_dismiss_1",
            sender_hash="sender_hash_dismiss",
            message_type="text",
            text="请今天确认 Project Alpha 排期",
            redacted_text="请今天确认 Project Alpha 排期",
            created_at_lark="2026-06-15T09:00:00+08:00",
        )
    )

    first_sync_resp = client.post(
        "/local/v1/lark/sync",
        headers=HEADERS,
        json={"limit": 10, "extraction_provider": "rules"},
    )
    first_todos = client.get("/local/v1/todos?provider=lark", headers=HEADERS).json()["todos"]
    dismiss_resp = client.patch(
        f"/local/v1/todos/{first_todos[0]['id']}",
        headers=HEADERS,
        json={"status": "dismissed"},
    )
    client.portal.call(
        lambda: store.create_lark_message(
            source_id=source["id"],
            provider_message_id_hash="message_hash_dismiss_2",
            sender_hash="sender_hash_dismiss",
            message_type="text",
            text="麻烦今天确认一下 Project Alpha 排期",
            redacted_text="麻烦今天确认一下 Project Alpha 排期",
            created_at_lark="2026-06-15T10:00:00+08:00",
        )
    )

    second_sync_resp = client.post(
        "/local/v1/lark/sync",
        headers=HEADERS,
        json={"limit": 10, "extraction_provider": "rules"},
    )
    todos_resp = client.get("/local/v1/todos?provider=lark", headers=HEADERS)

    assert first_sync_resp.status_code == 200
    assert first_sync_resp.json()["created_todos"] == 1
    assert dismiss_resp.status_code == 200
    assert dismiss_resp.json()["status"] == "dismissed"
    assert second_sync_resp.status_code == 200
    assert second_sync_resp.json()["created_todos"] == 0
    todos = todos_resp.json()["todos"]
    assert len(todos) == 1
    assert todos[0]["status"] == "dismissed"


def test_lark_redacted_preview_returns_only_safe_candidates(client: TestClient) -> None:
    store = client.app.state.store
    source = client.portal.call(
        lambda: store.upsert_lark_source(
            provider_source_id_hash="source_hash_preview",
            source_type="p2p",
            display_label="合同群",
            sync_enabled=True,
        )
    )
    client.portal.call(
        lambda: store.create_lark_message(
            source_id=source["id"],
            provider_message_id_hash="message_hash_preview",
            sender_hash="sender_hash_preview",
            message_type="text",
            text="请今天联系 alice@example.com 确认合同",
            redacted_text="请今天联系 [email] 确认合同",
            created_at_lark="2026-06-15T09:00:00+08:00",
        )
    )

    preview_resp = client.post("/local/v1/lark/preview", headers=HEADERS, json={"limit": 10})
    todos_resp = client.get("/local/v1/todos?provider=lark", headers=HEADERS)

    assert preview_resp.status_code == 200
    body = preview_resp.json()
    assert body["provider"] == "lark"
    assert body["candidate_count"] == 1
    assert body["skipped_messages"] == 0
    assert body["candidates"][0]["source_label"] == "合同群"
    assert body["candidates"][0]["redacted_text"] == "请今天联系 [email] 确认合同"
    assert "alice@example.com" not in str(body)
    assert todos_resp.json()["todos"] == []


def test_lark_cache_delete_clears_sources_messages_and_todos(client: TestClient) -> None:
    store = client.app.state.store
    connection = client.portal.call(
        lambda: store.update_lark_connection(status="connected", account_label="Jane")
    )
    source = client.portal.call(
        lambda: store.upsert_lark_source(
            provider_source_id_hash="source_hash_clear",
            source_type="group",
            display_label="项目群",
            sync_enabled=True,
        )
    )
    message = client.portal.call(
        lambda: store.create_lark_message(
            source_id=source["id"],
            provider_message_id_hash="message_hash_clear",
            sender_hash="sender_hash_clear",
            message_type="text",
            text="请今天确认排期",
            redacted_text="请今天确认排期",
            raw_json_path=str(Path(client.app.state.settings.data_dir) / "lark-raw.json"),
        )
    )
    raw_json_path = Path(message["raw_json_path"])
    raw_json_path.write_text('{"message_id":"om_raw"}', encoding="utf-8")
    client.portal.call(
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
    assert connection["status"] == "connected"

    clear_resp = client.delete("/local/v1/lark/cache", headers=HEADERS)
    sources_resp = client.get("/local/v1/lark/sources", headers=HEADERS)
    todos_resp = client.get("/local/v1/todos?provider=lark", headers=HEADERS)
    preview_resp = client.post("/local/v1/lark/preview", headers=HEADERS, json={"limit": 10})
    status_resp = client.get("/local/v1/lark/status", headers=HEADERS)

    assert clear_resp.status_code == 200
    assert clear_resp.json() == {
        "cleared": True,
        "deleted_sources": 1,
        "deleted_messages": 1,
        "deleted_todos": 1,
    }
    assert sources_resp.json()["sources"] == []
    assert todos_resp.json()["todos"] == []
    assert preview_resp.json()["candidates"] == []
    assert status_resp.json()["connection"]["account_label"] == "Jane"
    assert not raw_json_path.exists()


def test_sync_imports_recent_messages_from_lark_cli_before_extracting(monkeypatch) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-lark-cli-sync-"))
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
            stdout='{"items":[{"chat_id":"oc_alpha","name":"Project Alpha","chat_type":"group"}]}',
            stderr="",
        ),
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
    app = create_app(settings)
    app.state.lark_connector_factory = lambda: LarkConnector(
        LarkConnectorStatus(available=True, source="system", executable_path="/fake/lark-cli"),
        runner=runner,
    )

    with TestClient(app) as c:
        sync_resp = c.post(
            "/local/v1/lark/sync",
            headers=HEADERS,
            json={"limit": 10, "extraction_provider": "rules"},
        )
        sources_resp = c.get("/local/v1/lark/sources", headers=HEADERS)
        first_todos_resp = c.get("/local/v1/todos?provider=lark", headers=HEADERS)
        source_id = sources_resp.json()["sources"][0]["id"]
        enable_resp = c.patch(
            f"/local/v1/lark/sources/{source_id}",
            headers=HEADERS,
            json={"sync_enabled": True},
        )
        second_sync_resp = c.post(
            "/local/v1/lark/sync",
            headers=HEADERS,
            json={"limit": 10, "extraction_provider": "rules"},
        )
        todos_resp = c.get("/local/v1/todos?provider=lark", headers=HEADERS)

    assert sync_resp.status_code == 200
    assert sync_resp.json()["processed_messages"] == 0
    assert sync_resp.json()["created_todos"] == 0
    assert sources_resp.json()["sources"][0]["display_label"] == "Project Alpha"
    assert sources_resp.json()["sources"][0]["source_type"] == "group"
    assert sources_resp.json()["sources"][0]["sync_enabled"] is False
    assert first_todos_resp.json()["todos"] == []
    assert enable_resp.status_code == 200
    assert enable_resp.json()["sync_enabled"] is True
    assert second_sync_resp.status_code == 200
    assert second_sync_resp.json()["processed_messages"] == 1
    assert second_sync_resp.json()["created_todos"] == 1
    todos = todos_resp.json()["todos"]
    assert len(todos) == 1
    assert todos[0]["title"] == "请今天确认 Project Alpha 排期"
    assert todos[0]["priority"] == "today"
    assert runner.calls[0][:2] == ("im", "+chat-list")
    assert runner.calls[1][:2] == ("im", "+chat-list")
    assert runner.calls[2][:2] == ("im", "+chat-messages-list")


def test_cloud_redacted_sync_uses_redacted_text_and_creates_cloud_todo(monkeypatch) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-lark-cloud-sync-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.setenv("PATH", "")
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://api.test",
        SHEJANE_CLOUD_TOKEN="cloud-jwt",
        data_dir=tmp,
    )
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read()
        return httpx.Response(
            200,
            json={
                "code": 0,
                "message": "ok",
                "data": {
                    "requestId": "req_2",
                    "provider": "cloud_redacted",
                    "todos": [
                        {
                            "candidateId": captured["candidate_id"],
                            "title": "交付 Lark CLI 连接优化方案",
                            "summary": "需要在截止时间前提交一份 Lark CLI 连接优化方案。",
                            "priority": "later",
                            "dueAt": "2026-06-16T18:00:00+08:00",
                            "suggestedAction": "reply",
                            "confidence": 0.91,
                        }
                    ],
                    "usage": {"credits_cost": 8},
                },
            },
        )

    monkeypatch.setattr(
        "local_host.lark.extractors.httpx.AsyncClient", _patched_async_client(handler)
    )
    app = create_app(settings)

    with TestClient(app) as c:
        store = c.app.state.store
        source = c.portal.call(
            lambda: store.upsert_lark_source(
                provider_source_id_hash="source_hash_cloud",
                source_type="p2p",
                display_label="合同群",
                sync_enabled=True,
            )
        )
        message = c.portal.call(
            lambda: store.create_lark_message(
                source_id=source["id"],
                provider_message_id_hash="message_hash_cloud",
                sender_hash="sender_hash_cloud",
                message_type="text",
                text="明天下午之前交一份 lark cli的连接优化方案。",
                redacted_text="明天下午之前交一份 lark cli的连接优化方案。",
                created_at_lark="2026-06-15T21:23:47+08:00",
            )
        )
        captured["candidate_id"] = message["id"]

        sync_resp = c.post(
            "/local/v1/lark/sync",
            headers=HEADERS,
            json={"limit": 10, "model": "chat.fast"},
        )
        todos_resp = c.get("/local/v1/todos?provider=lark", headers=HEADERS)

    assert sync_resp.status_code == 200
    assert sync_resp.json()["extraction_provider"] == "cloud_redacted"
    assert sync_resp.json()["created_todos"] == 1
    body = captured["body"].decode("utf-8")
    assert "合同群" not in body
    payload = json.loads(body)
    assert payload["candidates"][0]["source_label"] == "chat_1"
    assert payload["candidates"][0]["due_at_hint"] == "2026-06-16T18:00:00+08:00"
    todos = todos_resp.json()["todos"]
    assert len(todos) == 1
    assert todos[0]["title"] == "交付 Lark CLI 连接优化方案"
    assert todos[0]["summary"] == "需要在截止时间前提交一份 Lark CLI 连接优化方案。"
    assert todos[0]["priority"] == "later"
    assert todos[0]["due_at"] == "2026-06-16T18:00:00+08:00"
    assert todos[0]["extraction_provider"] == "cloud_redacted"
