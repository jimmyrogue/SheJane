"""Phase 9' — end-to-end capability smoke.

These tests run the real Python daemon (FastAPI app via TestClient) with
the LLM transport mocked at the `httpx.AsyncClient` boundary. Each test
verifies one wired-up capability:

  1. HumanInTheLoopMiddleware  — destructive tool triggers `run.waiting`
  2. SubAgentMiddleware        — `task` tool call surfaces `subagent.spawned`
  3. PromptCaching             — Go Anthropic gateway adds `cache_control`
  4. Local direct fallback     — ignored even when stale env supplies models
  5. PIIMiddleware             — email in user goal is `[REDACTED_EMAIL]`-replaced
                                  before the LLM sees it
  6. MemoryMiddleware          — AGENTS.md content lands in the outgoing
                                  system prompt
  7. TodoListMiddleware        — `write_todos` tool is in the agent toolset

Per capability: ~30 lines, one assertion per fact. They're "real path"
in everything except the LLM responses themselves.
"""

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

# --- shared mock backend helpers ---


def _sse(events: list[tuple[str, dict[str, Any]]]) -> httpx.Response:
    body = "".join(
        f"event: {name}\ndata: {json.dumps(payload)}\n\n" for name, payload in events
    ).encode("utf-8")
    return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})


class RecordingHandler:
    """httpx.MockTransport callable that records every request body and
    returns a scripted SSE response based on call index.

    A list of canned responses is provided; each request pops the next.
    Falls back to a generic "done" stream if exhausted.
    """

    def __init__(self, scripts: list[list[tuple[str, dict[str, Any]]]]):
        self.scripts = list(scripts)
        self.requests: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body_bytes = request.read()
        try:
            self.requests.append(json.loads(body_bytes))
        except json.JSONDecodeError:
            self.requests.append({"raw": body_bytes.decode("utf-8", errors="replace")})
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
    tmp = Path(tempfile.mkdtemp(prefix="jdl-e2e-"))
    os.environ["SHEJANE_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.setattr("local_host.llm.backend.httpx.AsyncClient", _patched_async_client(handler))
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_ADDR="127.0.0.1",
        SHEJANE_LOCAL_HOST_PORT=17371,
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp,
    )
    app = create_app(settings)
    return TestClient(app)


def _parse_sse(body: str) -> list[tuple[str, dict[str, Any]]]:
    """Return list of (event_type, payload) — payload is auto-unwrapped
    from the AgentRunEvent envelope (Block 0). The `event:` framing
    line is dropped in favor of the envelope's `event_type`, so tests
    can keep asserting on payload contents (e.g. `data["goal"]`)."""
    events: list[tuple[str, dict[str, Any]]] = []
    name = ""
    buf: list[str] = []

    def flush() -> None:
        nonlocal name, buf
        if not (name or buf):
            return
        try:
            data = json.loads("\n".join(buf))
        except json.JSONDecodeError:
            data = {"raw": "\n".join(buf)}
        if isinstance(data, dict) and "event_type" in data and "payload" in data:
            events.append((str(data["event_type"]), data["payload"]))
        else:
            events.append((name, data))

    for raw in body.split("\n"):
        line = raw.rstrip("\r")
        if not line:
            flush()
            name = ""
            buf = []
            continue
        if line.startswith("event:"):
            name = line[6:].strip()
        elif line.startswith("data:"):
            buf.append(line[5:].strip())
    flush()
    return events


def _post_run_and_stream(
    client: TestClient,
    goal: str,
    *,
    workspace_path: str | None = None,
) -> list[tuple[str, dict[str, Any]]]:
    body = {"goal": goal}
    if workspace_path is not None:
        body["workspace_path"] = workspace_path
    r = client.post(
        "/local/v1/runs",
        headers={"Authorization": "Bearer tok"},
        json=body,
    )
    assert r.status_code == 200, r.text
    run_id = r.json()["id"]
    with client.stream(
        "GET",
        f"/local/v1/runs/{run_id}/stream",
        headers={"Authorization": "Bearer tok"},
    ) as resp:
        body_text = resp.read().decode("utf-8")
    return _parse_sse(body_text)


# ---- capability 1: HumanInTheLoop on destructive tool ----


