"""Run coordinator — owns the run-id → asyncio.Task map + per-run event
queues, exposes start / cancel / resume / stream primitives that the
FastAPI handlers wrap.

Streaming pipeline
------------------
For each run:

  agent.astream(stream_mode=["updates","messages","custom"])
       │ (LangGraph emits node updates, message chunks, custom events)
       ▼
  RunCoordinator._drive_run loops, pushes each event into the queue
       │
       ▼
  /v1/runs/:id/stream SSE handler awaits queue.get() and yields one
  SSE frame per event. Sentinel `None` ends the stream.

Cancellation is a `task.cancel()` on the driver coroutine. LangGraph
propagates CancelledError into the graph and the checkpointer persists
state up to the last superstep.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator

from langchain_core.load.dump import dumps as lc_dumps
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command

from .agent.builder import build_agent
from .event_translator import translate
from .store.sqlite import LocalStore

log = logging.getLogger("local_host.runs")


class RunCoordinator:
    def __init__(
        self,
        store: LocalStore,
        checkpointer: AsyncSqliteSaver,
    ) -> None:
        self.store = store
        self.checkpointer = checkpointer
        self._tasks: dict[str, asyncio.Task[Any]] = {}
        self._queues: dict[str, asyncio.Queue[Any]] = {}
        self._goals: dict[str, str] = {}
        self._workspaces: dict[str, str | None] = {}

    # ---- public API ----

    async def start_run(
        self,
        *,
        goal: str,
        workspace_path: str | None = None,
        mode: str = "fast",
    ) -> dict[str, Any]:
        run = await self.store.create_run(goal=goal, workspace_path=workspace_path)
        run_id = run["id"]
        queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=2048)
        self._queues[run_id] = queue
        self._goals[run_id] = goal
        self._workspaces[run_id] = workspace_path

        task = asyncio.create_task(
            self._drive_run(
                run_id=run_id,
                resume_payload=None,
                mode=mode,
            )
        )
        self._tasks[run_id] = task
        return run

    async def resume_run(
        self,
        *,
        run_id: str,
        decision: dict[str, Any],
    ) -> bool:
        """Resume a paused run with a decision payload (e.g. permission
        approve/deny). Returns False if the run isn't paused or unknown."""
        if run_id in self._tasks:
            # already running — caller should cancel + resume, but for
            # MVP we just refuse double-resume.
            return False
        if run_id not in self._queues:
            # We may be resuming after a daemon restart — recreate the queue.
            self._queues[run_id] = asyncio.Queue(maxsize=2048)
        task = asyncio.create_task(
            self._drive_run(
                run_id=run_id,
                resume_payload=decision,
                mode="fast",
            )
        )
        self._tasks[run_id] = task
        return True

    async def cancel_run(self, run_id: str) -> bool:
        task = self._tasks.get(run_id)
        if task is None:
            return False
        task.cancel()
        return True

    async def stream(self, run_id: str) -> AsyncIterator[dict[str, Any]]:
        queue = self._queues.get(run_id)
        if queue is None:
            # No live queue — replay persisted events (Phase 4'+: real replay)
            for event in await self.store.events_since(run_id, after_seq=0):
                yield {
                    "event": event["event_type"],
                    "data": json.loads(event["payload_json"]),
                }
            yield {"event": "run.done", "data": {"reason": "no-live-queue"}}
            return

        while True:
            item = await queue.get()
            if item is None:
                return
            yield item

    # ---- driver ----

    async def _drive_run(
        self,
        *,
        run_id: str,
        resume_payload: dict[str, Any] | None,
        mode: str,
    ) -> None:
        queue = self._queues[run_id]
        workspace_path = self._workspaces.get(run_id)
        goal = self._goals.get(run_id, "")

        try:
            agent = await build_agent(
                store=self.store,
                checkpointer=self.checkpointer,
                workspace_root=workspace_path,
                run_id=run_id,
                mode=mode,
            )
            config = {"configurable": {"thread_id": run_id}}
            if resume_payload is not None:
                input_payload: Any = Command(resume=resume_payload)
                await self._enqueue(queue, run_id, "run.resumed", {"payload": resume_payload})
            else:
                input_payload = {"messages": [{"role": "user", "content": goal}]}
                await self.store.update_run_status(run_id, "running")
                await self._enqueue(queue, run_id, "run.started", {"goal": goal})

            async for kind, payload in agent.astream(
                input_payload,
                config=config,
                stream_mode=["updates", "messages", "custom"],
            ):
                # Translate raw LangGraph events into our client-facing
                # SSE schema (see local_host.event_translator).
                for translated in translate(kind, payload):
                    await self._enqueue(
                        queue,
                        run_id,
                        translated["event"],
                        translated["data"]
                        if isinstance(translated["data"], dict)
                        else {"value": translated["data"]},
                    )

            # Check for interrupts via the saver's current state.
            snapshot = await agent.aget_state(config)
            if snapshot.next:
                await self.store.update_run_status(run_id, "waiting_permission")
                await self._enqueue(
                    queue,
                    run_id,
                    "run.waiting",
                    {
                        "next": list(snapshot.next),
                        "interrupts": [
                            {"value": getattr(i, "value", None), "id": getattr(i, "id", None)}
                            for i in (snapshot.tasks[0].interrupts if snapshot.tasks else [])
                        ],
                    },
                )
            else:
                await self.store.update_run_status(run_id, "completed")
                final_text = _extract_final_text(snapshot.values)
                await self._enqueue(
                    queue, run_id, "run.completed", {"final_text": final_text}
                )

        except asyncio.CancelledError:
            await self.store.update_run_status(run_id, "canceled")
            await self._enqueue(queue, run_id, "run.canceled", {})
            raise
        except Exception as exc:  # noqa: BLE001
            log.exception("run %s failed", run_id)
            await self.store.update_run_status(run_id, "failed")
            await self._enqueue(
                queue,
                run_id,
                "run.failed",
                {"error": str(exc), "type": type(exc).__name__},
            )
        finally:
            await queue.put(None)  # stream sentinel
            self._tasks.pop(run_id, None)

    async def _enqueue(
        self,
        queue: asyncio.Queue,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        # Persist + stream simultaneously.
        try:
            await self.store.append_event(run_id, event_type, payload)
        except Exception as exc:  # noqa: BLE001
            log.warning("event persist failed (%s): %s", event_type, exc)
        try:
            queue.put_nowait({"event": event_type, "data": payload})
        except asyncio.QueueFull:
            log.warning("event queue full for %s; dropping %s", run_id, event_type)


# ---- helpers ----


def _serialize_payload(payload: Any) -> dict[str, Any]:
    """Best-effort conversion of LangGraph stream payloads into JSON-safe dicts."""
    try:
        return json.loads(lc_dumps(payload))
    except Exception:
        try:
            return json.loads(json.dumps(payload, default=str))
        except Exception:
            return {"repr": str(payload)}


def _extract_final_text(state_values: Any) -> str:
    if not isinstance(state_values, dict):
        return ""
    messages = state_values.get("messages") or []
    for message in reversed(messages):
        content = getattr(message, "content", None)
        if isinstance(content, str) and content.strip():
            return content
    return ""
