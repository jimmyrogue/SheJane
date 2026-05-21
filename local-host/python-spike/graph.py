"""Minimal LangGraph StateGraph for Phase 0 spike.

Three nodes:
  * llm_stub: emits N fake LLM tokens as `llm.token` RPC notifications,
              then decides whether to call a tool or finish.
  * tool_router: if a tool call is pending, asks Node-side via `tool.invoke`.
                 if the tool is destructive, interrupts for permission.
  * finalize: marks state as completed.

State carries messages + a tiny set of replaced scalars. This is the
minimum viable shape that exercises:
  * Python -> Node tool reverse-call
  * Python -> Node token streaming
  * interrupt() + Command(resume=) round-trip
  * AsyncSqliteSaver checkpoint
"""

from __future__ import annotations

import asyncio
import time
from contextvars import ContextVar
from typing import Annotated, Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from rpc import RpcEndpoint

# Bound from runner.py before invoking the graph so nodes can RPC.
current_rpc: ContextVar[RpcEndpoint] = ContextVar("current_rpc")
current_run_id: ContextVar[str] = ContextVar("current_run_id")


def append(left: list, right: list) -> list:
    return [*left, *right]


class AgentState(TypedDict, total=False):
    messages: Annotated[list[dict], append]
    events: Annotated[list[dict], append]
    run_id: str
    step: int
    status: Literal["running", "waiting_permission", "completed", "failed", "canceled"]
    scenario: Literal["time", "write"]
    pending_tool: dict[str, Any] | None
    final_text: str


DESTRUCTIVE_TOOLS = {"fs.write", "shell.run"}


async def llm_stub_node(state: AgentState) -> dict[str, Any]:
    """Stand in for a real LLM. Streams a few tokens, then either
    requests one tool call or finishes."""
    rpc = current_rpc.get()
    run_id = current_run_id.get()
    step = state.get("step", 0) + 1
    scenario = state.get("scenario", "time")

    # First step: stream tokens, then request a tool call (scenario-dependent).
    # Second step (after tool result returns): finish with a final message.
    if step == 1:
        if scenario == "write":
            tokens = ["I'll", " write", " the", " file", "..."]
            tool = {
                "id": f"call_{step}",
                "name": "fs.write",
                "arguments": {"path": "/tmp/spike.txt", "content": "hello"},
            }
        else:
            tokens = ["Let", " me", " check", " the", " current", " time", "..."]
            tool = {
                "id": f"call_{step}",
                "name": "time.now",
                "arguments": {"timezone": "UTC"},
            }
        for tok in tokens:
            await rpc.notify(
                "llm.token",
                {"runId": run_id, "content": tok, "step": step},
            )
            await asyncio.sleep(0.005)  # simulate token cadence
        return {
            "step": step,
            "pending_tool": tool,
            "messages": [{"role": "assistant", "content": "".join(tokens), "tool_calls": [tool]}],
        }

    # Step >= 2: emit closing tokens and finish.
    final = "Got it — the time check came back."
    await rpc.notify("llm.token", {"runId": run_id, "content": final, "step": step})
    return {
        "step": step,
        "pending_tool": None,
        "final_text": final,
        "status": "completed",
        "messages": [{"role": "assistant", "content": final}],
    }


async def tool_router_node(state: AgentState) -> dict[str, Any]:
    pending = state.get("pending_tool")
    if not pending:
        return {}

    rpc = current_rpc.get()
    run_id = current_run_id.get()

    # Permission gate via LangGraph interrupt() — destructive tools pause here.
    if pending["name"] in DESTRUCTIVE_TOOLS:
        permission_id = await rpc.call(
            "permission.create",
            {
                "runId": run_id,
                "toolCallId": pending["id"],
                "toolName": pending["name"],
                "arguments": pending["arguments"],
            },
        )
        decision = interrupt(
            {"kind": "permission", "id": permission_id, "tool": pending["name"]}
        )
        if not decision.get("approved"):
            return {
                "messages": [
                    {
                        "role": "tool",
                        "tool_call_id": pending["id"],
                        "content": {"error_code": "permission_denied"},
                    }
                ],
                "pending_tool": None,
            }

    started = time.perf_counter()
    result = await rpc.call(
        "tool.invoke",
        {
            "runId": run_id,
            "toolName": pending["name"],
            "callId": pending["id"],
            "arguments": pending["arguments"],
        },
    )
    elapsed_ms = (time.perf_counter() - started) * 1000

    await rpc.notify(
        "tool.completed",
        {"runId": run_id, "callId": pending["id"], "elapsedMs": elapsed_ms},
    )

    return {
        "messages": [
            {"role": "tool", "tool_call_id": pending["id"], "content": result}
        ],
        "pending_tool": None,
    }


def route_after_llm(state: AgentState) -> str:
    if state.get("pending_tool"):
        return "tool_router"
    if state.get("status") == "completed":
        return END
    return "llm_stub"


def build_graph(checkpointer) -> Any:
    graph = StateGraph(AgentState)
    graph.add_node("llm_stub", llm_stub_node)
    graph.add_node("tool_router", tool_router_node)
    graph.add_edge(START, "llm_stub")
    graph.add_conditional_edges("llm_stub", route_after_llm, {
        "tool_router": "tool_router",
        "llm_stub": "llm_stub",
        END: END,
    })
    graph.add_edge("tool_router", "llm_stub")
    return graph.compile(checkpointer=checkpointer)
