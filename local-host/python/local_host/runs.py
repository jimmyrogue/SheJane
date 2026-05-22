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
from collections.abc import AsyncIterator
from typing import Any

from langchain_core.load.dump import dumps as lc_dumps
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.store.base import BaseStore
from langgraph.types import Command

from .agent.builder import build_agent
from .event_translator import translate
from .observability import build_callbacks
from .store.sqlite import LocalStore

log = logging.getLogger("local_host.runs")


class RunCoordinator:
    def __init__(
        self,
        store: LocalStore,
        checkpointer: AsyncSqliteSaver,
        agent_store: BaseStore | None = None,
    ) -> None:
        self.store = store
        self.checkpointer = checkpointer
        self.agent_store = agent_store
        self._tasks: dict[str, asyncio.Task[Any]] = {}
        self._queues: dict[str, asyncio.Queue[Any]] = {}
        self._goals: dict[str, str] = {}
        self._workspaces: dict[str, str | None] = {}
        self._histories: dict[str, list[dict[str, str]]] = {}
        self._settings_overrides: dict[str, dict[str, Any]] = {}
        # Per-run "scope=run" approvals. When the user clicks "Always
        # allow for this run" on an approval card, the tool name is
        # cached here so future HITL interrupts for the same tool in
        # the same run can be auto-approved without bothering the user.
        self._run_grants: dict[str, set[str]] = {}

    def grant_tool_scope(self, run_id: str, tool_name: str) -> None:
        """Mark `tool_name` as auto-approved for the rest of `run_id`.
        Subsequent HITL interrupts for that tool will be transparently
        resumed by `_drive_run`'s auto-approve loop instead of paging
        the user again."""
        if not tool_name:
            return
        self._run_grants.setdefault(run_id, set()).add(tool_name)

    async def emit_for_run(
        self,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        """Push a single envelope onto the run's live SSE queue.

        Used by HTTP handlers to surface side-effects (`permission.resolved`,
        `question.answered`) that originate from the API surface rather
        than the LangGraph stream itself. No-op if the run no longer has
        a live queue (it completed or was never started).
        """
        queue = self._queues.get(run_id)
        if queue is None:
            return
        await self._enqueue(queue, run_id, event_type, payload)

    # ---- public API ----

    async def start_run(
        self,
        *,
        goal: str,
        workspace_path: str | None = None,
        mode: str = "fast",
        history: list[dict[str, str]] | None = None,
        parent_run_id: str | None = None,
        settings: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Start a new agent run.

        `history`, `parent_run_id`, `settings` are the optional fields
        the client sends in the POST /runs body (see TS `createLocalRun`
        in client/src/shared/local-host/client.ts). Previously they
        were silently dropped — meaning every conversation turn restarted
        the agent with zero context (multi-turn memory broken in local
        mode). We persist them on the run row and feed `history` into
        the initial state.
        """
        run = await self.store.create_run(
            goal=goal,
            workspace_path=workspace_path,
            parent_run_id=parent_run_id,
            settings=settings,
        )
        run_id = run["id"]
        queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=2048)
        self._queues[run_id] = queue
        self._goals[run_id] = goal
        self._workspaces[run_id] = workspace_path
        self._histories[run_id] = list(history or [])
        self._settings_overrides[run_id] = dict(settings or {})

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
        """Yield AgentRunEvent envelopes (matching the TS interface):
            {id, run_id, seq, event_type, payload, created_at}

        Live runs pull from the per-run asyncio.Queue. After daemon
        restart / mid-stream reconnect we fall back to replaying the
        persisted `local_events` table from the beginning. Either way
        the SSE handler in server.py knows the shape and just JSON-dumps
        each yielded dict into the `data:` line.
        """
        queue = self._queues.get(run_id)
        if queue is None:
            for event in await self.store.events_since(run_id, after_seq=0):
                yield {
                    "id": event["id"],
                    "run_id": event["run_id"],
                    "seq": event["seq"],
                    "event_type": event["event_type"],
                    "payload": json.loads(event["payload_json"] or "{}"),
                    "created_at": event["created_at"],
                }
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
                agent_store=self.agent_store,
                workspace_root=workspace_path,
                run_id=run_id,
                mode=mode,
            )
            config = {
                "configurable": {"thread_id": run_id},
                "callbacks": build_callbacks(),
            }
            if resume_payload is not None:
                input_payload: Any = Command(resume=resume_payload)
                await self._enqueue(queue, run_id, "run.resumed", {"payload": resume_payload})
            else:
                # Prepend conversation history (sent by the client on
                # every run-create) before the current user goal so
                # multi-turn context survives. Each history item is
                # `{role: 'user'|'assistant', content: str}` — directly
                # consumable by LangGraph's message reducer.
                history = self._histories.get(run_id, [])
                messages: list[dict[str, str]] = [
                    {"role": str(item.get("role", "user")), "content": str(item.get("content", ""))}
                    for item in history
                    if item.get("content")
                ]
                messages.append({"role": "user", "content": goal})
                input_payload = {"messages": messages}
                await self.store.update_run_status(run_id, "running")
                await self._enqueue(queue, run_id, "run.started", {"goal": goal})

            # Auto-approve loop. We may iterate multiple times if the
            # run hits successive HITL gates and every gated tool has
            # an in-run `scope=run` grant. Each iteration drains one
            # astream() cycle; on every paused state we either:
            #   • surface to the user (one-shot approval or a tool the
            #     user hasn't granted run-scope on), OR
            #   • build a synthetic Command(resume={"decisions": [...]})
            #     and loop again — making the pause invisible to the UI.
            while True:
                async for kind, payload in agent.astream(
                    input_payload,
                    config=config,
                    stream_mode=["updates", "messages", "custom"],
                ):
                    for translated in translate(kind, payload):
                        await self._enqueue(
                            queue,
                            run_id,
                            translated["event"],
                            translated["data"]
                            if isinstance(translated["data"], dict)
                            else {"value": translated["data"]},
                        )

                snapshot = await agent.aget_state(config)
                if not snapshot.next:
                    await self.store.update_run_status(run_id, "completed")
                    final_text = _extract_final_text(snapshot.values)
                    await self._enqueue(queue, run_id, "run.completed", {"final_text": final_text})
                    break

                interrupts = snapshot.tasks[0].interrupts if snapshot.tasks else []
                auto_resume = self._try_auto_approve(run_id, interrupts)
                if auto_resume is not None:
                    # All paused tool calls are pre-approved with
                    # scope=run. Surface `permission.auto_approved`
                    # events so the timeline still reflects what
                    # happened (chatStore.ts:184), then loop with the
                    # synthetic decisions.
                    for action in auto_resume["actions"]:
                        await self._enqueue(
                            queue,
                            run_id,
                            "permission.auto_approved",
                            {
                                "tool": action.get("name", ""),
                                "tool_name": action.get("name", ""),
                                "arguments": action.get("args", {}),
                            },
                        )
                    input_payload = Command(resume=auto_resume["payload"])
                    continue

                # Surface to user.
                await self.store.update_run_status(run_id, "waiting_permission")
                for snap_interrupt in interrupts:
                    await self._handle_interrupt(queue, run_id, snap_interrupt)
                await self._enqueue(
                    queue,
                    run_id,
                    "run.waiting",
                    {
                        "next": list(snapshot.next),
                        "interrupts": [
                            {"value": getattr(i, "value", None), "id": getattr(i, "id", None)}
                            for i in interrupts
                        ],
                    },
                )
                break

        except asyncio.CancelledError:
            await self.store.update_run_status(run_id, "canceled")
            await self._enqueue(queue, run_id, "run.canceled", {})
            raise
        except Exception as exc:
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
            # Drop the per-run queue too — once the driver has finished,
            # subsequent `stream()` calls (e.g. the client reconnecting
            # to a completed run for replay) must fall through to the
            # `events_since` persistence path. Without this they'd
            # latch onto the drained queue and `queue.get()` would
            # block forever.
            self._queues.pop(run_id, None)

    def _try_auto_approve(
        self,
        run_id: str,
        interrupts: list[Any],
    ) -> dict[str, Any] | None:
        """If EVERY paused tool call is for a tool that has a `scope=run`
        grant on this run, return the synthetic resume payload the
        HumanInTheLoopMiddleware expects:

            {"payload": {"decisions": [{"type": "approve"}, ...]},
             "actions": [<action_request dicts>, ...]}

        Returns None otherwise — caller surfaces the pause to the user.

        Why all-or-nothing: HITL middleware emits ONE interrupt with N
        bundled action_requests and expects N decisions back. If even
        one action is for a not-yet-granted tool, we have to pause and
        ask the user about *that one* — easiest path is to defer the
        whole batch to user review.
        """
        grants = self._run_grants.get(run_id, set())
        if not grants or not interrupts:
            return None
        all_actions: list[dict[str, Any]] = []
        for snap_interrupt in interrupts:
            value = getattr(snap_interrupt, "value", None)
            ar = value.get("action_requests") if isinstance(value, dict) else None
            if not isinstance(ar, list) or not ar:
                return None  # non-HITL or empty — defer to user
            for action in ar:
                if not isinstance(action, dict):
                    return None
                tool_name = str(action.get("name", ""))
                if tool_name not in grants:
                    return None
                all_actions.append(action)
        if not all_actions:
            return None
        return {
            "payload": {"decisions": [{"type": "approve"} for _ in all_actions]},
            "actions": all_actions,
        }

    async def _handle_interrupt(
        self,
        queue: asyncio.Queue,
        run_id: str,
        snap_interrupt: Any,
    ) -> None:
        """Bridge a LangGraph `interrupt(...)` into either:

        * `permission.required` (for `HumanInTheLoopMiddleware` gating
          destructive tools) — persisted in `local_permissions` so the
          renderer can resume after reload, and the POST resolver can
          look up `run_id` from the `permission_id` alone.
        * `question.asked` (for the `user.ask` tool) — persisted in
          `local_questions`.

        Without this bridge, both flows surface only as the generic
        `run.waiting` and the UI can't render approval bars or question
        prompts — the agent silently stalls forever from the user's
        point of view.
        """
        value = getattr(snap_interrupt, "value", None)
        if isinstance(value, dict) and value.get("kind") == "question":
            question_text = str(value.get("question", ""))
            options_raw = value.get("options") or []
            options = [str(opt) for opt in options_raw] if isinstance(options_raw, list) else []
            questions = [
                {
                    "question": question_text,
                    "options": options,
                }
            ]
            record = await self.store.create_question(
                run_id=run_id,
                tool_call_id=getattr(snap_interrupt, "id", None),
                questions=questions,
            )
            # Attach the persisted id back onto each question so the
            # renderer's answer-binding code has a stable key.
            for q in questions:
                q["id"] = record["id"]
            await self._enqueue(
                queue,
                run_id,
                "question.asked",
                {
                    "request_id": record["id"],
                    "questions": questions,
                },
            )
            return

        # HITL permission gate. `HumanInTheLoopMiddleware.after_model`
        # builds a `HITLRequest = {action_requests: [...], review_configs: [...]}`
        # and `interrupt()`s with it (see
        # langchain/agents/middleware/human_in_the_loop.py:354). Each
        # `action_request` is `{name, args, description?}` for one tool
        # call that needs approval. We persist one permission row per
        # action_request so the UI can show per-tool approval cards.
        action_requests: list[dict[str, Any]] = []
        if isinstance(value, dict):
            ar_raw = value.get("action_requests")
            if isinstance(ar_raw, list):
                action_requests = [a for a in ar_raw if isinstance(a, dict)]
        if not action_requests:
            # Legacy / non-HITL interrupt shape — fall back to a single
            # generic record so we still surface something.
            action_requests = [{"name": "", "args": {}}]
        for action in action_requests:
            tool_name = str(action.get("name", ""))
            args_raw = action.get("args") or {}
            arguments = args_raw if isinstance(args_raw, dict) else {"value": args_raw}
            description = action.get("description") or ""
            record = await self.store.create_permission(
                run_id=run_id,
                tool_call_id="",  # HITL request doesn't carry the original
                # tool_call_id; the middleware re-attaches
                # it on resume from `last_ai_msg.tool_calls`.
                tool_name=tool_name,
                arguments=arguments,
            )
            await self._enqueue(
                queue,
                run_id,
                "permission.required",
                {
                    "request_id": record["id"],
                    "tool": tool_name,
                    "tool_name": tool_name,
                    "arguments": arguments,
                    "description": description,
                },
            )

    async def _enqueue(
        self,
        queue: asyncio.Queue,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        """Persist + stream simultaneously.

        The queue item shape MUST match the TS `AgentRunEvent` interface
        (`event_type`, `payload`, `id`, `run_id`, `seq`, `created_at`) —
        the client's `parseAgentSSEChunk` reads `data.event_type` and
        `data.payload.*` from inside the SSE JSON body, NOT from the
        `event:` line. Returning the bare payload (the old shape) made
        every event arrive as `{event_type: undefined}` on the client.
        """
        envelope: dict[str, Any]
        try:
            event = await self.store.append_event(run_id, event_type, payload)
            envelope = {
                "id": event["id"],
                "run_id": event["run_id"],
                "seq": event["seq"],
                "event_type": event_type,
                "payload": payload,
                "created_at": event["created_at"],
            }
        except Exception as exc:
            log.warning("event persist failed (%s): %s", event_type, exc)
            # Synthesize a transient envelope so the stream still
            # progresses even when persistence is broken.
            envelope = {
                "id": "",
                "run_id": run_id,
                "seq": 0,
                "event_type": event_type,
                "payload": payload,
                "created_at": "",
            }
        try:
            queue.put_nowait(envelope)
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
