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
from .config import Settings, get_settings
from .event_translator import translate
from .llm.resolve import resolve_auto_model
from .observability import build_callbacks
from .store.sqlite import LocalStore

log = logging.getLogger("local_host.runs")

# Max number of historical messages (user + assistant turns combined,
# not counting the current user goal) we forward to the agent. Beyond
# this we keep the last N and surface a "dropped X earlier messages"
# notice via the ContextBuilder <state> layer so the model knows context
# is incomplete instead of silently losing it. 40 ≈ 20 user/assistant
# pairs, which covers most real conversations before we'd want LLM-based
# summarization anyway.
_MAX_HISTORY_TURNS = 40


def _merge_pii_types(base: str, extra: str) -> str:
    """Union two comma-separated PII entity-type lists, base order first.

    Used to enforce that a per-run client override can only ADD PII types to
    the machine/env baseline, never drop one — clearing the field must not
    re-expose data the deployment chose to redact before it reaches the cloud
    tool gateway. Dedup is case-insensitive; the first-seen spelling is kept.
    """
    out: list[str] = []
    seen: set[str] = set()
    for chunk in (base, extra):
        for raw in chunk.split(","):
            item = raw.strip()
            if not item:
                continue
            key = item.upper()
            if key not in seen:
                seen.add(key)
                out.append(item)
    return ",".join(out)


