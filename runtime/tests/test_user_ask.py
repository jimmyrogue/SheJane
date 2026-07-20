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

from shejane_runtime.config import reset_settings_for_tests
from shejane_runtime.server import create_app
from tests.helpers import run_command

# --- mock backend helpers (shared with capability tests) ---


def _sse(events: list[tuple[str, dict]]) -> httpx.Response:
    body = "".join(f"event: {n}\ndata: {json.dumps(p)}\n\n" for n, p in events).encode("utf-8")
    return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})


class RecordingHandler:
    def __init__(self, scripts: list[list[tuple[str, dict]]]):
        self.scripts = list(scripts)
        self.requests: list[dict] = []
        self.review_requests = 0
        self.completion_review_requests = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body_bytes = request.read()
        try:
            body = json.loads(body_bytes)
            self.requests.append(body)
        except json.JSONDecodeError:
            body = {"raw": body_bytes.decode(errors="replace")}
            self.requests.append(body)
        if "P9 clarification necessity reviewer" in str(body):
            self.review_requests += 1
            payload: dict[str, Any] = {}
            for message in reversed(body.get("messages") or []):
                content = message.get("content") if isinstance(message, dict) else None
                if not isinstance(content, str):
                    continue
                try:
                    parsed = json.loads(content)
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, dict):
                    payload = parsed
                    break
            decisions = [
                {
                    "tool_call_id": str(item.get("tool_call_id") or ""),
                    "decision": "allow",
                    "reason": "Test fixture allows the scripted question.",
                }
                for item in payload.get("proposed_questions") or []
                if isinstance(item, dict)
            ]
            return _sse(
                [
                    ("llm.delta", {"content_delta": json.dumps({"decisions": decisions})}),
                    ("llm.done", {"request_id": "review", "finish_reason": "stop"}),
                ]
            )
        if "P9 final-answer reviewer" in str(body):
            self.completion_review_requests += 1
            return _sse(
                [
                    (
                        "llm.delta",
                        {
                            "content_delta": json.dumps(
                                {
                                    "decision": "allow",
                                    "reason": "The scripted answer includes the selected value.",
                                }
                            )
                        },
                    ),
                    ("llm.done", {"request_id": "completion-review", "finish_reason": "stop"}),
                ]
            )
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
    os.environ["SHEJANE_RUNTIME_TOKEN"] = "tok"
    monkeypatch.delenv("SHEJANE_RUNTIME_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.setattr("tests.streaming_model.httpx.AsyncClient", _patched_async_client(handler))
    settings = reset_settings_for_tests(
        SHEJANE_RUNTIME_HOST="127.0.0.1",
        SHEJANE_RUNTIME_PORT=17371,
        SHEJANE_RUNTIME_TOKEN="tok",
        SHEJANE_PLAN_FIRST="off",
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


def test_user_ask_docstring_encourages_consistent_tool_usage() -> None:
    """The user.ask docstring is part of the prompt the LLM sees as the
    tool's description. Past runs showed the model abandoning the tool
    after 2-3 calls and falling back to markdown-bullet questions in
    prose — partly because the docstring used to say
    "only when you genuinely cannot make progress" / "prefer making
    reasonable assumptions". We rewrote it to encourage consistent
    usage. This test locks in the key clauses so a future cleanup
    doesn't silently revert the change.
    """
    from shejane_runtime.tools.user import user_ask

    desc = user_ask.description or ""

    # Discouraging-language regressions we explicitly removed:
    forbidden = [
        "only when you genuinely cannot make progress",
        "prefer making a reasonable assumption",
    ]
    for phrase in forbidden:
        assert phrase not in desc, (
            f"user.ask docstring re-introduced discouraging phrase {phrase!r} — "
            f"previously caused the model to bail out of tool usage after a few rounds."
        )

    # Encouraging clauses we want to keep:
    required = [
        "One question per call",
        "Keep using this tool across rounds",
    ]
    for phrase in required:
        assert phrase in desc, (
            f"user.ask docstring is missing the required clause {phrase!r}; "
            f"model may revert to prose questions without it."
        )


def test_developer_prompt_enforces_user_ask_for_clarifications() -> None:
    """Lock in the 'always use user.ask, never embed in prose' rules
    in the developer system prompt. These clauses fix the bug where
    after 2 successful user.ask calls the model gave up and wrote
    the next clarifying question as markdown bullets in its reply —
    leaving the user with no clickable card."""
    from pathlib import Path

    prompt_path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "shejane_runtime"
        / "agent"
        / "prompts"
        / "developer.md"
    )
    text = prompt_path.read_text(encoding="utf-8")

    required = [
        "向用户澄清",  # the new section heading
        "必须",  # 必须 use user.ask
        "禁止",  # 禁止 embed in prose
        "一次 `user.ask` 只问一个问题",  # one-question-per-call rule
        "后续轮次也要遵守",  # consistency-across-rounds rule
    ]
    for phrase in required:
        assert phrase in text, (
            f"developer.md missing required clause {phrase!r}; "
            f"the prose-question regression may return."
        )


def test_attached_document_is_not_treated_as_a_missing_file_path() -> None:
    """An attachment is already a complete file input, not a reason to ask
    the user for the same path again."""
    from pathlib import Path

    from shejane_runtime.tools.user import user_ask

    prompt_path = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "shejane_runtime"
        / "agent"
        / "prompts"
        / "developer.md"
    )
    prompt = prompt_path.read_text(encoding="utf-8")
    tool_description = user_ask.description or ""

    assert "Runtime 上下文已经列出附件时，不要再询问文件路径" in prompt
    assert "Runtime 上下文已经列出附件时，文件已经提供" in tool_description