def test_capability_1_humanintheloop_pauses_on_destructive_tool(monkeypatch) -> None:
    handler = RecordingHandler(
        scripts=[
            [
                # Mock LLM decides to call write_file (destructive).
                ("llm.delta", {"content_delta": "I'll write a file. "}),
                (
                    "llm.tool_call",
                    {
                        "id": "call_w1",
                        "name": "write_file",
                        "arguments": {"file_path": "spike.txt", "text": "hello"},
                    },
                ),
                ("llm.done", {"request_id": "r1", "finish_reason": "tool_calls"}),
            ]
        ]
    )
    with _make_client(monkeypatch, handler) as client:
        events = _post_run_and_stream(client, "please write a file")

    event_names = {e[0] for e in events}
    # HumanInTheLoop fires before write_file executes → graph pauses.
    assert "run.waiting" in event_names, (
        f"expected run.waiting (HumanInTheLoop interrupt). got: {sorted(event_names)}"
    )
    # Block 4 contract: each pause must also surface a narrow
    # `permission.required` event carrying a `request_id` the client
    # can post back to /local/v1/permissions/{id}. Without this the UI
    # has no way to render an approval card.
    assert "permission.required" in event_names, (
        f"expected permission.required SSE event alongside run.waiting. got: {sorted(event_names)}"
    )
    perm_event = next(e for e in events if e[0] == "permission.required")
    perm_payload = perm_event[1]
    assert perm_payload["request_id"]
    assert perm_payload["tool"] == "write_file"
    # `args` must round-trip — without them the approval card has no
    # context to show the user.
    assert perm_payload["arguments"]["file_path"] == "spike.txt"


def test_capability_1c_permission_resolved_event_clears_card(monkeypatch) -> None:
    """POST /permissions/:id must emit `permission.resolved` onto the
    SSE stream so the client's `hasPendingPermission` set (App.tsx:1339)
    drops the request_id and the approval card disappears. Without this
    the card stays visible after the user clicks approve even though
    the run has already moved on.
    """
    handler = RecordingHandler(
        scripts=[
            [
                (
                    "llm.tool_call",
                    {
                        "id": "call_w1",
                        "name": "write_file",
                        "arguments": {"file_path": "x.txt", "text": "hi"},
                    },
                ),
                ("llm.done", {"request_id": "r1", "finish_reason": "tool_calls"}),
            ],
            [
                ("llm.delta", {"content_delta": "ok"}),
                ("llm.done", {"request_id": "r2", "finish_reason": "stop"}),
            ],
        ]
    )
    with _make_client(monkeypatch, handler) as client:
        headers = {"Authorization": "Bearer tok"}
        run = client.post("/local/v1/runs", headers=headers, json={"goal": "write"}).json()
        with client.stream("GET", f"/local/v1/runs/{run['id']}/stream", headers=headers) as resp:
            resp.read()
        perm_id = next(
            e for e in _parse_sse_persisted(client, run["id"]) if e[0] == "permission.required"
        )[1]["request_id"]
        client.post(
            f"/local/v1/permissions/{perm_id}",
            headers=headers,
            json={"decision": "approve", "scope": "once"},
        )
        with client.stream("GET", f"/local/v1/runs/{run['id']}/stream", headers=headers) as resp:
            body = resp.read().decode("utf-8")
    events = _parse_sse(body)
    resolved = [e for e in events if e[0] == "permission.resolved"]
    assert resolved, "expected permission.resolved on the post-resume stream"
    assert resolved[0][1]["request_id"] == perm_id
    assert resolved[0][1]["decision"] == "approve"


def _parse_sse_persisted(client: TestClient, run_id: str) -> list[tuple[str, dict[str, Any]]]:
    """Fetch all persisted events for a run via /diagnostics — used by
    tests that need the pre-pause event list without re-streaming."""
    diag = client.get(
        f"/local/v1/runs/{run_id}/diagnostics",
        headers={"Authorization": "Bearer tok"},
    ).json()
    return [(e["event_type"], e["payload"]) for e in diag["events"]]


