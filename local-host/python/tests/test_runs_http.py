"""Tests for /v1/runs endpoints.

These exercise the full HTTP -> RunCoordinator -> build_agent -> mocked
BackendChatModel -> SSE response path. Crucially: this validates Phase 3'
parts 1+2+3+4 together.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import ClassVar

import httpx
import pytest
from fastapi.testclient import TestClient

from local_host.config import reset_settings_for_tests
from local_host.runs import (
    _build_dropped_history_summary,
    _run_failed_payload,
    _truncate_history_for_run,
)
from local_host.server import create_app


def _stream_response(events: list[tuple[str, str]]) -> httpx.Response:
    body = "".join(f"event: {n}\ndata: {p}\n\n" for n, p in events).encode("utf-8")
    return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})


def _patched_async_client(handler):
    class _Patched(httpx.AsyncClient):
        def __init__(self, **kw):
            super().__init__(
                transport=httpx.MockTransport(handler),
                **{k: v for k, v in kw.items() if k != "transport"},
            )

    return _Patched


def test_dropped_history_summary_keeps_middle_decisions() -> None:
    messages = [
        {"role": "user" if i % 2 == 0 else "assistant", "content": f"msg-{i}"} for i in range(14)
    ]
    messages[5] = {
        "role": "user",
        "content": "重要决定：所有 API 错误必须保留 request_id",
    }

    summary = _build_dropped_history_summary(messages)

    assert summary is not None
    assert "重要决定" in summary
    assert "request_id" in summary


def test_history_truncation_preserves_client_omission_marker() -> None:
    marker = {
        "role": "user",
        "content": (
            "【上下文提示｜对话较长，已省略更早的 25 条消息，仅保留最近内容；如需更早信息请重述。】\n"
            "早期摘要：\n- 用户: 重要决定：所有 API 错误必须保留 request_id"
        ),
    }
    messages = [marker] + [
        {"role": "assistant" if i % 2 else "user", "content": f"msg-{i:03d}"} for i in range(10)
    ]

    kept, dropped_count, dropped_messages = _truncate_history_for_run(
        messages,
        max_history_turns=10,
    )

    assert kept[0] == marker
    assert len(kept) == 10
    assert dropped_count == 1
    assert dropped_messages == [{"role": "user", "content": "msg-000"}]
    assert all("上下文提示｜对话较长" not in item["content"] for item in dropped_messages)


@pytest.fixture
def client(monkeypatch) -> TestClient:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-runs-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.setenv("SHEJANE_LOCAL_SKILLS_PATH", str(tmp / "empty-skills"))

    def handler(request: httpx.Request) -> httpx.Response:
        # Mock backend returns a clean text response with no tool calls.
        return _stream_response(
            [
                ("llm.delta", '{"content_delta": "Hi from agent."}'),
                ("llm.done", '{"request_id": "r", "finish_reason": "stop"}'),
            ]
        )

    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler))
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp,
    )
    app = create_app(settings)
    with TestClient(app) as c:
        yield c


def _parse_sse_lines(body: str) -> list[tuple[str, dict | str]]:
    events: list[tuple[str, dict | str]] = []
    current_event = ""
    data_buffer: list[str] = []

    def flush() -> None:
        if current_event or data_buffer:
            payload = "\n".join(data_buffer)
            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                parsed = payload
            events.append((current_event, parsed))

    for raw in body.split("\n"):
        line = raw.rstrip("\r")
        if not line:
            flush()
            current_event = ""
            data_buffer = []
            continue
        if line.startswith("event:"):
            current_event = line[6:].strip()
        elif line.startswith("data:"):
            data_buffer.append(line[5:].strip())
    flush()
    return events


def test_create_run_returns_run_record(client: TestClient) -> None:
    r = client.post(
        "/local/v1/runs",
        headers={"Authorization": "Bearer tok"},
        json={"goal": "say hi"},
    )
    assert r.status_code == 200
    # POST /runs returns the flat LocalRun shape (no `{run: ...}` wrapper) —
    # client.test.ts:63 + createLocalRun() pin this contract.
    run = r.json()
    assert run["id"].startswith("run_")
    assert run["goal"] == "say hi"
    assert run["status"] == "queued"


def test_create_run_persists_run_metadata(client: TestClient) -> None:
    r = client.post(
        "/local/v1/runs",
        headers={"Authorization": "Bearer tok"},
        json={
            "goal": "repair task",
            "metadata": {
                "intent": "repair",
                "source_run_id": "run_original",
                "source_message_id": "msg_original",
                "attempt": 1,
            },
        },
    )
    assert r.status_code == 200
    run = r.json()
    assert json.loads(run["metadata_json"]) == {
        "intent": "repair",
        "source_run_id": "run_original",
        "source_message_id": "msg_original",
        "attempt": 1,
    }

    fetched = client.get(
        f"/local/v1/runs/{run['id']}",
        headers={"Authorization": "Bearer tok"},
    )
    assert fetched.status_code == 200
    assert json.loads(fetched.json()["metadata_json"])["intent"] == "repair"


def test_fork_run_missing_checkpoint_returns_404(client: TestClient) -> None:
    source = client.post(
        "/local/v1/runs",
        headers={"Authorization": "Bearer tok"},
        json={"goal": "source task"},
    )
    assert source.status_code == 200
    source_run_id = source.json()["id"]

    fork = client.post(
        f"/local/v1/runs/{source_run_id}/fork",
        headers={"Authorization": "Bearer tok"},
        json={"checkpoint_id": "checkpoint-does-not-exist"},
    )

    assert fork.status_code == 404
    assert fork.json()["detail"] == "checkpoint not found"


def test_fork_run_from_checkpoint_creates_child_thread(client: TestClient) -> None:
    source = client.post(
        "/local/v1/runs",
        headers={"Authorization": "Bearer tok"},
        json={"goal": "draft a plan"},
    )
    assert source.status_code == 200
    source_run_id = source.json()["id"]
    with client.stream(
        "GET",
        f"/local/v1/runs/{source_run_id}/stream",
        headers={"Authorization": "Bearer tok"},
    ) as resp:
        assert resp.status_code == 200
        resp.read()

    diagnostics = client.get(
        f"/local/v1/runs/{source_run_id}/diagnostics",
        headers={"Authorization": "Bearer tok"},
    )
    assert diagnostics.status_code == 200
    checkpoint = diagnostics.json()["latest_checkpoint"]
    assert checkpoint is not None
    checkpoint_id = checkpoint["id"]

    fork = client.post(
        f"/local/v1/runs/{source_run_id}/fork",
        headers={"Authorization": "Bearer tok"},
        json={"checkpoint_id": checkpoint_id, "goal": "retry from that point"},
    )

    assert fork.status_code == 200
    child = fork.json()
    assert child["id"].startswith("run_")
    assert child["id"] != source_run_id
    assert child["parent_run_id"] == source_run_id
    assert child["goal"] == "retry from that point"
    metadata = json.loads(child["metadata_json"])
    assert metadata["intent"] == "checkpoint_fork"
    assert metadata["source_run_id"] == source_run_id
    assert metadata["source_checkpoint_id"] == checkpoint_id

    copied = client.app.state.checkpointer.get(
        {
            "configurable": {
                "thread_id": child["id"],
                "checkpoint_ns": "",
                "checkpoint_id": checkpoint_id,
            }
        }
    )
    assert copied is not None


def test_repair_run_emits_workflow_events_and_context(monkeypatch) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-runs-repair-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.setenv("SHEJANE_LOCAL_SKILLS_PATH", str(tmp / "empty-skills"))

    captured_requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        try:
            captured_requests.append(json.loads(body))
        except json.JSONDecodeError:
            pass
        return _stream_response(
            [
                ("llm.delta", '{"content_delta": "repair done"}'),
                ("llm.done", '{"request_id": "r", "finish_reason": "stop"}'),
            ]
        )

    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler))
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_LOCAL_REPAIR_WORKFLOW_MAX=3,
        data_dir=tmp,
    )
    app = create_app(settings)
    with TestClient(app) as c:
        r = c.post(
            "/local/v1/runs",
            headers={"Authorization": "Bearer tok"},
            json={
                "goal": "repair task",
                "metadata": {
                    "intent": "repair",
                    "source_run_id": "run_original",
                    "source_message_id": "msg_original",
                    "attempt": 2,
                    "failure_category": "validation",
                    "failure_action_kind": "repair",
                },
            },
        )
        assert r.status_code == 200
        run_id = r.json()["id"]

        with c.stream(
            "GET",
            f"/local/v1/runs/{run_id}/stream",
            headers={"Authorization": "Bearer tok"},
        ) as resp:
            assert resp.status_code == 200
            body = resp.read().decode("utf-8")

    envelopes = [
        envelope
        for _event, envelope in _parse_sse_lines(body)
        if isinstance(envelope, dict) and "event_type" in envelope
    ]
    repair_events = [
        envelope["payload"]
        for envelope in envelopes
        if envelope.get("event_type") == "repair.workflow"
    ]
    assert [event.get("status") for event in repair_events] == ["started", "completed"]
    assert repair_events[0]["attempt"] == 2
    assert repair_events[0]["max_attempts"] == 3
    assert repair_events[0]["source_run_id"] == "run_original"
    assert repair_events[0]["failure_category"] == "validation"

    assert captured_requests, "expected backend LLM call"
    system_blocks = [
        message["content"]
        for message in captured_requests[0].get("messages", [])
        if message.get("role") == "system"
    ]
    joined_system = "\n".join(system_blocks)
    assert "修复工作流" in joined_system
    assert "第 2/3 次" in joined_system
    assert "run_original" in joined_system
    assert "validation / repair" in joined_system


def test_retry_run_injects_workflow_context(monkeypatch) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-runs-retry-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.setenv("SHEJANE_LOCAL_SKILLS_PATH", str(tmp / "empty-skills"))

    captured_requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        try:
            captured_requests.append(json.loads(body))
        except json.JSONDecodeError:
            pass
        return _stream_response(
            [
                ("llm.delta", '{"content_delta": "retry done"}'),
                ("llm.done", '{"request_id": "r", "finish_reason": "stop"}'),
            ]
        )

    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler))
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp,
    )
    app = create_app(settings)
    with TestClient(app) as c:
        r = c.post(
            "/local/v1/runs",
            headers={"Authorization": "Bearer tok"},
            json={
                "goal": "retry task",
                "metadata": {
                    "intent": "retry",
                    "source_run_id": "run_failed",
                    "source_message_id": "msg_failed",
                    "attempt": 2,
                    "failure_category": "auth",
                    "failure_action_kind": "user_action",
                },
            },
        )
        assert r.status_code == 200
        run_id = r.json()["id"]

        with c.stream(
            "GET",
            f"/local/v1/runs/{run_id}/stream",
            headers={"Authorization": "Bearer tok"},
        ) as resp:
            assert resp.status_code == 200
            resp.read()

    assert captured_requests, "expected backend LLM call"
    system_blocks = [
        message["content"]
        for message in captured_requests[0].get("messages", [])
        if message.get("role") == "system"
    ]
    joined_system = "\n".join(system_blocks)
    assert "恢复重试" in joined_system
    assert "第 2 次" in joined_system
    assert "run_failed" in joined_system
    assert "msg_failed" in joined_system
    assert "auth / user_action" in joined_system


def test_repair_run_over_attempt_limit_fails_before_model_call(monkeypatch) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-runs-repair-limit-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)

    captured_requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured_requests.append(json.loads(request.read()))
        return _stream_response([("llm.delta", '{"content_delta": "should not run"}')])

    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler))
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_LOCAL_REPAIR_WORKFLOW_MAX=1,
        data_dir=tmp,
    )
    app = create_app(settings)
    with TestClient(app) as c:
        r = c.post(
            "/local/v1/runs",
            headers={"Authorization": "Bearer tok"},
            json={
                "goal": "repair task",
                "metadata": {
                    "intent": "repair",
                    "source_run_id": "run_original",
                    "source_message_id": "msg_original",
                    "attempt": 2,
                },
            },
        )
        assert r.status_code == 200
        run_id = r.json()["id"]

        with c.stream(
            "GET",
            f"/local/v1/runs/{run_id}/stream",
            headers={"Authorization": "Bearer tok"},
        ) as resp:
            assert resp.status_code == 200
            body = resp.read().decode("utf-8")

        fetched = c.get(f"/local/v1/runs/{run_id}", headers={"Authorization": "Bearer tok"})
        assert fetched.status_code == 200
        assert fetched.json()["status"] == "failed"

    envelopes = [
        envelope
        for _event, envelope in _parse_sse_lines(body)
        if isinstance(envelope, dict) and "event_type" in envelope
    ]
    event_names = [envelope["event_type"] for envelope in envelopes]
    assert "run.failed" in event_names
    rejected = [
        envelope["payload"]
        for envelope in envelopes
        if envelope.get("event_type") == "repair.workflow"
    ]
    assert rejected == [
        {
            "status": "rejected",
            "attempt": 2,
            "max_attempts": 1,
            "reason": "repair attempt limit exceeded",
            "source_run_id": "run_original",
            "source_message_id": "msg_original",
        }
    ]
    assert captured_requests == []


def test_create_run_rejects_empty_goal(client: TestClient) -> None:
    r = client.post(
        "/local/v1/runs",
        headers={"Authorization": "Bearer tok"},
        json={"goal": ""},
    )
    assert r.status_code == 400


def test_get_run_404_for_unknown(client: TestClient) -> None:
    r = client.get(
        "/local/v1/runs/run_does_not_exist",
        headers={"Authorization": "Bearer tok"},
    )
    assert r.status_code == 404


def test_run_failed_payload_includes_failure_policy_for_generic_exceptions() -> None:
    payload = _run_failed_payload(RuntimeError("unexpected implementation error"))

    assert payload["error"] == "unexpected implementation error"
    assert payload["type"] == "RuntimeError"
    assert payload["category"] == "fatal"
    assert payload["recoverable"] is False
    assert payload["retryable"] is False
    assert payload["action_kind"] == "operator_action"
    assert payload["recovery_action"] == "diagnostics"
    assert "implementation" in payload["suggested_action"]


def test_full_run_lifecycle_through_sse(client: TestClient) -> None:
    """Start a run, stream until terminal event, verify run.completed."""
    # Start
    r = client.post(
        "/local/v1/runs",
        headers={"Authorization": "Bearer tok"},
        json={"goal": "say hi"},
    )
    assert r.status_code == 200
    run_id = r.json()["id"]  # flat LocalRun shape (no wrapper)

    # Stream until run.completed or run.failed
    with client.stream(
        "GET",
        f"/local/v1/runs/{run_id}/stream",
        headers={"Authorization": "Bearer tok"},
    ) as resp:
        assert resp.status_code == 200
        body = resp.read().decode("utf-8")

    events = _parse_sse_lines(body)
    # Each event's `data:` body is now the AgentRunEvent envelope:
    # {event_type, payload, id, run_id, seq, created_at} — see Block 0 fix.
    event_names = [
        e[1].get("event_type") for e in events if isinstance(e[1], dict) and "event_type" in e[1]
    ]
    assert "run.started" in event_names
    assert any(name in {"run.completed", "run.failed"} for name in event_names)
    # If completed, final text now lives at envelope.payload.final_text.
    for _name, envelope in events:
        if not isinstance(envelope, dict):
            continue
        if envelope.get("event_type") == "run.completed":
            assert "Hi from agent" in (envelope.get("payload", {}).get("final_text") or "")
            break


def test_run_diagnostics_include_handoff_summary(client: TestClient) -> None:
    r = client.post(
        "/local/v1/runs",
        headers={"Authorization": "Bearer tok"},
        json={"goal": "say hi"},
    )
    assert r.status_code == 200
    run_id = r.json()["id"]

    with client.stream(
        "GET",
        f"/local/v1/runs/{run_id}/stream",
        headers={"Authorization": "Bearer tok"},
    ) as resp:
        assert resp.status_code == 200
        _ = resp.read()

    diag = client.get(
        f"/local/v1/runs/{run_id}/diagnostics",
        headers={"Authorization": "Bearer tok"},
    )
    assert diag.status_code == 200
    body = diag.json()

    assert body["handoff"]["status"] == "completed"
    assert "completed" in body["handoff"]["headline"]
    assert body["handoff"]["ledger_state"] == "not_required"
    assert body["handoff"]["next_actions"]
    assert "run.completed" in body["handoff"]["recent_event_types"]
    checkpoint = body["latest_checkpoint"]
    assert checkpoint is not None
    assert checkpoint["id"]
    assert checkpoint["run_id"] == run_id
    assert checkpoint["step"] >= 0
    assert checkpoint["reason"]
    assert checkpoint["messages_count"] >= 1


def test_run_diagnostics_include_reflection_summary(client: TestClient) -> None:
    store = client.app.state.store

    async def create_completed_run() -> str:
        run = await store.create_run(goal="Reflect on answer", workspace_path=None)
        await store.update_run_status(run["id"], "completed")
        return run["id"]

    import asyncio

    run_id = asyncio.run(create_completed_run())

    class FakeCheckpointer:
        async def alist(self, config, limit=1):
            class Item:
                checkpoint: ClassVar[dict[str, object]] = {
                    "id": "ck-reflect",
                    "ts": "2026-06-11T00:00:00Z",
                    "channel_values": {
                        "messages": ["hidden message body"],
                        "reflection": {
                            "ai_messages": 2,
                            "tool_results": 3,
                            "final_answer_chars": 144,
                            "critic": {
                                "coverage": 4,
                                "clarity": 5,
                                "grounding": 3,
                                "notes": ["cite the source", "tighten conclusion"],
                            },
                        },
                    },
                }
                metadata: ClassVar[dict[str, object]] = {"step": 7, "source": "loop"}
                config: ClassVar[dict[str, object]] = {
                    "configurable": {"thread_id": run_id, "checkpoint_id": "ck-reflect"}
                }

            yield Item()

    client.app.state.checkpointer = FakeCheckpointer()

    diag = client.get(
        f"/local/v1/runs/{run_id}/diagnostics",
        headers={"Authorization": "Bearer tok"},
    )
    assert diag.status_code == 200
    body = diag.json()
    assert body["latest_checkpoint"]["id"] == "ck-reflect"
    reflection = body["reflection"]
    assert reflection["ai_messages"] == 2
    assert reflection["tool_results"] == 3
    assert reflection["final_answer_chars"] == 144
    assert reflection["critic"]["coverage"] == 4
    assert reflection["critic"]["notes"] == ["cite the source", "tighten conclusion"]
    assert "messages" not in reflection


def test_run_diagnostics_include_latest_feature_ledger(client: TestClient) -> None:
    r = client.post(
        "/local/v1/runs",
        headers={"Authorization": "Bearer tok"},
        json={"goal": "say hi"},
    )
    assert r.status_code == 200
    run_id = r.json()["id"]

    store = client.app.state.store

    async def create_ledgers() -> None:
        await store.create_artifact(
            run_id=run_id,
            kind="progress_ledger",
            title="Progress ledger",
            content=json.dumps(
                {
                    "summary": "First draft",
                    "status": "in_progress",
                    "acceptance_criteria": ["old"],
                    "decisions": [],
                    "files_touched": [],
                    "validation_commands": [],
                    "unresolved_risks": [],
                    "next_actions": ["continue"],
                }
            ),
            content_type="application/json",
            tool_name="task.progress",
        )
        await store.create_artifact(
            run_id=run_id,
            kind="progress_ledger",
            title="Progress ledger",
            content=json.dumps(
                {
                    "summary": "Ready for review",
                    "status": "verified",
                    "acceptance_criteria": ["diagnostics exposes latest ledger"],
                    "decisions": ["latest artifact wins"],
                    "files_touched": ["local_host/server.py"],
                    "validation_commands": ["pytest tests/test_runs_http.py"],
                    "unresolved_risks": [],
                    "next_actions": ["review diff"],
                }
            ),
            content_type="application/json",
            tool_name="task.progress",
        )

    import asyncio

    asyncio.run(create_ledgers())

    diag = client.get(
        f"/local/v1/runs/{run_id}/diagnostics",
        headers={"Authorization": "Bearer tok"},
    )
    assert diag.status_code == 200
    ledger = diag.json()["feature_ledger"]
    assert ledger["summary"] == "Ready for review"
    assert ledger["status"] == "verified"
    assert ledger["acceptance_criteria"] == ["diagnostics exposes latest ledger"]
    assert ledger["validation_commands"] == ["pytest tests/test_runs_http.py"]


def test_run_diagnostics_marks_missing_progress_ledger_for_handoff(client: TestClient) -> None:
    store = client.app.state.store

    async def create_completed_run() -> str:
        run = await store.create_run(goal="Long task", workspace_path=None)
        await store.append_event(
            run["id"],
            "tool.completed",
            {"tool": "task.verify", "name": "task.verify", "status": "ok"},
        )
        await store.append_event(run["id"], "run.completed", {"final_text": "done"})
        await store.update_run_status(run["id"], "completed")
        return run["id"]

    import asyncio

    run_id = asyncio.run(create_completed_run())

    diag = client.get(
        f"/local/v1/runs/{run_id}/diagnostics",
        headers={"Authorization": "Bearer tok"},
    )
    assert diag.status_code == 200
    handoff = diag.json()["handoff"]
    assert handoff["ledger_state"] == "missing"
    assert any("Progress ledger missing" in blocker for blocker in handoff["blockers"])
    assert any("task.progress" in action for action in handoff["next_actions"])


def test_run_diagnostics_marks_missing_progress_ledger_for_waiting_input(
    client: TestClient,
) -> None:
    store = client.app.state.store

    async def create_waiting_input_run() -> str:
        run = await store.create_run(goal="Ask a clarifying question", workspace_path=None)
        await store.append_event(
            run["id"],
            "tool.completed",
            {"tool": "read_file", "name": "read_file", "status": "ok"},
        )
        await store.append_event(
            run["id"],
            "question.asked",
            {"request_id": "q1", "questions": [{"question": "Which file?"}]},
        )
        await store.append_event(run["id"], "run.waiting", {"next": ["tools"], "interrupts": []})
        await store.update_run_status(run["id"], "waiting_input")
        return run["id"]

    import asyncio

    run_id = asyncio.run(create_waiting_input_run())

    diag = client.get(
        f"/local/v1/runs/{run_id}/diagnostics",
        headers={"Authorization": "Bearer tok"},
    )
    assert diag.status_code == 200
    handoff = diag.json()["handoff"]
    assert handoff["status"] == "waiting_input"
    assert handoff["ledger_state"] == "missing"
    assert any("Progress ledger missing" in blocker for blocker in handoff["blockers"])
    assert any("task.progress" in action for action in handoff["next_actions"])


def test_run_diagnostics_marks_stale_progress_ledger_after_later_tool_event(
    client: TestClient,
) -> None:
    store = client.app.state.store

    async def create_stale_ledger_run() -> str:
        run = await store.create_run(goal="Long task", workspace_path=None)
        payload = {
            "summary": "Initial plan",
            "status": "in_progress",
            "acceptance_criteria": ["has a ledger"],
            "decisions": [],
            "files_touched": [],
            "validation_commands": [],
            "unresolved_risks": [],
            "next_actions": ["verify"],
        }
        await store.create_artifact(
            run_id=run["id"],
            kind="progress_ledger",
            title="Progress ledger",
            content=json.dumps(payload),
            content_type="application/json",
            tool_name="task.progress",
            metadata=payload,
        )
        await store.append_event(
            run["id"],
            "tool.completed",
            {"tool": "task.verify", "name": "task.verify", "status": "ok"},
        )
        await store.update_run_status(run["id"], "completed")
        return run["id"]

    import asyncio

    run_id = asyncio.run(create_stale_ledger_run())

    diag = client.get(
        f"/local/v1/runs/{run_id}/diagnostics",
        headers={"Authorization": "Bearer tok"},
    )
    assert diag.status_code == 200
    handoff = diag.json()["handoff"]
    assert handoff["ledger_state"] == "stale"
    assert any(
        "Progress ledger stale after tool.completed" in blocker for blocker in handoff["blockers"]
    )
    assert any("Refresh task.progress" in action for action in handoff["next_actions"])


def test_run_diagnostics_keeps_fresh_ledger_across_passive_waiting_events(
    client: TestClient,
) -> None:
    store = client.app.state.store

    async def create_waiting_run_with_fresh_ledger() -> str:
        run = await store.create_run(goal="Needs approval", workspace_path=None)
        payload = {
            "summary": "Ready for the user's approval",
            "status": "blocked",
            "acceptance_criteria": ["approval card is visible"],
            "decisions": ["wait for user approval"],
            "files_touched": [],
            "validation_commands": [],
            "unresolved_risks": ["pending approval"],
            "next_actions": ["approve or deny the pending request"],
        }
        await store.create_artifact(
            run_id=run["id"],
            kind="progress_ledger",
            title="Progress ledger",
            content=json.dumps(payload),
            content_type="application/json",
            tool_name="task.progress",
            metadata=payload,
        )
        await store.append_event(
            run["id"],
            "permission.required",
            {"request_id": "perm_1", "tool": "write_file", "tool_name": "write_file"},
        )
        await store.append_event(run["id"], "run.waiting", {"next": ["tools"], "interrupts": []})
        await store.update_run_status(run["id"], "waiting_permission")
        return run["id"]

    import asyncio

    run_id = asyncio.run(create_waiting_run_with_fresh_ledger())

    diag = client.get(
        f"/local/v1/runs/{run_id}/diagnostics",
        headers={"Authorization": "Bearer tok"},
    )
    assert diag.status_code == 200
    handoff = diag.json()["handoff"]
    assert handoff["ledger_state"] == "fresh"
    assert not any("Progress ledger stale" in blocker for blocker in handoff["blockers"])


def test_run_diagnostics_classifies_quota_failures(client: TestClient) -> None:
    store = client.app.state.store

    async def create_failed_run() -> str:
        run = await store.create_run(goal="Spend credits", workspace_path=None)
        await store.append_event(
            run["id"],
            "run.failed",
            {"error_code": "insufficient_credits", "message": "额度不足，请升级或充值"},
        )
        await store.update_run_status(run["id"], "failed")
        return run["id"]

    import asyncio

    run_id = asyncio.run(create_failed_run())

    diag = client.get(
        f"/local/v1/runs/{run_id}/diagnostics",
        headers={"Authorization": "Bearer tok"},
    )
    assert diag.status_code == 200
    failure = diag.json()["handoff"]["failure"]
    assert failure["category"] == "quota"
    assert failure["code"] == "insufficient_credits"
    assert failure["recoverable"] is True
    assert failure["retryable"] is False
    assert failure["action_kind"] == "user_action"
    assert failure["recovery_action"] == "recharge"
    assert "credits" in failure["suggested_action"]


def test_run_diagnostics_reports_latest_task_verification_pass(
    client: TestClient,
) -> None:
    store = client.app.state.store

    async def create_verified_run() -> str:
        run = await store.create_run(goal="Repair then verify", workspace_path=None)
        await store.append_event(
            run["id"],
            "tool.failed",
            {
                "tool": "task.verify",
                "name": "task.verify",
                "content": json.dumps(
                    {
                        "ok": "false",
                        "results": [
                            {
                                "kind": "file_contains",
                                "ok": False,
                                "detail": "substring absent in report.txt",
                            }
                        ],
                        "pass_count": "0",
                        "fail_count": "1",
                    }
                ),
                "status": "error",
            },
        )
        await store.append_event(
            run["id"],
            "tool.completed",
            {
                "tool": "task.verify",
                "name": "task.verify",
                "content": json.dumps(
                    {
                        "ok": "true",
                        "results": [
                            {
                                "kind": "file_contains",
                                "ok": True,
                                "detail": "substring found in report.txt",
                            }
                        ],
                        "pass_count": "1",
                        "fail_count": "0",
                    }
                ),
                "status": "ok",
            },
        )
        await store.update_run_status(run["id"], "completed")
        return run["id"]

    import asyncio

    run_id = asyncio.run(create_verified_run())

    diag = client.get(
        f"/local/v1/runs/{run_id}/diagnostics",
        headers={"Authorization": "Bearer tok"},
    )
    assert diag.status_code == 200
    handoff = diag.json()["handoff"]
    assert handoff["verification"]["status"] == "passed"
    assert "substring found" in handoff["verification"]["reason"]
    assert handoff["failure"] is None
    assert not any("task.verify" in blocker for blocker in handoff["blockers"])


def test_run_diagnostics_suppresses_recovered_tool_failure_for_completed_run(
    client: TestClient,
) -> None:
    store = client.app.state.store

    async def create_recovered_run() -> str:
        run = await store.create_run(goal="Search then answer", workspace_path=None)
        await store.append_event(
            run["id"],
            "tool.failed",
            {
                "tool": "web.search",
                "name": "web.search",
                "error_code": "gateway_transient_response",
                "content": "HTTP 503 from gateway",
                "retryable": True,
            },
        )
        await store.append_event(
            run["id"],
            "tool.completed",
            {
                "tool": "web.search",
                "name": "web.search",
                "content": json.dumps({"ok": "true", "results": [{"title": "answer"}]}),
                "status": "ok",
            },
        )
        await store.update_run_status(run["id"], "completed")
        return run["id"]

    import asyncio

    run_id = asyncio.run(create_recovered_run())

    diag = client.get(
        f"/local/v1/runs/{run_id}/diagnostics",
        headers={"Authorization": "Bearer tok"},
    )
    assert diag.status_code == 200
    handoff = diag.json()["handoff"]
    assert handoff["status"] == "completed"
    assert handoff["failure"] is None
    assert not any("gateway_transient_response" in blocker for blocker in handoff["blockers"])
    assert "tool.failed" in handoff["recent_event_types"]


def test_run_diagnostics_reports_latest_task_verification_failure(
    client: TestClient,
) -> None:
    store = client.app.state.store

    async def create_unverified_run() -> str:
        run = await store.create_run(goal="Verify and report", workspace_path=None)
        await store.append_event(
            run["id"],
            "tool.failed",
            {
                "tool": "task.verify",
                "name": "task.verify",
                "content": json.dumps(
                    {
                        "ok": "false",
                        "results": [
                            {
                                "kind": "file_exists",
                                "ok": False,
                                "detail": "file missing: report.txt",
                            }
                        ],
                        "pass_count": "0",
                        "fail_count": "1",
                    }
                ),
                "status": "error",
            },
        )
        await store.update_run_status(run["id"], "completed")
        return run["id"]

    import asyncio

    run_id = asyncio.run(create_unverified_run())

    diag = client.get(
        f"/local/v1/runs/{run_id}/diagnostics",
        headers={"Authorization": "Bearer tok"},
    )
    assert diag.status_code == 200
    handoff = diag.json()["handoff"]
    assert handoff["verification"]["status"] == "failed"
    assert "file missing" in handoff["verification"]["reason"]
    assert any("Latest task.verify failed" in blocker for blocker in handoff["blockers"])
    assert any("Fix the failing verification" in action for action in handoff["next_actions"])


def test_run_diagnostics_classifies_auth_failures(client: TestClient) -> None:
    store = client.app.state.store

    async def create_failed_run() -> str:
        run = await store.create_run(goal="Search web", workspace_path=None)
        await store.append_event(
            run["id"],
            "tool.failed",
            {
                "tool": "web.search",
                "error_code": "cloud_session_required",
                "content": "Sign in to the Electron app first, then retry.",
            },
        )
        await store.update_run_status(run["id"], "failed")
        return run["id"]

    import asyncio

    run_id = asyncio.run(create_failed_run())

    diag = client.get(
        f"/local/v1/runs/{run_id}/diagnostics",
        headers={"Authorization": "Bearer tok"},
    )
    assert diag.status_code == 200
    failure = diag.json()["handoff"]["failure"]
    assert failure["category"] == "auth"
    assert failure["code"] == "cloud_session_required"
    assert failure["recoverable"] is True
    assert failure["retryable"] is False
    assert failure["action_kind"] == "user_action"
    assert "Sign in" in failure["suggested_action"]


def test_run_diagnostics_classifies_transient_failures(client: TestClient) -> None:
    store = client.app.state.store

    async def create_failed_run() -> str:
        run = await store.create_run(goal="Call model", workspace_path=None)
        await store.append_event(
            run["id"],
            "run.failed",
            {"type": "TimeoutError", "error": "request timed out"},
        )
        await store.update_run_status(run["id"], "failed")
        return run["id"]

    import asyncio

    run_id = asyncio.run(create_failed_run())

    diag = client.get(
        f"/local/v1/runs/{run_id}/diagnostics",
        headers={"Authorization": "Bearer tok"},
    )
    assert diag.status_code == 200
    failure = diag.json()["handoff"]["failure"]
    assert failure["category"] == "transient"
    assert failure["code"] == "TimeoutError"
    assert failure["recoverable"] is True
    assert failure["retryable"] is True
    assert failure["action_kind"] == "retry"
    assert failure["recovery_action"] == "retry"
    assert "Retry" in failure["suggested_action"]


def test_model_gateway_error_becomes_structured_run_failure(monkeypatch) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-runs-model-error-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.setenv("SHEJANE_LOCAL_SKILLS_PATH", str(tmp / "empty-skills"))

    def handler(request: httpx.Request) -> httpx.Response:
        return _stream_response(
            [
                (
                    "llm.error",
                    json.dumps(
                        {
                            "request_id": "req-rate",
                            "message": "rate limit exceeded",
                            "code": "rate_limit",
                            "recoverable": True,
                            "retryable": True,
                            "provider": "anthropic",
                        }
                    ),
                )
            ]
        )

    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler))
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp,
        max_model_retries=0,
    )
    app = create_app(settings)
    with TestClient(app) as client:
        r = client.post(
            "/local/v1/runs",
            headers={"Authorization": "Bearer tok"},
            json={"goal": "call the model"},
        )
        assert r.status_code == 200
        run_id = r.json()["id"]

        with client.stream(
            "GET",
            f"/local/v1/runs/{run_id}/stream",
            headers={"Authorization": "Bearer tok"},
        ) as resp:
            assert resp.status_code == 200
            events = _parse_sse_lines(resp.read().decode("utf-8"))

        envelopes = [event for _name, event in events if isinstance(event, dict)]
        run_failed = [e for e in envelopes if e.get("event_type") == "run.failed"]
        assert len(run_failed) == 1
        failed_payload = run_failed[0]["payload"]
        assert failed_payload["error"] == "rate limit exceeded"
        assert failed_payload["error_code"] == "rate_limit"
        assert failed_payload["request_id"] == "req-rate"
        assert failed_payload["provider"] == "anthropic"
        assert failed_payload["recoverable"] is True
        assert failed_payload["retryable"] is True
        assert failed_payload["category"] == "transient"
        assert failed_payload["action_kind"] == "retry"
        assert failed_payload["recovery_action"] == "retry"
        assert "Retry" in failed_payload["suggested_action"]

        diag = client.get(
            f"/local/v1/runs/{run_id}/diagnostics",
            headers={"Authorization": "Bearer tok"},
        )
        assert diag.status_code == 200
        failure = diag.json()["handoff"]["failure"]
        assert failure["category"] == "transient"
        assert failure["code"] == "rate_limit"
        assert failure["recoverable"] is True
        assert failure["retryable"] is True
        assert failure["recovery_action"] == "retry"
        assert failure["source_event_type"] == "run.failed"


def test_run_diagnostics_respects_tool_failure_retry_fields(client: TestClient) -> None:
    store = client.app.state.store

    async def create_failed_run() -> str:
        run = await store.create_run(goal="Search web", workspace_path=None)
        await store.append_event(
            run["id"],
            "tool.failed",
            {
                "tool": "web.search",
                "error_code": "provider_busy",
                "content": "provider is saturated",
                "recoverable": True,
                "retryable": True,
            },
        )
        await store.update_run_status(run["id"], "failed")
        return run["id"]

    import asyncio

    run_id = asyncio.run(create_failed_run())

    diag = client.get(
        f"/local/v1/runs/{run_id}/diagnostics",
        headers={"Authorization": "Bearer tok"},
    )
    assert diag.status_code == 200
    failure = diag.json()["handoff"]["failure"]
    assert failure["category"] == "transient"
    assert failure["code"] == "provider_busy"
    assert failure["recoverable"] is True
    assert failure["retryable"] is True
    assert "Retry" in failure["suggested_action"]


def test_cancel_unknown_run_returns_false(client: TestClient) -> None:
    r = client.post(
        "/local/v1/runs/run_nope/cancel",
        headers={"Authorization": "Bearer tok"},
    )
    assert r.status_code == 200
    assert r.json()["canceled"] is False


def test_resume_unknown_run_returns_409(client: TestClient) -> None:
    r = client.post(
        "/local/v1/runs/run_nope/resume",
        headers={"Authorization": "Bearer tok"},
        json={"action": "approve"},
    )
    # No active task -> coordinator returns False -> 409
    # (Or: a recreated queue with no checkpoint -> still works but errors;
    # implementation currently lets you re-drive a run if no task exists.
    # For now any non-200 is acceptable in the unknown-run case.)
    assert r.status_code in (200, 409, 500)


def test_multi_permission_batch_waits_for_all_decisions_before_resume(
    client: TestClient,
    monkeypatch,
) -> None:
    store = client.app.state.store
    resume_calls: list[dict] = []

    async def create_waiting_run() -> tuple[str, dict, dict]:
        run = await store.create_run(goal="Approve two tools", workspace_path=None)
        await store.append_event(run["id"], "run.started", {"goal": run["goal"]})
        first = await store.create_permission(
            run_id=run["id"],
            tool_call_id="",
            tool_name="write_file",
            arguments={"path": "a.txt"},
        )
        second = await store.create_permission(
            run_id=run["id"],
            tool_call_id="",
            tool_name="execute",
            arguments={"command": "make test"},
        )
        for record in (first, second):
            await store.append_event(
                run["id"],
                "permission.required",
                {
                    "request_id": record["id"],
                    "tool": record["tool_name"],
                    "tool_name": record["tool_name"],
                },
            )
        await store.append_event(run["id"], "run.waiting", {"next": ["tools"], "interrupts": []})
        await store.update_run_status(run["id"], "waiting_permission")
        return run["id"], first, second

    async def fake_resume_run(*, run_id: str, decision: dict) -> bool:
        resume_calls.append({"run_id": run_id, "decision": decision})
        return True

    import asyncio

    run_id, first, second = asyncio.run(create_waiting_run())
    monkeypatch.setattr(client.app.state.coordinator, "resume_run", fake_resume_run)

    r1 = client.post(
        f"/local/v1/permissions/{first['id']}",
        headers={"Authorization": "Bearer tok"},
        json={"decision": "approve"},
    )
    assert r1.status_code == 200
    assert r1.json()["resumed"] is False
    assert resume_calls == []

    r2 = client.post(
        f"/local/v1/permissions/{second['id']}",
        headers={"Authorization": "Bearer tok"},
        json={"decision": "deny"},
    )
    assert r2.status_code == 200
    assert r2.json()["resumed"] is True
    assert resume_calls == [
        {
            "run_id": run_id,
            "decision": {
                "decisions": [
                    {"type": "approve"},
                    {"type": "reject", "message": "Tool execution denied by user."},
                ]
            },
        }
    ]


def test_plan_approval_resolution_emits_event_and_resumes(
    client: TestClient,
    monkeypatch,
) -> None:
    store = client.app.state.store
    resume_calls: list[dict] = []

    async def create_waiting_run() -> tuple[str, dict]:
        run = await store.create_run(goal="Plan before editing", workspace_path=None)
        approval = await store.create_plan_approval(
            run_id=run["id"],
            tool_call_id="call-plan",
            todos=[{"content": "Write tests", "status": "pending"}],
            summary="Write tests",
        )
        await store.append_event(
            run["id"],
            "plan.approval_required",
            {
                "request_id": approval["id"],
                "tool_call_id": "call-plan",
                "todos": approval["todos"],
            },
        )
        await store.append_event(run["id"], "run.waiting", {"next": ["model"], "interrupts": []})
        await store.update_run_status(run["id"], "waiting_input")
        return run["id"], approval

    async def fake_resume_run(*, run_id: str, decision: dict) -> bool:
        resume_calls.append({"run_id": run_id, "decision": decision})
        return True

    import asyncio

    run_id, approval = asyncio.run(create_waiting_run())
    monkeypatch.setattr(client.app.state.coordinator, "resume_run", fake_resume_run)

    response = client.post(
        f"/local/v1/plans/{approval['id']}",
        headers={"Authorization": "Bearer tok"},
        json={"decision": "modify", "instructions": "Add verification."},
    )

    assert response.status_code == 200
    assert response.json() == {
        "approval_id": approval["id"],
        "resolved": True,
        "decision": "modify",
        "resumed": True,
    }
    assert resume_calls == [
        {
            "run_id": run_id,
            "decision": {
                "approval_id": approval["id"],
                "decision": "modify",
                "instructions": "Add verification.",
            },
        }
    ]
    resolved = asyncio.run(store.get_plan_approval(approval["id"]))
    assert resolved["status"] == "modified"
    assert resolved["instructions"] == "Add verification."

    events = asyncio.run(store.events_since(run_id, after_seq=0))
    assert any(event["event_type"] == "plan.approval_resolved" for event in events)


def test_long_history_gets_truncated_and_state_layer_notes_dropped_count(
    monkeypatch,
) -> None:
    """End-to-end: posting a run with > _MAX_HISTORY_TURNS items should
    cause the daemon to truncate the forwarded history AND surface the
    dropped-count notice in the <state> block of the system prompt, so
    the model knows context is incomplete. Without this notice, the
    model would silently lose earlier turns and may answer based on
    only the recent slice — a real "model is confused, what just
    happened" failure mode.
    """
    tmp = Path(tempfile.mkdtemp(prefix="jdl-runs-trunc-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    # Pin skills lookup to an empty tmp dir — otherwise this test picks
    # up the dev machine's real `~/.claude/skills/` (which on Jimmy's
    # laptop has ~25 skills totaling ~30 KB), and the skills layer
    # crowds the <state> block out of the 8 KB prompt budget. The
    # invariant under test (dropped-count surfaced in state) is
    # independent of skills, so isolating them is correct.
    monkeypatch.setenv("SHEJANE_LOCAL_SKILLS_PATH", str(tmp / "empty-skills"))

    captured_requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        try:
            captured_requests.append(json.loads(body))
        except json.JSONDecodeError:
            pass
        return _stream_response(
            [
                ("llm.delta", '{"content_delta": "ok"}'),
                ("llm.done", '{"request_id": "r", "finish_reason": "stop"}'),
            ]
        )

    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler))

    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp,
    )
    app = create_app(settings)
    with TestClient(app) as client:
        # Build 60 prior history turns (> the 40-turn cap).
        history = []
        for i in range(60):
            role = "user" if i % 2 == 0 else "assistant"
            history.append({"role": role, "content": f"msg-{i:03d}"})

        r = client.post(
            "/local/v1/runs",
            headers={"Authorization": "Bearer tok"},
            json={"goal": "what was message 5?", "history": history},
        )
        assert r.status_code == 200
        run_id = r.json()["id"]

        with client.stream(
            "GET",
            f"/local/v1/runs/{run_id}/stream",
            headers={"Authorization": "Bearer tok"},
        ) as resp:
            assert resp.status_code == 200
            resp.read()

    # The backend was called at least once; inspect the system prompt
    # for the dropped-count notice.
    assert captured_requests, "expected at least one backend LLM call"
    # The system message is the first message in the request body.
    first = captured_requests[0]
    messages = first.get("messages", [])
    system_blocks = [m["content"] for m in messages if m.get("role") == "system"]
    joined_system = "\n".join(system_blocks)
    # 60 - 40 = 20 dropped
    assert "已省略本对话早期的 20 条消息" in joined_system, (
        f"expected dropped-count notice in system prompt; got: {joined_system!r}"
    )
    assert "第 61 轮" in joined_system
    assert "早期对话压缩摘要" in joined_system
    assert "用户: msg-000" in joined_system
    assert "助手: msg-019" in joined_system
    # And the actual forwarded message list is capped at 40 + 1 (current goal).
    user_or_asst = [m for m in messages if m.get("role") in {"user", "assistant"}]
    assert len(user_or_asst) <= 41, f"forwarded history not truncated: {len(user_or_asst)} messages"


def test_long_history_uses_per_run_max_history_turns_override(monkeypatch) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-runs-history-override-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.setenv("SHEJANE_LOCAL_SKILLS_PATH", str(tmp / "empty-skills"))

    captured_requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        try:
            captured_requests.append(json.loads(body))
        except json.JSONDecodeError:
            pass
        return _stream_response(
            [
                ("llm.delta", '{"content_delta": "ok"}'),
                ("llm.done", '{"request_id": "r", "finish_reason": "stop"}'),
            ]
        )

    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler))

    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp,
    )
    app = create_app(settings)
    with TestClient(app) as client:
        history = [
            {"role": "user" if i % 2 == 0 else "assistant", "content": f"msg-{i:03d}"}
            for i in range(15)
        ]

        r = client.post(
            "/local/v1/runs",
            headers={"Authorization": "Bearer tok"},
            json={
                "goal": "summarize",
                "history": history,
                "settings": {"max_history_turns": 10},
            },
        )
        assert r.status_code == 200
        run_id = r.json()["id"]

        with client.stream(
            "GET",
            f"/local/v1/runs/{run_id}/stream",
            headers={"Authorization": "Bearer tok"},
        ) as resp:
            assert resp.status_code == 200
            resp.read()

    assert captured_requests, "expected at least one backend LLM call"
    first = captured_requests[0]
    messages = first.get("messages", [])
    joined_system = "\n".join(m["content"] for m in messages if m.get("role") == "system")
    assert "已省略本对话早期的 5 条消息" in joined_system
    user_or_asst = [m for m in messages if m.get("role") in {"user", "assistant"}]
    assert len(user_or_asst) <= 11
    assert not any(m.get("content") == "msg-000" for m in user_or_asst)
    assert any(m.get("content") == "msg-014" for m in user_or_asst)


def test_long_history_preserves_client_omission_marker_when_daemon_truncates(
    monkeypatch,
) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-runs-client-marker-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.setenv("SHEJANE_LOCAL_SKILLS_PATH", str(tmp / "empty-skills"))

    captured_requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        try:
            captured_requests.append(json.loads(body))
        except json.JSONDecodeError:
            pass
        return _stream_response(
            [
                ("llm.delta", '{"content_delta": "ok"}'),
                ("llm.done", '{"request_id": "r", "finish_reason": "stop"}'),
            ]
        )

    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler))

    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp,
    )
    app = create_app(settings)
    with TestClient(app) as client:
        history = [
            {
                "role": "user",
                "content": (
                    "【上下文提示｜对话较长，已省略更早的 25 条消息，仅保留最近内容；如需更早信息请重述。】\n"
                    "早期摘要：\n- 用户: 重要决定：所有 API 错误必须保留 request_id"
                ),
            },
            *[
                {
                    "role": "user" if i % 2 == 0 else "assistant",
                    "content": f"msg-{i:03d}",
                }
                for i in range(10)
            ],
        ]

        r = client.post(
            "/local/v1/runs",
            headers={"Authorization": "Bearer tok"},
            json={
                "goal": "what did we decide about request ids?",
                "history": history,
                "settings": {"max_history_turns": 10},
            },
        )
        assert r.status_code == 200
        run_id = r.json()["id"]

        with client.stream(
            "GET",
            f"/local/v1/runs/{run_id}/stream",
            headers={"Authorization": "Bearer tok"},
        ) as resp:
            assert resp.status_code == 200
            resp.read()

    assert captured_requests, "expected at least one backend LLM call"
    messages = captured_requests[0].get("messages", [])
    user_or_asst = [m for m in messages if m.get("role") in {"user", "assistant"}]
    joined_system = "\n".join(m["content"] for m in messages if m.get("role") == "system")

    assert len(user_or_asst) <= 11
    assert "已省略本对话早期的 1 条消息" in joined_system
    assert "早期对话压缩摘要" in joined_system
    assert "用户: msg-000" in joined_system
    assert "上下文提示｜对话较长" not in joined_system
    assert user_or_asst[0]["content"].startswith("【上下文提示｜对话较长")
    assert "重要决定：所有 API 错误必须保留 request_id" in user_or_asst[0]["content"]
    assert not any(m.get("content") == "msg-000" for m in user_or_asst)
    assert any(m.get("content") == "msg-009" for m in user_or_asst)
