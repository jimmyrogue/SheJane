"""End-to-end cancel test — proves `POST /local/v1/runs/:id/cancel`
actually interrupts a run that's mid-flight (not just returns false on
unknown ids).

Approach: monkey-patch `BackendChatModel._astream` to sleep between
yielded chunks, so the run is provably "in progress" when we cancel.
Then drive cancel from a background thread while the main thread reads
the SSE stream until termination.

What we assert:
  - `run.started` shows up first
  - `run.canceled` appears in the stream
  - Final run state is `canceled` in the store
  - cancel call itself returns 200 + canceled=True
"""

from __future__ import annotations

import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessageChunk
from langchain_core.outputs import ChatGenerationChunk

from local_host.config import reset_settings_for_tests
from local_host.server import create_app


async def _slow_astream(self, messages, stop=None, run_manager=None, **kwargs):
    """Patched BackendChatModel._astream: yields slowly so cancel races in.

    Sleeps 0.3s between chunks for a total runtime around 1.5s — plenty
    of room to fire a cancel in the middle.
    """
    import asyncio

    for token in ["Hello", " ", "world", " ", "this", " ", "is", " ", "slow"]:
        await asyncio.sleep(0.3)
        yield ChatGenerationChunk(message=AIMessageChunk(content=token))


@pytest.fixture
def slow_client(monkeypatch) -> TestClient:
    tmp = Path(tempfile.mkdtemp(prefix="jdl-cancel-"))
    os.environ["JIANDANLY_LOCAL_HOST_TOKEN"] = "tok"
    monkeypatch.delenv("JIANDANLY_LOCAL_MCP_SERVERS", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)

    # Patch the LLM stream to be artificially slow so cancel can interrupt.
    monkeypatch.setattr(
        "local_host.llm.backend.BackendChatModel._astream",
        _slow_astream,
    )

    settings = reset_settings_for_tests(
        JIANDANLY_LOCAL_HOST_ADDR="127.0.0.1",
        JIANDANLY_LOCAL_HOST_PORT=17371,
        JIANDANLY_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp,
    )
    app = create_app(settings)
    with TestClient(app) as c:
        yield c


def _parse_sse(body: str) -> list[tuple[str, str]]:
    """Return (event_name, raw_data) pairs."""
    out: list[tuple[str, str]] = []
    name = ""
    buf: list[str] = []
    for raw in body.split("\n"):
        line = raw.rstrip("\r")
        if not line:
            if name or buf:
                out.append((name, "\n".join(buf)))
            name = ""
            buf = []
            continue
        if line.startswith("event:"):
            name = line[6:].strip()
        elif line.startswith("data:"):
            buf.append(line[5:].strip())
    if name or buf:
        out.append((name, "\n".join(buf)))
    return out


def test_cancel_interrupts_running_run(slow_client: TestClient) -> None:
    headers = {"Authorization": "Bearer tok"}

    # Start the run
    r = slow_client.post("/local/v1/runs", headers=headers, json={"goal": "slow"})
    assert r.status_code == 200
    run_id = r.json()["id"]

    # Fire the cancel from a background thread after a short delay,
    # giving the driver loop time to enter the LLM call.
    cancel_response: dict[str, Any] = {}

    def cancel_after_delay() -> None:
        time.sleep(0.5)  # run has started, LLM call is mid-stream
        resp = slow_client.post(
            f"/local/v1/runs/{run_id}/cancel", headers=headers
        )
        cancel_response["status_code"] = resp.status_code
        cancel_response["body"] = resp.json()

    t = threading.Thread(target=cancel_after_delay, daemon=True)
    t.start()

    # Block on the SSE stream — should terminate when cancel propagates.
    with slow_client.stream(
        "GET", f"/local/v1/runs/{run_id}/stream", headers=headers
    ) as resp:
        body = resp.read().decode("utf-8")

    t.join(timeout=5)

    # Cancel call itself succeeded
    assert cancel_response.get("status_code") == 200
    assert cancel_response.get("body", {}).get("canceled") is True

    # SSE stream contains run.started + run.canceled, in that order
    events = _parse_sse(body)
    event_names = [e[0] for e in events]
    assert "run.started" in event_names, f"missing run.started in {event_names}"
    assert "run.canceled" in event_names, (
        f"missing run.canceled (cancel didn't propagate?) in {event_names}"
    )

    # Cancel should come AFTER started
    started_idx = event_names.index("run.started")
    canceled_idx = event_names.index("run.canceled")
    assert canceled_idx > started_idx

    # Store should reflect the cancel
    r = slow_client.get(f"/local/v1/runs/{run_id}", headers=headers)
    assert r.status_code == 200
    assert r.json()["status"] == "canceled"


def test_cancel_unknown_run_returns_false_canceled(slow_client: TestClient) -> None:
    """Sanity guard for the existing /cancel path on a non-existent id —
    we already covered this in test_runs_http.py but re-asserting alongside
    the mid-flight test makes the fixture set self-contained."""
    r = slow_client.post(
        "/local/v1/runs/run_nope/cancel",
        headers={"Authorization": "Bearer tok"},
    )
    assert r.status_code == 200
    assert r.json()["canceled"] is False