def test_capability_1d_scope_run_skips_subsequent_approvals(monkeypatch) -> None:
    """If the user picked 'Always allow for this run', subsequent HITL
    interrupts for the SAME tool in the SAME run must auto-resume
    without paging the user again. Daemon's auto-approve loop emits
    `permission.auto_approved` so the timeline still records what
    happened — the user just doesn't have to click."""
    handler = RecordingHandler(
        scripts=[
            # Turn 1: ask to write file A (paused by HITL)
            [
                (
                    "llm.tool_call",
                    {
                        "id": "call_a",
                        "name": "write_file",
                        "arguments": {"file_path": "a.txt", "text": "A"},
                    },
                ),
                ("llm.done", {"request_id": "r1", "finish_reason": "tool_calls"}),
            ],
            # Turn 2 (after first approve + tool exec): ask for file B
            # — would normally pause again, but scope=run should skip.
            [
                (
                    "llm.tool_call",
                    {
                        "id": "call_b",
                        "name": "write_file",
                        "arguments": {"file_path": "b.txt", "text": "B"},
                    },
                ),
                ("llm.done", {"request_id": "r2", "finish_reason": "tool_calls"}),
            ],
            # Turn 3 (after auto-approve + tool exec): final answer
            [
                ("llm.delta", {"content_delta": "done"}),
                ("llm.done", {"request_id": "r3", "finish_reason": "stop"}),
            ],
        ]
    )
    with _make_client(monkeypatch, handler) as client:
        headers = {"Authorization": "Bearer tok"}
        run = client.post(
            "/local/v1/runs", headers=headers, json={"goal": "write two files"}
        ).json()
        with client.stream("GET", f"/local/v1/runs/{run['id']}/stream", headers=headers) as resp:
            resp.read()
        # Approve once with scope="run" — caches the tool grant.
        perm_id = next(
            e for e in _parse_sse_persisted(client, run["id"]) if e[0] == "permission.required"
        )[1]["request_id"]
        client.post(
            f"/local/v1/permissions/{perm_id}",
            headers=headers,
            json={"decision": "approve", "scope": "run"},
        )
        with client.stream("GET", f"/local/v1/runs/{run['id']}/stream", headers=headers) as resp:
            body = resp.read().decode("utf-8")

    events = _parse_sse(body)
    names = [e[0] for e in events]
    # Run must NOT have paused again — no second permission.required.
    second_required = [e for e in events if e[0] == "permission.required"]
    assert not second_required, f"scope=run should suppress subsequent HITL prompts; got: {names}"
    # The auto-approve must surface as `permission.auto_approved` so the
    # timeline reflects the decision (chatStore.ts:184).
    auto = [e for e in events if e[0] == "permission.auto_approved"]
    assert auto, f"expected permission.auto_approved on auto-resumed tool. got: {names}"
    assert auto[0][1]["tool"] == "write_file"
    assert "run.completed" in names


def test_capability_1b_permission_approve_resumes_the_run(monkeypatch) -> None:
    """Full pause → POST /permissions/:id → resume cycle.

    Regression for the `decisions = interrupt(hitl_request)["decisions"]`
    KeyError: HumanInTheLoopMiddleware (langchain.agents.middleware) only
    accepts `Command(resume={"decisions": [{"type": "approve"|"reject"|...}]})`.
    Our `POST /local/v1/permissions/{id}` must translate the client's
    `{decision: 'approve'|'deny'}` body into that shape — if it passes
    the raw client payload through, the middleware crashes mid-resume
    and the run dies with no AI response."""
    handler = RecordingHandler(
        scripts=[
            # Turn 1: model asks to write a file (paused by HITL)
            [
                (
                    "llm.tool_call",
                    {
                        "id": "call_w1",
                        "name": "write_file",
                        "arguments": {"file_path": "ok.txt", "text": "x"},
                    },
                ),
                ("llm.done", {"request_id": "r1", "finish_reason": "tool_calls"}),
            ],
            # Turn 2 (after approve + tool exec): final answer
            [
                ("llm.delta", {"content_delta": "Wrote it."}),
                ("llm.done", {"request_id": "r2", "finish_reason": "stop"}),
            ],
        ]
    )
    with _make_client(monkeypatch, handler) as client:
        headers = {"Authorization": "Bearer tok"}
        r = client.post("/local/v1/runs", headers=headers, json={"goal": "write a file"})
        run_id = r.json()["id"]
        with client.stream("GET", f"/local/v1/runs/{run_id}/stream", headers=headers) as resp:
            body1 = resp.read().decode("utf-8")
        events1 = _parse_sse(body1)
        perm = next(e for e in events1 if e[0] == "permission.required")
        permission_id = perm[1]["request_id"]

        # Client-shape POST — must NOT include `run_id`, must use the
        # `decision/scope` keys per client.ts:resolveLocalPermission.
        approve = client.post(
            f"/local/v1/permissions/{permission_id}",
            headers=headers,
            json={"decision": "approve", "scope": "once"},
        )
        assert approve.status_code == 200, approve.text
        assert approve.json()["resolved"] is True

        # Drain post-resume stream — should reach run.completed (not
        # run.failed with KeyError: 'decisions').
        with client.stream("GET", f"/local/v1/runs/{run_id}/stream", headers=headers) as resp:
            body2 = resp.read().decode("utf-8")

    events2 = _parse_sse(body2)
    names2 = {e[0] for e in events2}
    assert "run.completed" in names2, f"expected run.completed after approve. got: {sorted(names2)}"
    assert "run.failed" not in names2, "approve resume should not crash the graph"