def _apply_advanced_overrides(base: Settings, run_settings: dict[str, Any]) -> Settings:
    """Fold the client's "Advanced" agent-settings knobs onto a copy of the
    base Settings.

    Knobs absent from `run_settings` keep the daemon's env/default value, so
    legacy callers (curl, tests, pre-panel client builds) are unaffected.
    `model_copy(update=...)` does NOT re-validate, so each value is coerced to
    its field's type here; unknown keys and unparseable / out-of-range values
    are ignored rather than crashing the run.

    Security-posture knobs (`input_guard`, `pii_redact`) are special-cased: a
    per-run override may only STRENGTHEN the machine/env baseline, never weaken
    it. A client cannot downgrade the input guard (e.g. block → observe) nor
    clear/shrink PII redaction — otherwise the per-run path would be a hole in
    a server-set data-protection policy.
    """
    overrides: dict[str, Any] = {}
    # Integer knobs.
    for key, field in (
        ("max_model_calls", "max_model_calls"),
        ("max_tool_retries", "max_tool_retries"),
        ("research_search_limit", "research_search_limit"),
        ("tool_selector_max", "tool_selector_max_tools"),
    ):
        raw = run_settings.get(key)
        if raw is None:
            continue
        try:
            overrides[field] = int(raw)
        except (TypeError, ValueError):
            pass
    # Boolean knobs (accept real bools or "on"/"true"/"1"/"yes").
    for key, field in (
        ("subagents", "enable_subagents"),
        ("reflect", "enable_critic_reflection"),
        ("browser_headless", "browser_headless"),
    ):
        raw = run_settings.get(key)
        if raw is None:
            continue
        overrides[field] = (
            raw if isinstance(raw, bool) else str(raw).strip().lower() in {"1", "true", "yes", "on"}
        )
    # Enumerated string knobs — only accepted from a fixed allow-list.
    # NOTE: input_guard is a security-posture knob handled separately below
    # (a per-run override may only strengthen it, never weaken it).
    for key, field, allowed in (
        ("tool_critic", "tool_critic_mode", {"off", "watch", "nudge", "block"}),
        ("plan_first", "plan_first_mode", {"off", "auto", "always"}),
    ):
        raw = run_settings.get(key)
        if raw is None:
            continue
        val = str(raw).strip().lower()
        if val in allowed:
            overrides[field] = val
    # Security-posture knob — input guard. A per-run override may only RAISE the
    # guard, never lower the machine/env baseline (strength: off < observe <
    # block). A client sending "observe" against a base of "block" is ignored.
    raw = run_settings.get("input_guard")
    if raw is not None:
        val = str(raw).strip().lower()
        rank = {"off": 0, "observe": 1, "block": 2}
        base_rank = rank.get(str(base.input_guard_mode).strip().lower(), 0)
        # Strictly-greater: only a real strengthening is applied; same-or-lower
        # is left at the baseline (same level would be a no-op copy anyway).
        if val in rank and rank[val] > base_rank:
            overrides["input_guard_mode"] = val
    # Security-posture knob — PII redaction. A per-run override may only ADD
    # entity types; it can never drop one the baseline redacts (so pii_redact=""
    # can't ship unredacted PII to the cloud gateway). Effective set = union.
    pii = run_settings.get("pii_redact")
    if pii is not None:
        merged = _merge_pii_types(base.pii_redact_types, str(pii))
        if merged != base.pii_redact_types:
            overrides["pii_redact_types"] = merged
    return base.model_copy(update=overrides) if overrides else base


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
        # Resolved tier per run (fast|deep|…). Mirrors local_runs.mode; lets a
        # resume after restart continue at the user's chosen tier.
        self._modes: dict[str, str] = {}
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
            mode=mode,
        )
        run_id = run["id"]
        queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=2048)
        self._queues[run_id] = queue
        self._goals[run_id] = goal
        self._workspaces[run_id] = workspace_path
        self._histories[run_id] = list(history or [])
        self._settings_overrides[run_id] = dict(settings or {})
        self._modes[run_id] = mode

        task = asyncio.create_task(
            self._drive_run(
                run_id=run_id,
                resume_payload=None,
                mode=mode,
            )
        )
        self._tasks[run_id] = task
        return run

    async def _hydrate_run_state(self, run_id: str) -> bool:
        """Repopulate the in-memory per-run caches from the DB when they're
        missing — the path after a daemon restart, where `resume_run` runs
        against empty dicts. Without this, a HITL resume rebuilds the agent
        with no workspace, default settings, and fast tier (a silently
        degraded sandbox). Idempotent: a no-op when the run is already cached
        in this process. Returns False if the run row doesn't exist."""
        if run_id in self._goals:
            return True
        run = await self.store.get_run(run_id)
        if run is None:
            return False
        self._goals[run_id] = run.get("goal") or ""
        self._workspaces[run_id] = run.get("workspace_path")
        self._modes[run_id] = run.get("mode") or "fast"
        try:
            self._histories[run_id] = json.loads(run.get("history_json") or "[]")
        except (TypeError, ValueError):
            self._histories[run_id] = []
        try:
            self._settings_overrides[run_id] = json.loads(run.get("settings_json") or "{}")
        except (TypeError, ValueError):
            self._settings_overrides[run_id] = {}
        grants = await self.store.grants_for_run(run_id)
        if grants:
            self._run_grants[run_id] = set(grants)
        return True

    async def recover_orphans(self) -> None:
        """At boot, reconcile runs left non-terminal by the previous process.
        `make dev-electron` SIGKILLs the daemon, so this is a routine path:
        - queued / running: the driving asyncio task died with the process and
          can't be re-attached — mark them failed so they don't sit `running`
          forever and the client shows a terminal state.
        - waiting_permission: paused at a checkpointed interrupt — leave it;
          `resume_run` rehydrates state from the DB when the user decides."""
        try:
            active = await self.store.list_active_runs()
        except Exception:
            log.exception("recover_orphans: failed to list active runs")
            return
        failed = 0
        kept = 0
        for run in active:
            status = run.get("status")
            run_id = run.get("id")
            if not run_id:
                continue
            if status in ("queued", "running"):
                try:
                    await self.store.update_run_status(run_id, "failed", completed_at=None)
                    failed += 1
                except Exception:
                    log.exception("recover_orphans: failed to fail run %s", run_id)
            elif status == "waiting_permission":
                kept += 1
        if failed or kept:
            log.info(
                "recover_orphans: %d orphaned run(s) marked failed, "
                "%d waiting_permission run(s) left resumable",
                failed,
                kept,
            )

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
        # Rehydrate per-run state from the DB so a resume after a daemon
        # restart keeps the original workspace / settings / tier instead of
        # silently degrading. Unknown run id → refuse.
        if not await self._hydrate_run_state(run_id):
            return False
        if run_id not in self._queues:
            # We may be resuming after a daemon restart — recreate the queue.
            self._queues[run_id] = asyncio.Queue(maxsize=2048)
        task = asyncio.create_task(
            self._drive_run(
                run_id=run_id,
                resume_payload=decision,
                mode=self._modes.get(run_id, "fast"),
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
            settings = get_settings()
            # The cloud owns model resolution (flat catalog). The daemon
            # forwards the user's selection; "pro" stays a wire alias for the
            # legacy "deep" tier for any old caller.
            resolved_model = "deep" if mode == "pro" else mode

            # "Auto": ask the cloud's task-aware classifier ONCE per run which
            # catalog model fits this goal, and surface model.selected so the
            # UI badges "Auto → <label> · reason". On any failure we stay on
            # "auto" — the cloud LLM endpoint maps that to the default model
            # per turn, so the run still works (just without the badge).
            if resume_payload is None and resolved_model in ("auto", ""):
                picked = await resolve_auto_model(
                    goal,
                    cloud_base_url=settings.cloud_base_url,
                    cloud_token=settings.cloud_token,
                    run_id=run_id,
                )
                if picked:
                    resolved_model = picked["model_id"]
                    await self._enqueue(
                        queue,
                        run_id,
                        "model.selected",
                        {
                            "requested_model": "auto",
                            "resolved_model_id": picked["model_id"],
                            "label": picked["label"],
                            "reason": picked["reason"],
                        },
                    )

            # Persist the resolved value so a resume (incl. after a daemon
            # restart) continues with the same model instead of a default.
            self._modes[run_id] = resolved_model
            if resume_payload is None:
                try:
                    await self.store.update_run_mode(run_id, resolved_model)
                except Exception:
                    log.warning("failed to persist model for run %s", run_id)

            # Build the message list early so we can hand the truncation
            # numbers (turn_count, dropped_history_count) to ContextBuilder
            # via build_agent. Resume runs reuse the agent's persisted
            # state and don't need the message-history bookkeeping —
            # LangGraph's checkpointer already has it.
            history = self._histories.get(run_id, [])
            full_messages: list[dict[str, str]] = [
                {"role": str(item.get("role", "user")), "content": str(item.get("content", ""))}
                for item in history
                if item.get("content")
            ]
            dropped_history_count = max(0, len(full_messages) - _MAX_HISTORY_TURNS)
            kept_messages = (
                full_messages[-_MAX_HISTORY_TURNS:] if dropped_history_count else full_messages
            )
            # +1 for the current user goal that gets appended below.
            turn_count = len(kept_messages) + 1

            run_settings = self._settings_overrides.get(run_id) or {}
            # Defaults: memory + skills + mcp all ON. The client's
            # agent settings panel has them enabled by default; legacy
            # callers (curl, tests) that don't send any settings
            # inherit the same default. Only an explicit "off" disables.
            memory_enabled = str(run_settings.get("memory", "on")).lower() != "off"
            skills_enabled = str(run_settings.get("skills", "on")).lower() != "off"
            mcp_enabled = str(run_settings.get("mcp", "on")).lower() != "off"
            # Code execution defaults ON now (since v7 of the client
            # storage, ~2026-05-26). The original opt-in toggle was
            # removed from the UI — first-call friction was costing
            # more than it was protecting (files only upload when the
            # LLM explicitly calls code.execute with files_in, which
            # already passes the daemon-side sensitive-filename
            # blacklist + size cap). The setting is still honored if
            # explicitly passed as "off" — leaves an env-level kill
            # switch for future enterprise/regulated deployments.
            code_exec_enabled = str(run_settings.get("code_exec", "on")).lower() != "off"
            # Per-server opt-out from the MCP tab. The client persists
            # a list of names the user disabled and ships it on every
            # run. Defensive coercion: drop non-strings and dedupe so
            # a buggy renderer can't crash the loop.
            raw_disabled = run_settings.get("mcp_disabled") or []
            mcp_disabled_servers: set[str] = {
                str(name) for name in raw_disabled if isinstance(name, str)
            }
            # Per-run effective settings = base daemon settings with any
            # "Advanced" knobs the client sent folded on top.
            effective_settings = _apply_advanced_overrides(settings, run_settings)
            agent = await build_agent(
                store=self.store,
                checkpointer=self.checkpointer,
                agent_store=self.agent_store,
                workspace_root=workspace_path,
                run_id=run_id,
                mode=resolved_model,
                task_goal=goal,
                turn_count=turn_count,
                dropped_history_count=dropped_history_count,
                memory_enabled=memory_enabled,
                skills_enabled=skills_enabled,
                mcp_enabled=mcp_enabled,
                mcp_disabled_servers=mcp_disabled_servers or None,
                code_exec_enabled=code_exec_enabled,
                settings=effective_settings,
            )
            config = {
                "configurable": {"thread_id": run_id},
                "callbacks": build_callbacks(),
            }
            if resume_payload is not None:
                input_payload: Any = Command(resume=resume_payload)
                await self._enqueue(queue, run_id, "run.resumed", {"payload": resume_payload})
            else:
                messages = list(kept_messages)
                messages.append({"role": "user", "content": goal})
                input_payload = {"messages": messages}
                if dropped_history_count:
                    log.info(
                        "history truncated for run %s: kept=%d dropped=%d",
                        run_id,
                        len(kept_messages),
                        dropped_history_count,
                    )
                await self.store.update_run_status(run_id, "running")
                await self._enqueue(queue, run_id, "run.started", {"goal": goal})

            # Per-turn usage accumulator. A single turn can make several
            # internal LLM calls (multi-step tool runs), each emitting one
            # llm.usage event; sum them so run.completed carries the turn
            # total for the client's usage chip.
            usage_totals = {"input_tokens": 0, "output_tokens": 0, "credits_cost": 0}

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
                        data = (
                            translated["data"]
                            if isinstance(translated["data"], dict)
                            else {"value": translated["data"]}
                        )
                        if translated["event"] == "llm.usage":
                            usage_totals["input_tokens"] += int(data.get("input_tokens", 0) or 0)
                            usage_totals["output_tokens"] += int(data.get("output_tokens", 0) or 0)
                            usage_totals["credits_cost"] += int(data.get("credits_cost", 0) or 0)
                        await self._enqueue(queue, run_id, translated["event"], data)

                snapshot = await agent.aget_state(config)
                if not snapshot.next:
                    await self.store.update_run_status(run_id, "completed")
                    final_text = _extract_final_text(snapshot.values)
                    await self._enqueue(
                        queue,
                        run_id,
                        "run.completed",
                        {"final_text": final_text, **usage_totals},
                    )
                    break

                # Gather interrupts from BOTH places LangGraph stores them:
                #   • snapshot.interrupts — aggregated top-level list
                #     (LangGraph 1.x). Reliable when present.
                #   • snapshot.tasks[*].interrupts — per-task lists. With
                #     parallel tool calls (e.g. ToolNode dispatches 3
                #     web.search + 1 user.ask in one step), each tool
                #     gets its own task; the user.ask interrupt lands in
                #     whichever task index ran it, NOT necessarily
                #     tasks[0]. Earlier code only checked tasks[0] and
                #     missed the interrupt → run stalled with empty
                #     interrupts and `next=["tools"]`.
                # We prefer the top-level list and fall back to scanning
                # every task. Dedupe by interrupt id so neither source
                # double-counts.
                interrupts_top = list(getattr(snapshot, "interrupts", ()) or ())
                interrupts_per_task = [
                    intr
                    for task in (snapshot.tasks or ())
                    for intr in (getattr(task, "interrupts", ()) or ())
                ]
                seen_ids: set[Any] = set()
                interrupts: list[Any] = []
                for intr in interrupts_top + interrupts_per_task:
                    key = getattr(intr, "id", None)
                    if key is None:
                        interrupts.append(intr)
                        continue
                    if key in seen_ids:
                        continue
                    seen_ids.add(key)
                    interrupts.append(intr)
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
            # The `user.ask` tool signature is `options: list[str]`, but
            # the TS `AgentQuestionChoice` contract is `{label, description?}`.
            # Normalize at this boundary — every option becomes an object
            # with `label`. If the agent ever upgrades to passing dicts
            # (e.g. with descriptions), we pass those through unchanged.
            # Without this conversion the renderer's parseQuestionPayload
            # filters out every string option and silently shows nothing.
            options = _normalize_question_options(options_raw)
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
    """Return the assistant's final visible answer for the run.

    Subtle bug we hit: walking ALL messages backwards and grabbing the
    first non-empty content would also pick up HumanMessages that
    middlewares injected for retry nudges (e.g. OutputGuardMiddleware
    appending "Your last response was empty…" as a HumanMessage when
    the assistant produced empty output). When the deepagents loop had
    already exited, that nudge ended up being the last message — and
    the user saw the system retry-prompt rendered as the assistant's
    final reply.

    Only AIMessages (`message.type == "ai"`) can be the assistant's
    actual answer. ToolMessages, HumanMessages, SystemMessages are
    never the visible final text.
    """
    if not isinstance(state_values, dict):
        return ""
    messages = state_values.get("messages") or []
    for message in reversed(messages):
        if getattr(message, "type", None) != "ai":
            continue
        content = getattr(message, "content", None)
        if isinstance(content, str) and content.strip():
            return content
    return ""


def _normalize_question_options(raw: Any) -> list[dict[str, str]]:
    """Coerce `user.ask` options into the {label, description?} shape the
    TS `AgentQuestionChoice` contract expects.

    The tool signature is `options: list[str]`, so the agent typically
    emits bare strings. Earlier behavior shipped these through unchanged,
    which the client's parseQuestionPayload silently filtered out
    (typeof option !== 'object' → undefined) leaving the question UI
    with zero options to render — the run looked stuck even though
    everything else was fine.

    Accepts:
        - a string         → {label: string}
        - a {label, ...}   → passed through, coerced to strings
        - anything else    → skipped
    """
    if not isinstance(raw, list):
        return []
    options: list[dict[str, str]] = []
    for item in raw:
        if isinstance(item, str):
            label = item.strip()
            if label:
                options.append({"label": label})
            continue
        if isinstance(item, dict):
            label = str(item.get("label", "")).strip()
            if not label:
                continue
            entry: dict[str, str] = {"label": label}
            description = item.get("description")
            if isinstance(description, str) and description.strip():
                entry["description"] = description.strip()
            options.append(entry)
    return options
