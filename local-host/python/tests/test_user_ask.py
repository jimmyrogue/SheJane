"""Tests for the user.ask tool — clarifying-question interrupt."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Any

import httpx
from fastapi.testclient import TestClient

from local_host.config import reset_settings_for_tests
from local_host.server import create_app

# --- mock backend helpers (shared with capability tests) ---


def _sse(events: list[tuple[str, dict]]) -> httpx.Response:
    body = "".join(f"event: {n}\ndata: {json.dumps(p)}\n\n" for n, p in events).encode("utf-8")
    return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})


class RecordingHandler:
    def __init__(self, scripts: list[list[tuple[str, dict]]]):
        self.scripts = list(scripts)
        self.requests: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body_bytes = request.read()
        try:
            self.requests.append(json.loads(body_bytes))
        except json.JSONDecodeError:
            self.requests.append({"raw": body_bytes.decode(errors="replace")})
        if self.scripts:
            return _sse(self.scripts.pop(0))
        return _sse([("llm.done", {"request_id": "x", "finish_reason": "stop"})])


def _patched_async_client(handler):
    class _Patched(httpx.AsyncClient):
        def __init__(self, **kw):
            super().__init__(
                transport=httpx.MockTransport(handler),
                **{k: v for k, v in kw.items() if k != "transport"},
            )

    return _Patched


def _make_client(monkeypatch, handler) -> TestClient:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-uask-"))
    os.environ["JIANDANLY_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.delenv("JIANDANLY_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler))
    settings = reset_settings_for_tests(
        JIANDANLY_LOCAL_HOST_ADDR="127.0.0.1",
        JIANDANLY_LOCAL_HOST_PORT=17371,
        JIANDANLY_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp,
    )
    app = create_app(settings)
    return TestClient(app)


def _parse_sse(body: str) -> list[tuple[str, dict]]:
    """Return list of (event_type, payload) — payload is auto-unwrapped
    from the AgentRunEvent envelope (Block 0). This keeps the test
    bodies readable: they can still write `data.get("interrupts")`
    instead of `data["payload"]["interrupts"]`.
    """
    events: list[tuple[str, dict]] = []
    name = ""
    buf: list[str] = []
    for raw in body.split("\n"):
        line = raw.rstrip("\r")
        if not line:
            if name or buf:
                try:
                    data = json.loads("\n".join(buf))
                except json.JSONDecodeError:
                    data = {"raw": "\n".join(buf)}
                # Unwrap envelope when present.
                if isinstance(data, dict) and "event_type" in data and "payload" in data:
                    events.append((str(data["event_type"]), data["payload"]))
                else:
                    events.append((name, data))
            name = ""
            buf = []
            continue
        if line.startswith("event:"):
            name = line[6:].strip()
        elif line.startswith("data:"):
            buf.append(line[5:].strip())
    if name or buf:
        try:
            data = json.loads("\n".join(buf))
        except json.JSONDecodeError:
            data = {"raw": "\n".join(buf)}
        events.append((name, data))
    return events


# --- tool registration ---


def test_user_ask_in_tool_registry() -> None:
    from local_host.tools.registry import core_tools

    names = {t.name for t in core_tools()}
    assert "user.ask" in names


def test_user_ask_appears_in_compiled_agent(monkeypatch, tmp_path) -> None:
    from local_host.agent.builder import build_agent, open_checkpointer
    from local_host.store.sqlite import LocalStore

    async def run() -> set[str]:
        reset_settings_for_tests(data_dir=tmp_path)
        monkeypatch.delenv("JIANDANLY_LOCAL_MCP_SERVERS", raising=False)
        monkeypatch.delenv("TAVILY_API_KEY", raising=False)
        store = await LocalStore.open(tmp_path / "store.db")
        saver, stack = await open_checkpointer()
        try:
            agent = await build_agent(
                store=store,
                checkpointer=saver,
                workspace_root=str(tmp_path),
                run_id="t-user-1",
            )
            tools_node = agent.nodes.get("tools")
            bound = getattr(tools_node, "bound", None)
            return set(getattr(bound, "tools_by_name", {}).keys())
        finally:
            await store.close()
            await stack.aclose()

    assert "user.ask" in asyncio.run(run())


# --- end-to-end: tool call triggers run.waiting with question payload ---


def test_user_ask_pauses_run_with_question_in_waiting_event(monkeypatch) -> None:
    handler = RecordingHandler(
        scripts=[
            [
                ("llm.delta", {"content_delta": "I need to clarify. "}),
                (
                    "llm.tool_call",
                    {
                        "id": "call_q1",
                        "name": "user.ask",
                        "arguments": {
                            "question": "Which framework? React or Vue?",
                            "options": ["React", "Vue"],
                        },
                    },
                ),
                ("llm.done", {"request_id": "rq", "finish_reason": "tool_calls"}),
            ]
        ]
    )
    with _make_client(monkeypatch, handler) as client:
        r = client.post(
            "/local/v1/runs",
            headers={"Authorization": "Bearer tok"},
            json={"goal": "compare frontend frameworks"},
        )
        assert r.status_code == 200
        run_id = r.json()["id"]
        with client.stream(
            "GET",
            f"/local/v1/runs/{run_id}/stream",
            headers={"Authorization": "Bearer tok"},
        ) as resp:
            body = resp.read().decode("utf-8")

    events = _parse_sse(body)
    names = [e[0] for e in events]
    assert "run.waiting" in names, f"user.ask should pause the run with run.waiting. got: {names}"

    waiting = next(e[1] for e in events if e[0] == "run.waiting")
    interrupts = waiting.get("interrupts", [])
    assert interrupts, "run.waiting should carry interrupt details"
    payload = interrupts[0].get("value", {})
    # The payload our user.ask tool builds includes kind/question/options
    serialized = json.dumps(payload, default=str)
    assert "question" in serialized.lower()
    assert "React" in serialized
    assert "Vue" in serialized


# --- resume returns the answer to the tool ---


def test_user_ask_resume_via_questions_endpoint(monkeypatch) -> None:
    """POST /local/v1/questions/{id} with answer should resume the run.

    Because the resume endpoint requires run_id in body (per our Phase 5'
    stub), we pass it explicitly. The follow-on LLM turn should observe
    the user's answer in the tool result.
    """
    handler = RecordingHandler(
        scripts=[
            [
                # First LLM turn: ask via user.ask
                (
                    "llm.tool_call",
                    {
                        "id": "call_q1",
                        "name": "user.ask",
                        "arguments": {"question": "Which mode?"},
                    },
                ),
                ("llm.done", {"request_id": "ra", "finish_reason": "tool_calls"}),
            ],
            # Second turn (after resume): final answer
            [
                ("llm.delta", {"content_delta": "Got it, using mode X."}),
                ("llm.done", {"request_id": "rb", "finish_reason": "stop"}),
            ],
        ]
    )
    with _make_client(monkeypatch, handler) as client:
        headers = {"Authorization": "Bearer tok"}
        r = client.post("/local/v1/runs", headers=headers, json={"goal": "x"})
        run_id = r.json()["id"]

        # Drain the first stream until waiting
        with client.stream("GET", f"/local/v1/runs/{run_id}/stream", headers=headers) as resp:
            body1 = resp.read().decode("utf-8")
        assert "run.waiting" in body1

        # Find the question_id emitted via `question.asked` (Block 4
        # bridge) and resume with the contract-shape `{answers: {...}}`.
        events1 = _parse_sse(body1)
        question_event = next((e for e in events1 if e[0] == "question.asked"), None)
        assert question_event is not None, (
            f"expected question.asked SSE event after user.ask interrupt. got: "
            f"{[e[0] for e in events1]}"
        )
        question_id = question_event[1]["request_id"]
        resume = client.post(
            f"/local/v1/questions/{question_id}",
            headers=headers,
            json={"answers": {question_id: ["mode X"]}},
        )
        assert resume.status_code == 200, resume.text

        # Drain the post-resume stream
        with client.stream("GET", f"/local/v1/runs/{run_id}/stream", headers=headers) as resp:
            body2 = resp.read().decode("utf-8")

    # Stream after resume should contain at least run.resumed signal
    events2 = _parse_sse(body2)
    names2 = [e[0] for e in events2]
    assert "run.resumed" in names2 or "run.completed" in names2, (
        f"expected run.resumed or run.completed after question resume. got: {names2}"
    )


# --- payload shape from the tool ---


def test_user_ask_returns_answer_string_on_resume() -> None:
    """Direct unit test on the tool function: when interrupt() returns a
    dict {answer: ...}, the tool returns the answer as a string."""
    # We can't easily invoke interrupt() outside a graph, but we can
    # check the post-processing logic by patching `interrupt`.
    import local_host.tools.user as user_mod

    captured: dict[str, Any] = {}

    def fake_interrupt(payload):
        captured["payload"] = payload
        return {"answer": "Vue"}

    original = user_mod.interrupt
    user_mod.interrupt = fake_interrupt
    try:
        result = user_mod.user_ask.invoke(
            {"question": "React or Vue?", "options": ["React", "Vue"]}
        )
    finally:
        user_mod.interrupt = original

    assert result == "Vue"
    assert captured["payload"]["kind"] == "question"
    assert captured["payload"]["question"] == "React or Vue?"
    assert captured["payload"]["options"] == ["React", "Vue"]


def test_user_ask_handles_bare_string_resume_value() -> None:
    """If the resume value is a bare string (not dict), tool still returns
    a string."""
    import local_host.tools.user as user_mod

    user_mod.interrupt = lambda _payload: "user typed this directly"
    try:
        result = user_mod.user_ask.invoke({"question": "any thoughts?"})
    finally:
        # Restore the real interrupt
        from langgraph.types import interrupt as real_interrupt

        user_mod.interrupt = real_interrupt

    assert result == "user typed this directly"