def test_user_ask_in_tool_registry() -> None:
    from shejane_runtime.tools.registry import core_tools

    names = {t.name for t in core_tools()}
    assert "user.ask" in names


def test_user_ask_appears_in_compiled_agent(monkeypatch, tmp_path) -> None:
    from shejane_runtime.agent.builder import build_agent, open_checkpointer
    from shejane_runtime.store.sqlite import LocalStore

    async def run() -> set[str]:
        reset_settings_for_tests(data_dir=tmp_path)
        monkeypatch.delenv("SHEJANE_RUNTIME_MCP_SERVERS", raising=False)
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


def test_user_ask_in_parallel_tool_call_batch_still_pauses(monkeypatch) -> None:
    """Regression for the "agent emits user.ask alongside other tools
    and the run silently stalls" bug.

    Reproduces what we saw in a real Phuket-travel-planning run: the
    model returns 3+ tool calls in one response — some non-blocking
    (write_todos, web.search), one blocking (user.ask). Each tool gets
    its own LangGraph task. The user.ask interrupt landed in
    snapshot.tasks[N>0], but earlier code only inspected
    snapshot.tasks[0].interrupts → the interrupt was missed, run.waiting
    was emitted with empty interrupts list, and the UI had nothing to
    render so the user saw the run hang forever with no prompt.

    Fix: gather interrupts from both snapshot.interrupts (top-level
    aggregate) and every snapshot.tasks[*].interrupts, deduped.
    """
    handler = RecordingHandler(
        scripts=[
            [
                ("llm.delta", {"content_delta": "Planning. "}),
                # Tool call #1: write_todos (synchronous, completes).
                (
                    "llm.tool_call",
                    {
                        "id": "call_p1_todos",
                        "name": "write_todos",
                        "arguments": {
                            "todos": [
                                {"content": "research", "status": "in_progress"},
                                {"content": "ask user", "status": "in_progress"},
                            ]
                        },
                    },
                ),
                # Tool call #2: time.now (synchronous, completes).
                (
                    "llm.tool_call",
                    {
                        "id": "call_p2_time",
                        "name": "time.now",
                        "arguments": {},
                    },
                ),
                # Tool call #3: user.ask — must pause the run. This is
                # the one that landed in tasks[N>0] in the original bug.
                (
                    "llm.tool_call",
                    {
                        "id": "call_p3_ask",
                        "name": "user.ask",
                        "arguments": {
                            "question": "How many days?",
                            "options": ["3", "5", "7"],
                        },
                    },
                ),
                ("llm.done", {"request_id": "rq_par", "finish_reason": "tool_calls"}),
            ]
        ]
    )
    with _make_client(monkeypatch, handler) as client:
        r = client.post(
            "/v1/runs",
            headers={"Authorization": "Bearer tok"},
            json=run_command("plan a trip"),
        )
        assert r.status_code == 200
        run_id = r.json()["id"]
        with client.stream(
            "GET",
            f"/v1/runs/{run_id}/stream",
            headers={"Authorization": "Bearer tok"},
        ) as resp:
            body = resp.read().decode("utf-8")

    events = _parse_sse(body)
    names = [e[0] for e in events]

    # The smoking gun in the original bug: run.waiting fires but with
    # empty interrupts. After the fix, interrupts must be populated.
    assert "run.waiting" in names, f"expected run.waiting; got: {names}"
    waiting = next(e[1] for e in events if e[0] == "run.waiting")
    assert waiting.get("interrupts"), (
        "run.waiting had empty interrupts despite user.ask in parallel batch — "
        f"the parallel-tool-call regression has returned. payload: {waiting!r}"
    )
    assert waiting.get("handoff", {}).get("ledger_state") == "missing"
    assert "Progress ledger missing" in str(waiting.get("handoff", {}).get("ledger_message"))

    # And the question itself must reach the client via question.asked.
    assert "question.asked" in names, (
        f"user.ask in parallel batch did not produce question.asked event. got: {names}"
    )
    question_event = next(e[1] for e in events if e[0] == "question.asked")
    serialized = json.dumps(question_event, default=str)
    assert "How many days" in serialized

    # And the option shape — second-half of the same UI failure: even
    # when the interrupt was eventually surfaced, the client's
    # parseQuestionPayload silently dropped bare-string options because
    # the TS AgentQuestionChoice contract is {label, description?}.
    # We now normalize at the runtime boundary so the wire matches.
    questions = question_event.get("questions") or []
    assert questions, "question.asked must carry at least one question"
    options = questions[0].get("options") or []
    assert options, "question.asked options must not be empty"
    for option in options:
        assert isinstance(option, dict), (
            f"options must be dicts (e.g. {{'label': ...}}), not bare strings; got: {option!r}"
        )
        assert option.get("label"), f"every option needs a non-empty label; got: {option!r}"


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
            "/v1/runs",
            headers={"Authorization": "Bearer tok"},
            json=run_command("compare frontend frameworks"),
        )
        assert r.status_code == 200
        run_id = r.json()["id"]
        with client.stream(
            "GET",
            f"/v1/runs/{run_id}/stream",
            headers={"Authorization": "Bearer tok"},
        ) as resp:
            body = resp.read().decode("utf-8")
        run_response = client.get(
            f"/v1/runs/{run_id}",
            headers={"Authorization": "Bearer tok"},
        )
        assert run_response.status_code == 200
        run_status = run_response.json()["status"]

    events = _parse_sse(body)
    names = [e[0] for e in events]
    assert "run.waiting" in names, f"user.ask should pause the run with run.waiting. got: {names}"

    waiting = next(e[1] for e in events if e[0] == "run.waiting")
    assert waiting.get("handoff", {}).get("ledger_state") == "not_required"
    interrupts = waiting.get("interrupts", [])
    assert interrupts, "run.waiting should carry interrupt details"
    payload = interrupts[0].get("value", {})
    # The payload our user.ask tool builds includes kind/question/options
    serialized = json.dumps(payload, default=str)
    assert "question" in serialized.lower()
    assert "React" in serialized
    assert "Vue" in serialized
    assert run_status == "waiting_input"