# ---- capability 2: SubAgent dispatch ----


def test_capability_2_subagent_task_surfaces_spawned_event(monkeypatch) -> None:
    handler = RecordingHandler(
        scripts=[
            [
                ("llm.delta", {"content_delta": "Let me research that. "}),
                (
                    "llm.tool_call",
                    {
                        "id": "call_t1",
                        "name": "task",
                        "arguments": {
                            "subagent_name": "researcher",
                            "description": "find the latest LangGraph release notes",
                        },
                    },
                ),
                ("llm.done", {"request_id": "r2", "finish_reason": "tool_calls"}),
            ],
            # Researcher subagent's LLM turn — return a short finding then done.
            [
                ("llm.delta", {"content_delta": "Found notes."}),
                ("llm.done", {"request_id": "r3", "finish_reason": "stop"}),
            ],
        ]
    )
    with _make_client(monkeypatch, handler) as client:
        events = _post_run_and_stream(client, "research the latest LangGraph notes")

    event_names = [e[0] for e in events]
    # When the main LLM emits a `task` tool_call, our event_translator
    # surfaces it as `subagent.spawned`.
    assert "subagent.spawned" in event_names, (
        f"expected subagent.spawned for task() call. got: {event_names}"
    )


# ---- capability 3: prompt caching stays in the cloud gateway ----


def test_capability_3_prompt_caching_is_gateway_owned(
    monkeypatch,
) -> None:
    """The daemon should keep provider-specific prompt caching out of its wire
    contract. The Go Anthropic gateway adds top-level cache_control for long
    requests so local and web/cloud loops share one caching policy."""
    handler = RecordingHandler(
        scripts=[
            [
                ("llm.delta", {"content_delta": "ok"}),
                ("llm.done", {"request_id": "r1", "finish_reason": "stop"}),
            ]
        ]
    )
    with _make_client(monkeypatch, handler) as client:
        _post_run_and_stream(client, "say ok")

    assert len(handler.requests) >= 1
    assert "cache_control" not in json.dumps(handler.requests)


# ---- capability 4: local direct ModelFallback is disabled ----


def test_capability_4_local_direct_modelfallback_ignored(monkeypatch, caplog) -> None:
    """Local Host must not instantiate vendor fallback clients.

    Provider fallback belongs in the Go model gateway/catalog so provider keys
    and credit accounting stay in the cloud control plane. A stale
    SHEJANE_LOCAL_FALLBACK_MODELS value should be tolerated for compatibility,
    but ignored.
    """
    monkeypatch.setenv(
        "SHEJANE_LOCAL_FALLBACK_MODELS",
        "anthropic:claude-haiku-4,openai:gpt-4o-mini",
    )
    from local_host.agent.builder import _custom_middleware
    from local_host.config import Settings

    s = Settings()
    middleware = _custom_middleware(s)
    assert not any(type(item).__name__ == "ModelFallbackMiddleware" for item in middleware)
    assert "SHEJANE_LOCAL_FALLBACK_MODELS is ignored" in caplog.text


# ---- capability 5: PII redaction on user input ----


