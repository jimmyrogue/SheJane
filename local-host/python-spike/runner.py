"""Python sidecar entry point for Phase 0 spike.

Connects to a Unix domain socket whose path comes from --socket, registers
`run.start`, `run.resume`, `run.cancel`, `health.ping` and then enters the
RPC main loop. Each `run.start` spawns a LangGraph traversal in a task.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import os
import signal
import sys
from typing import Any

from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command

from graph import build_graph, current_rpc, current_run_id

log = logging.getLogger("runner")


class RunnerState:
    def __init__(self, rpc, app) -> None:
        self.rpc = rpc
        self.app = app
        self.active: dict[str, asyncio.Task[Any]] = {}
        self.cancel_events: dict[str, asyncio.Event] = {}


async def stream_run(state: RunnerState, run_id: str, initial_input: dict[str, Any] | None) -> None:
    """Drive one graph invocation through to completion (or interrupt)."""
    tok_rpc = current_rpc.set(state.rpc)
    tok_id = current_run_id.set(run_id)
    config = {"configurable": {"thread_id": run_id}}
    cancel = state.cancel_events.setdefault(run_id, asyncio.Event())
    try:
        if initial_input is None:
            # resume from interrupt
            payload: Any = Command(resume=state._resume_value)  # type: ignore[attr-defined]
        else:
            payload = initial_input

        async for event in state.app.astream(payload, config=config, stream_mode="updates"):
            if cancel.is_set():
                await state.rpc.notify("run.canceled", {"runId": run_id})
                return
            # event is a dict[node_name, state_delta] with possibly non-serializable
            # values (e.g. langgraph Interrupt). Only forward the node names to keep
            # the spike contract narrow; rich telemetry can be wired later.
            await state.rpc.notify(
                "graph.update",
                {"runId": run_id, "nodes": list(event.keys()) if isinstance(event, dict) else []},
            )

        final = await state.app.aget_state(config)
        if final.next:  # graph paused on interrupt
            await state.rpc.notify(
                "run.waiting",
                {"runId": run_id, "next": list(final.next), "tasks": [t.name for t in final.tasks]},
            )
        else:
            await state.rpc.notify(
                "run.completed",
                {"runId": run_id, "finalText": final.values.get("final_text")},
            )
    except Exception as e:
        log.exception("run %s failed", run_id)
        await state.rpc.notify(
            "run.failed", {"runId": run_id, "errorMessage": str(e), "errorType": type(e).__name__}
        )
    finally:
        current_rpc.reset(tok_rpc)
        current_run_id.reset(tok_id)
        state.active.pop(run_id, None)
        state.cancel_events.pop(run_id, None)


def register_handlers(state: RunnerState) -> None:
    async def on_run_start(params: dict[str, Any]) -> dict[str, Any]:
        run_id = params["runId"]
        if run_id in state.active:
            return {"status": "already_running"}
        initial = {
            "run_id": run_id,
            "step": 0,
            "status": "running",
            "scenario": params.get("scenario", "time"),
            "messages": [{"role": "user", "content": params.get("goal", "")}],
        }
        task = asyncio.create_task(stream_run(state, run_id, initial))
        state.active[run_id] = task
        return {"status": "started"}

    async def on_run_resume(params: dict[str, Any]) -> dict[str, Any]:
        run_id = params["runId"]
        if run_id in state.active:
            return {"status": "already_running"}
        state._resume_value = params.get("payload")  # type: ignore[attr-defined]
        task = asyncio.create_task(stream_run(state, run_id, None))
        state.active[run_id] = task
        return {"status": "resumed"}

    async def on_run_cancel(params: dict[str, Any]) -> dict[str, Any]:
        run_id = params["runId"]
        ev = state.cancel_events.get(run_id)
        if ev:
            ev.set()
        return {"status": "cancel_signaled"}

    async def on_health_ping(_params: dict[str, Any]) -> dict[str, Any]:
        return {"ok": True, "pid": os.getpid(), "active": list(state.active.keys())}

    state.rpc.register("run.start", on_run_start)
    state.rpc.register("run.resume", on_run_resume)
    state.rpc.register("run.cancel", on_run_cancel)
    state.rpc.register("health.ping", on_health_ping)


async def main_async(socket_path: str, checkpoint_path: str) -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [py] %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    log.info("connecting to %s", socket_path)
    reader, writer = await asyncio.open_unix_connection(path=socket_path)

    from rpc import RpcEndpoint

    rpc = RpcEndpoint(reader, writer)

    async with AsyncSqliteSaver.from_conn_string(checkpoint_path) as checkpointer:
        # Eagerly materialize the schema before any run lands. Lazy-setup on
        # the first run.start raced with aiosqlite worker startup on macOS
        # APFS and surfaced as `sqlite3.OperationalError: disk I/O error`
        # (Phase 0 spike, ~90% reproducible).
        await checkpointer.setup()
        app = build_graph(checkpointer)
        state = RunnerState(rpc, app)
        state._resume_value = None  # type: ignore[attr-defined]
        register_handlers(state)
        log.info("ready, entering main loop")
        await rpc.notify("sidecar.ready", {"pid": os.getpid()})

        stop = asyncio.Event()

        def _on_signal() -> None:
            stop.set()

        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            with contextlib.suppress(NotImplementedError):
                loop.add_signal_handler(sig, _on_signal)

        run_task = asyncio.create_task(rpc.run())
        stop_task = asyncio.create_task(stop.wait())
        done, _pending = await asyncio.wait(
            {run_task, stop_task}, return_when=asyncio.FIRST_COMPLETED
        )
        for t in (run_task, stop_task):
            if not t.done():
                t.cancel()
        rpc.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True, help="Unix domain socket path to connect to")
    parser.add_argument(
        "--checkpoint",
        default=":memory:",
        help="SQLite checkpoint path (default: in-memory)",
    )
    args = parser.parse_args()
    try:
        asyncio.run(main_async(args.socket, args.checkpoint))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