# --- resume returns the answer to the tool ---


def test_user_ask_resume_via_questions_endpoint(monkeypatch) -> None:
    """POST /v1/questions/{id} with answer should resume the run.

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
        r = client.post("/v1/runs", headers=headers, json=run_command("x"))
        run_id = r.json()["id"]

        # Drain the first stream until waiting
        with client.stream("GET", f"/v1/runs/{run_id}/stream", headers=headers) as resp:
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
            f"/v1/questions/{question_id}",
            headers=headers,
            json={"answers": {question_id: ["mode X"]}},
        )
        assert resume.status_code == 200, resume.text

        # Drain the post-resume stream
        with client.stream("GET", f"/v1/runs/{run_id}/stream", headers=headers) as resp:
            body2 = resp.read().decode("utf-8")
        replay = client.post(
            f"/v1/questions/{question_id}",
            headers=headers,
            json={"answers": {question_id: ["mode X"]}},
        )
        conflict = client.post(
            f"/v1/questions/{question_id}",
            headers=headers,
            json={"answers": {question_id: ["mode Y"]}},
        )
        assert replay.status_code == 200
        assert replay.json()["resumed"] is True
        assert conflict.status_code == 409

    # Stream after resume should contain at least run.resumed signal
    events2 = _parse_sse(body2)
    names2 = [e[0] for e in events2]
    assert "question.answered" in names2
    if "run.resumed" in names2:
        assert names2.index("question.answered") < names2.index("run.resumed")
    assert "run.resumed" in names2 or "run.completed" in names2, (
        f"expected run.resumed or run.completed after question resume. got: {names2}"
    )


def test_user_ask_stops_interrupting_after_four_questions(monkeypatch) -> None:
    """A clarification loop must not keep sending the user back to the composer."""
    scripts = [
        [
            (
                "llm.tool_call",
                {
                    "id": f"call_q{index}",
                    "name": "user.ask",
                    "arguments": {"question": f"Question {index}?", "options": ["A", "B"]},
                },
            ),
            ("llm.done", {"request_id": f"rq{index}", "finish_reason": "tool_calls"}),
        ]
        for index in range(1, 6)
    ]
    scripts.append(
        [
            ("llm.delta", {"content_delta": "Continuing with reasonable defaults."}),
            ("llm.done", {"request_id": "final", "finish_reason": "stop"}),
        ]
    )
    handler = RecordingHandler(scripts=scripts)

    with _make_client(monkeypatch, handler) as client:
        headers = {"Authorization": "Bearer tok"}
        response = client.post("/v1/runs", headers=headers, json=run_command("x"))
        run_id = response.json()["id"]
        asked = 0
        answered_question_ids: set[str] = set()

        for _ in range(5):
            with client.stream(
                "GET",
                f"/v1/runs/{run_id}/stream",
                headers=headers,
            ) as stream:
                events = _parse_sse(stream.read().decode("utf-8"))
            question_events = [event for event in events if event[0] == "question.asked"]
            question_event = question_events[-1] if question_events else None
            if question_event is None:
                break
            question_id = question_event[1]["request_id"]
            if question_id in answered_question_ids:
                break
            answered_question_ids.add(question_id)
            asked += 1
            answer = client.post(
                f"/v1/questions/{question_id}",
                headers=headers,
                json={"answers": {question_id: ["A"]}},
            )
            assert answer.status_code == 200

        with client.stream(
            "GET",
            f"/v1/runs/{run_id}/stream",
            headers=headers,
        ) as stream:
            stream.read()
        stored_run = client.portal.call(client.app.state.store.get_run, run_id)
        stored_events = client.portal.call(client.app.state.store.events_since, run_id, 0)
        event_summary = [
            (event["event_type"], json.loads(event["payload_json"])) for event in stored_events
        ]

    assert asked == 4
    assert stored_run is not None and stored_run["status"] == "completed", event_summary[-5:]
    assert len(handler.requests) - handler.review_requests - handler.completion_review_requests == 6
    # Reviewer owns a separate four-call budget; the fifth proposed question
    # fails open to the tool's own clarification limit without provider I/O.
    assert handler.review_requests == 4
    assert handler.completion_review_requests == 1


# --- payload shape from the tool ---


def test_user_ask_returns_answer_string_on_resume() -> None:
    """Direct unit test on the tool function: when interrupt() returns a
    dict {answer: ...}, the tool returns the answer as a string."""
    # We can't easily invoke interrupt() outside a graph, but we can
    # check the post-processing logic by patching `interrupt`.
    import shejane_runtime.tools.user as user_mod

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
    import shejane_runtime.tools.user as user_mod

    user_mod.interrupt = lambda _payload: "user typed this directly"
    try:
        result = user_mod.user_ask.invoke({"question": "any thoughts?"})
    finally:
        # Restore the real interrupt
        from langgraph.types import interrupt as real_interrupt

        user_mod.interrupt = real_interrupt

    assert result == "user typed this directly"


def test_user_ask_handles_durable_question_answer_map() -> None:
    import shejane_runtime.tools.user as user_mod

    original = user_mod.interrupt
    user_mod.interrupt = lambda _payload: {"question-id": ["自动换名"]}
    try:
        result = user_mod.user_ask.invoke({"question": "如何处理？"})
    finally:
        user_mod.interrupt = original

    assert result == "自动换名"