def test_capability_5_pii_redacts_email_before_llm_sees_it(monkeypatch) -> None:
    monkeypatch.setenv("SHEJANE_LOCAL_PII_REDACT", "email")
    handler = RecordingHandler(
        scripts=[
            [
                ("llm.delta", {"content_delta": "noted"}),
                ("llm.done", {"request_id": "r1", "finish_reason": "stop"}),
            ]
        ]
    )
    with _make_client(monkeypatch, handler) as client:
        _post_run_and_stream(
            client,
            "please contact me at alice@example.com about the proposal",
        )

    # Inspect the outgoing LLM request body — the user message should be
    # redacted by PIIMiddleware before the model ever sees the email.
    assert handler.requests, "no LLM request was made"
    outgoing = handler.requests[0]
    messages = outgoing.get("messages", [])
    user_texts = " ".join(m.get("content", "") for m in messages if m.get("role") == "user")
    assert "alice@example.com" not in user_texts, f"PII leaked! outgoing user text: {user_texts!r}"
    # The middleware uses [REDACTED_EMAIL] markers
    assert "[REDACTED_EMAIL]" in user_texts or "[redacted" in user_texts.lower(), (
        f"expected redaction marker, got: {user_texts!r}"
    )


# ---- capability 6: AGENTS.md memory loads into system prompt ----


