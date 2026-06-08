"""Real eval driver — drives a RUNNING local daemon over HTTP and parses its
SSE stream into a Trajectory. Used by `make eval` against the live stack
(needs MOCK_LLM=false + a real provider key for a meaningful score).

The SSE wire format is the daemon's canonical envelope (docs/client-sse-protocol.md):
each `data:` line is JSON {event_type, payload, ...}; `data: [DONE]` ends it.
"""

from __future__ import annotations

import json

import httpx

from .harness import EvalCase, Trajectory


class HttpDaemonDriver:
    def __init__(self, base_url: str, token: str, timeout: float = 180.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    @property
    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}

    async def run(self, case: EvalCase) -> Trajectory:
        body: dict[str, object] = {"goal": case.goal, "mode": case.mode}
        if case.settings:
            body["settings"] = case.settings
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            created = await client.post(
                f"{self.base_url}/local/v1/runs", json=body, headers=self._headers
            )
            created.raise_for_status()
            run_id = created.json()["id"]
            return await self._stream(client, run_id)

    async def _stream(self, client: httpx.AsyncClient, run_id: str) -> Trajectory:
        traj = Trajectory()
        async with client.stream(
            "GET", f"{self.base_url}/local/v1/runs/{run_id}/stream", headers=self._headers
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[len("data:") :].strip()
                if not data or data == "[DONE]":
                    if data == "[DONE]":
                        break
                    continue
                try:
                    event = json.loads(data)
                except json.JSONDecodeError:
                    continue
                _apply_event(traj, event)
        return traj


def _apply_event(traj: Trajectory, event: dict) -> None:
    event_type = event.get("event_type", "")
    payload = event.get("payload") or {}
    if event_type == "llm.delta":
        traj.final_text += str(payload.get("content", ""))
    elif event_type in ("tool.completed", "tool.failed"):
        tool = payload.get("tool") or payload.get("name")
        if tool:
            traj.tool_calls.append(str(tool))
        traj.steps += 1
    elif event_type == "llm.usage":
        traj.input_tokens += int(payload.get("input_tokens", 0) or 0)
        traj.output_tokens += int(payload.get("output_tokens", 0) or 0)
        traj.credits += int(payload.get("credits_cost", 0) or 0)
    elif event_type == "run.completed":
        final = payload.get("final_text")
        if final:
            traj.final_text = str(final)
        # run.completed carries authoritative per-turn totals.
        if payload.get("input_tokens") or payload.get("output_tokens"):
            traj.input_tokens = int(payload.get("input_tokens", 0) or 0)
            traj.output_tokens = int(payload.get("output_tokens", 0) or 0)
        if payload.get("credits_cost"):
            traj.credits = int(payload.get("credits_cost", 0) or 0)
    elif event_type == "run.failed":
        traj.failed = True
        traj.error = str(payload.get("message", "run failed"))
