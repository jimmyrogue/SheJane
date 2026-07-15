"""SSE streaming contract — the most drift-prone interface (CLAUDE.md
invariant #3). Drives a REAL run through the daemon's run/stream pipeline with
a deterministic in-process fake LLM (SHEJANE_FAKE_LLM) — no cloud, no key — and
asserts the wire envelope + canonical event names that the TS client parses.

Hermetic: runs in `make local-host-test` / CI with no external dependency.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from local_host.config import reset_settings_for_tests
from local_host.server import create_app
from tests.helpers import run_command

_TRANSIENT_EVENT_TYPES = {
    "llm.delta",
    "llm.round.started",
    "llm.reasoning",
    "llm.usage",
    "llm.tool_call_chunk",
    "subagent.spawned",
}


def _client(tmp_path) -> TestClient:
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_FAKE_LLM=True,
        data_dir=tmp_path,
    )
    return TestClient(create_app(settings))


def _run_and_read(client: TestClient, goal: str) -> tuple[str, str]:
    r = client.post(
        "/local/v1/runs",
        headers={"Authorization": "Bearer tok"},
        json=run_command(goal),
    )
    assert r.status_code == 200, r.text
    run_id = r.json()["id"]
    with client.stream(
        "GET", f"/local/v1/runs/{run_id}/stream", headers={"Authorization": "Bearer tok"}
    ) as resp:
        assert resp.status_code == 200
        ctype = resp.headers.get("content-type", "")
        body = resp.read().decode("utf-8")
    return ctype, body


def _envelopes(raw: str) -> list[dict]:
    out: list[dict] = []
    for line in raw.split("\n"):
        line = line.strip()
        if not line.startswith("data:"):
            continue
        data = line[len("data:") :].strip()
        if not data or data == "[DONE]":
            continue
        out.append(json.loads(data))
    return out


def test_sse_stream_envelope_and_event_names(tmp_path) -> None:
    with _client(tmp_path) as client:
        ctype, raw = _run_and_read(client, "say hello")

    assert ctype.startswith("text/event-stream")
    # Terminator is `data: [DONE]` — NOT the old `event: stream.end`.
    assert "data: [DONE]" in raw
    assert "stream.end" not in raw

    envelopes = _envelopes(raw)
    assert envelopes, "no SSE events received"

    # Every event has an identity; only durable events own a replay cursor.
    for e in envelopes:
        for key in ("event_type", "payload", "id", "run_id", "created_at"):
            assert key in e, f"missing envelope key {key!r} in {e}"
        assert ("seq" not in e) if e["event_type"] in _TRANSIENT_EVENT_TYPES else ("seq" in e)

    names = [e["event_type"] for e in envelopes]
    assert "run.started" in names
    assert "llm.delta" in names
    assert "run.completed" in names
    # Canonical names, not the retired ones.
    assert "llm.token" not in names
    assert "tool.end" not in names

    # The fake reply streamed through as llm.delta content.
    text = "".join(
        str(e["payload"].get("content", "")) for e in envelopes if e["event_type"] == "llm.delta"
    )
    assert "Fake daemon reply" in text


def test_sse_stream_seq_is_monotonic(tmp_path) -> None:
    with _client(tmp_path) as client:
        _, raw = _run_and_read(client, "hello again")
    seqs = [e["seq"] for e in _envelopes(raw) if e.get("seq") is not None]
    assert seqs == sorted(seqs), f"seq not monotonic: {seqs}"
    assert len(seqs) == len(set(seqs)), "duplicate seq values"