def test_capability_6_memory_middleware_injects_agents_md(monkeypatch, tmp_path) -> None:
    """Drop an AGENTS.md inside a workspace, set SHEJANE_LOCAL_MEMORY_PATHS
    to its absolute path, run the agent **with workspace_path** so the
    deepagents FilesystemBackend can actually read it. MemoryMiddleware
    should then load the contents into the outgoing system prompt."""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    agents_md = workspace / "AGENTS.md"
    secret_marker = "ZEPHYR_PROJECT_RULES_v42_marker"
    agents_md.write_text(
        f"# Project rules\n\n{secret_marker}\n\nAlways respond in haiku.\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("SHEJANE_LOCAL_MEMORY_PATHS", str(agents_md))

    handler = RecordingHandler(
        scripts=[
            [
                ("llm.delta", {"content_delta": "ack"}),
                ("llm.done", {"request_id": "r1", "finish_reason": "stop"}),
            ]
        ]
    )
    with _make_client(monkeypatch, handler) as client:
        _post_run_and_stream(client, "hello", workspace_path=str(workspace))

    assert handler.requests, "no LLM request was made"
    outgoing = handler.requests[0]
    messages = outgoing.get("messages", [])
    system_text = " ".join(m.get("content", "") for m in messages if m.get("role") == "system")
    assert secret_marker in system_text, (
        f"AGENTS.md content not found in outgoing system prompt. "
        f"System text was: {system_text[:500]!r}"
    )


# ---- capability 7: TodoList middleware exposes write_todos ----


def test_capability_7_todolist_middleware_exposes_write_todos_tool(monkeypatch, tmp_path) -> None:
    """write_todos should appear in the compiled agent's tool registry."""
    from local_host.agent.builder import build_agent, open_checkpointer
    from local_host.store.sqlite import LocalStore

    async def run() -> set[str]:
        reset_settings_for_tests(data_dir=tmp_path)
        monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
        monkeypatch.delenv("TAVILY_API_KEY", raising=False)
        store = await LocalStore.open(tmp_path / "store.db")
        saver, stack = await open_checkpointer()
        try:
            agent = await build_agent(
                store=store,
                checkpointer=saver,
                workspace_root=str(tmp_path),
                run_id="t-todo-1",
            )
            tools_node = agent.nodes.get("tools")
            if tools_node is None:
                return set()
            bound = getattr(tools_node, "bound", None)
            return set(getattr(bound, "tools_by_name", {}).keys())
        finally:
            await store.close()
            await stack.aclose()

    names = asyncio.run(run())
    assert "write_todos" in names, f"write_todos missing. tools: {sorted(names)}"


# ---- bonus: a "happy path" capability sanity (capability 8) ----


def test_capability_2b_subagent_parallel_dispatch(monkeypatch) -> None:
    """Verify the LLM can dispatch **multiple** task() subagents in one
    turn. Mock LLM emits two `task` tool_calls in the same response —
    we should see two `subagent.spawned` events. ToolNode runs
    concurrency-safe tools in parallel via asyncio.gather, so we don't
    care about ordering; we only care both showed up."""
    handler = RecordingHandler(
        scripts=[
            [
                ("llm.delta", {"content_delta": "Dispatching two researchers. "}),
                (
                    "llm.tool_call",
                    {
                        "id": "call_p1",
                        "name": "task",
                        "arguments": {
                            "subagent_name": "researcher",
                            "description": "subquery A: LangGraph 1.x changes",
                        },
                    },
                ),
                (
                    "llm.tool_call",
                    {
                        "id": "call_p2",
                        "name": "task",
                        "arguments": {
                            "subagent_name": "researcher",
                            "description": "subquery B: deepagents adoption",
                        },
                    },
                ),
                ("llm.done", {"request_id": "rp", "finish_reason": "tool_calls"}),
            ],
            # Both researcher subagents share these scripted responses
            # (RecordingHandler pops them in order — either order works
            # because we just assert both spawn events are present).
            [
                ("llm.delta", {"content_delta": "found A"}),
                ("llm.done", {"request_id": "ra", "finish_reason": "stop"}),
            ],
            [
                ("llm.delta", {"content_delta": "found B"}),
                ("llm.done", {"request_id": "rb", "finish_reason": "stop"}),
            ],
        ]
    )
    with _make_client(monkeypatch, handler) as client:
        events = _post_run_and_stream(client, "compare two angles of LangGraph adoption")

    spawn_events = [e for e in events if e[0] == "subagent.spawned"]
    assert len(spawn_events) >= 2, (
        f"expected at least 2 subagent.spawned events. got {len(spawn_events)}: "
        f"{[e[1].get('id') for e in spawn_events]}"
    )
    spawn_ids = {e[1].get("id") for e in spawn_events}
    assert "call_p1" in spawn_ids
    assert "call_p2" in spawn_ids


def test_capability_9_memory_search_tool_in_agent(monkeypatch, tmp_path) -> None:
    """`memory.search` tool must appear in the compiled agent's toolset —
    that's the read-side of the long-term memory loop."""
    from local_host.agent.builder import build_agent, open_checkpointer, open_store
    from local_host.store.sqlite import LocalStore

    async def run() -> set[str]:
        reset_settings_for_tests(data_dir=tmp_path)
        monkeypatch.delenv("SHEJANE_LOCAL_MCP_SERVERS", raising=False)
        monkeypatch.delenv("TAVILY_API_KEY", raising=False)
        store = await LocalStore.open(tmp_path / "store.db")
        saver, ck_stack = await open_checkpointer()
        agent_store, st_stack = await open_store()
        try:
            agent = await build_agent(
                store=store,
                checkpointer=saver,
                agent_store=agent_store,
                workspace_root=str(tmp_path),
                run_id="t-mem-1",
            )
            tools_node = agent.nodes.get("tools")
            if tools_node is None:
                return set()
            bound = getattr(tools_node, "bound", None)
            return set(getattr(bound, "tools_by_name", {}).keys())
        finally:
            await store.close()
            await ck_stack.aclose()
            await st_stack.aclose()

    names = asyncio.run(run())
    assert "memory.search" in names


def test_capability_10_plan_first_injects_when_enabled(monkeypatch) -> None:
    """With SHEJANE_PLAN_FIRST=always, the outgoing system prompt must
    include the plan-first protocol instruction."""
    monkeypatch.setenv("SHEJANE_PLAN_FIRST", "always")
    handler = RecordingHandler(
        scripts=[
            [
                ("llm.delta", {"content_delta": "ok"}),
                ("llm.done", {"request_id": "r1", "finish_reason": "stop"}),
            ]
        ]
    )
    with _make_client(monkeypatch, handler) as client:
        _post_run_and_stream(client, "do the thing")

    assert handler.requests, "no LLM request was made"
    outgoing = handler.requests[0]
    messages = outgoing.get("messages", [])
    system_text = " ".join(m.get("content", "") for m in messages if m.get("role") == "system")
    assert "Plan-First protocol" in system_text or "write_todos" in system_text


def test_capability_8_happy_path_run_completes(monkeypatch) -> None:
    """End-to-end: a clean run goes from POST → SSE → run.completed."""
    handler = RecordingHandler(
        scripts=[
            [
                ("llm.delta", {"content_delta": "All done. "}),
                ("llm.done", {"request_id": "r1", "finish_reason": "stop"}),
            ]
        ]
    )
    with _make_client(monkeypatch, handler) as client:
        events = _post_run_and_stream(client, "say hi")

    event_names = [e[0] for e in events]
    assert "run.started" in event_names
    assert "run.completed" in event_names
    for name, data in events:
        if name == "run.completed":
            final = data.get("final_text", "") if isinstance(data, dict) else ""
            assert "All done" in final
            break
