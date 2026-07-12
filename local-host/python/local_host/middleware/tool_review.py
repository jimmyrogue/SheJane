"""Parameter-bound human review before consequential tool execution."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import AgentState
from langchain_core.messages import AIMessage, ToolCall, ToolMessage
from langgraph.runtime import Runtime
from langgraph.types import interrupt

from ..store.sqlite import LocalStore, PermissionDecisionConflictError
from .tool_execution import (
    current_execution_namespace,
    execution_scope_from_messages,
    serialize_tool_result,
    tool_operation_identity,
    tool_risk,
)


class ToolReviewStateError(RuntimeError):
    """A review resume does not match its persisted wait candidate."""

    code = "tool_review_state_invalid"
    retryable = False


def tool_requires_review(tool_name: str, risk: str) -> bool:
    """Return whether policy requires a person before this call executes."""
    if tool_name == "clipboard.read":
        return True
    return risk in {"workspace_write", "external_or_unknown"}


class ToolReviewMiddleware(AgentMiddleware):
    """Pause a complete model tool batch before any reviewed call executes.

    The interrupt carries stable call ids and argument fingerprints. A resume
    is accepted only when the corresponding durable permission rows contain
    the same decisions; callers cannot bypass the typed permission endpoint by
    posting an arbitrary LangGraph resume payload.
    """

    async def aafter_model(
        self,
        state: AgentState[Any],
        runtime: Runtime[Any],
    ) -> dict[str, Any] | None:
        messages = state.get("messages") or []
        last_ai = next(
            (message for message in reversed(messages) if isinstance(message, AIMessage)),
            None,
        )
        if last_ai is None or not last_ai.tool_calls:
            return None
        call_ids = [str(call.get("id") or "") for call in last_ai.tool_calls]
        if any(not call_id for call_id in call_ids) or len(call_ids) != len(set(call_ids)):
            raise ToolReviewStateError("tool review requires unique non-empty call ids per batch")

        context = runtime.context
        store = getattr(context, "store", None)
        run_id = str(getattr(context, "run_id", None) or "")
        execution_attempt_id = str(getattr(context, "execution_attempt_id", None) or "")
        tool_version = str(getattr(context, "graph_definition_id", None) or "")
        execution_namespace = execution_scope_from_messages(current_execution_namespace(), messages)
        if not isinstance(store, LocalStore) or not run_id or not execution_attempt_id:
            raise ToolReviewStateError("tool review is missing durable Runtime context")

        review_calls: list[tuple[int, ToolCall, dict[str, Any]]] = []
        action_requests: list[dict[str, Any]] = []
        artificial_messages: list[ToolMessage] = []
        tool_registry = getattr(context, "tool_registry", None)
        if not isinstance(tool_registry, dict):
            raise ToolReviewStateError("tool review is missing its frozen tool registry")
        for index, call in enumerate(last_ai.tool_calls):
            tool_call_id = str(call.get("id") or "")
            tool_name = str(call.get("name") or "")
            if not tool_name:
                raise ToolReviewStateError("tool review requires stable call ids and names")
            arguments = call.get("args") or {}
            operation_id, arguments_hash, _arguments_json = tool_operation_identity(
                run_id=run_id,
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                arguments=arguments,
                tool_version=tool_version,
                execution_namespace=execution_namespace,
            )
            risk = tool_risk(tool_name)
            validation_error = _tool_input_error(tool_registry.get(tool_name), arguments)
            if validation_error is not None:
                message = ToolMessage(
                    content=validation_error,
                    name=tool_name,
                    tool_call_id=tool_call_id,
                    status="error",
                )
                artificial_messages.append(message)
                await _record_preflight_failure(
                    store=store,
                    run_id=run_id,
                    execution_attempt_id=execution_attempt_id,
                    tool_version=tool_version,
                    execution_namespace=execution_namespace,
                    call=call,
                    operation_id=operation_id,
                    arguments_hash=arguments_hash,
                    risk=risk,
                    message=message,
                )
                continue
            if not tool_requires_review(tool_name, risk):
                continue
            current_permission = await store.get_permission_for_operation(
                run_id=run_id, operation_id=operation_id
            )
            # Code before LangGraph interrupt() is replayed on resume. The
            # current operation must reach interrupt() again to consume its
            # Command(resume=...). A run grant may skip only a *new* call id
            # with the same approved argument fingerprint.
            if current_permission is None:
                if await store.consume_run_permission_grant(
                    run_id=run_id,
                    operation_id=operation_id,
                    tool_name=tool_name,
                    tool_version=tool_version,
                    arguments_hash=arguments_hash,
                    risk=risk,
                ):
                    continue
            metadata = {
                "tool_call_id": tool_call_id,
                "operation_id": operation_id,
                "tool_version": tool_version,
                "arguments_hash": arguments_hash,
                "risk": risk,
            }
            review_calls.append((index, call, metadata))
            action_requests.append(
                {
                    "name": tool_name,
                    "args": arguments,
                    **metadata,
                    "description": _review_description(tool_name, arguments, risk),
                    "allowed_decisions": ["approve", "edit", "reject"],
                }
            )

        if not review_calls:
            if not artificial_messages:
                return None
            return {"messages": [last_ai, *artificial_messages]}

        response = interrupt(
            {
                "kind": "tool_review",
                "batch_mode": "pause_before_all",
                "action_requests": action_requests,
            }
        )
        decisions = response.get("decisions") if isinstance(response, dict) else None
        if not isinstance(decisions, list) or len(decisions) != len(review_calls):
            raise ToolReviewStateError("tool review decision count does not match the batch")

        revised_calls = list(last_ai.tool_calls)
        for decision, (index, original_call, metadata) in zip(decisions, review_calls, strict=True):
            if not isinstance(decision, dict):
                raise ToolReviewStateError("tool review decision is not an object")
            await _verify_persisted_decision(
                store=store,
                run_id=run_id,
                operation_id=metadata["operation_id"],
                decision=decision,
            )
            decision_type = decision.get("type")
            if decision_type == "approve":
                continue
            if decision_type == "edit":
                edited = decision.get("edited_action")
                if not isinstance(edited, dict) or not isinstance(edited.get("args"), dict):
                    raise ToolReviewStateError("edited tool action must contain object args")
                if str(edited.get("name") or "") != original_call["name"]:
                    raise ToolReviewStateError("tool review cannot change the tool name")
                edited_args = edited["args"]
                validation_error = _tool_input_error(
                    tool_registry.get(original_call["name"]), edited_args
                )
                if validation_error is not None:
                    message = ToolMessage(
                        content=validation_error,
                        name=original_call["name"],
                        tool_call_id=original_call["id"],
                        status="error",
                    )
                    artificial_messages.append(message)
                    edited_operation_id, edited_arguments_hash, _ = tool_operation_identity(
                        run_id=run_id,
                        tool_call_id=original_call["id"],
                        tool_name=original_call["name"],
                        arguments=edited_args,
                        tool_version=tool_version,
                        execution_namespace=execution_namespace,
                    )
                    await _record_preflight_failure(
                        store=store,
                        run_id=run_id,
                        execution_attempt_id=execution_attempt_id,
                        tool_version=tool_version,
                        execution_namespace=execution_namespace,
                        call=ToolCall(
                            type="tool_call",
                            id=original_call["id"],
                            name=original_call["name"],
                            args=edited_args,
                        ),
                        operation_id=edited_operation_id,
                        arguments_hash=edited_arguments_hash,
                        risk=tool_risk(original_call["name"]),
                        message=message,
                    )
                    continue
                revised_calls[index] = ToolCall(
                    type="tool_call",
                    id=original_call["id"],
                    name=original_call["name"],
                    args=edited_args,
                )
                continue
            if decision_type != "reject":
                raise ToolReviewStateError("unsupported tool review decision")
            message = ToolMessage(
                content=str(decision.get("message") or "Tool execution denied by user."),
                name=original_call["name"],
                tool_call_id=original_call["id"],
                status="error",
            )
            artificial_messages.append(message)
            await _record_rejection(
                store=store,
                run_id=run_id,
                execution_attempt_id=execution_attempt_id,
                tool_version=tool_version,
                execution_namespace=execution_namespace,
                call=original_call,
                metadata=metadata,
                message=message,
            )

        revised_ai = last_ai.model_copy(update={"tool_calls": revised_calls})
        return {"messages": [revised_ai, *artificial_messages]}


async def _verify_persisted_decision(
    *,
    store: LocalStore,
    run_id: str,
    operation_id: str,
    decision: dict[str, Any],
) -> None:
    record = await store.get_permission_for_operation(run_id=run_id, operation_id=operation_id)
    if record is None or record.get("status") == "pending":
        raise ToolReviewStateError("tool review was resumed without a resolved permission")
    expected = json.dumps(
        decision,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    if str(record.get("decision_json") or "") != expected:
        raise PermissionDecisionConflictError(
            "tool review resume does not match the persisted decision"
        )


async def _record_rejection(
    *,
    store: LocalStore,
    run_id: str,
    execution_attempt_id: str,
    tool_version: str,
    execution_namespace: str,
    call: ToolCall,
    metadata: dict[str, Any],
    message: ToolMessage,
) -> None:
    _operation_id, _arguments_hash, arguments_json = tool_operation_identity(
        run_id=run_id,
        tool_call_id=call["id"],
        tool_name=call["name"],
        arguments=call.get("args") or {},
        tool_version=tool_version,
        execution_namespace=execution_namespace,
    )
    receipt = await store.prepare_tool_receipt(
        operation_id=metadata["operation_id"],
        run_id=run_id,
        execution_attempt_id=execution_attempt_id,
        tool_call_id=call["id"],
        tool_name=call["name"],
        tool_version=tool_version,
        execution_namespace=execution_namespace,
        arguments_hash=metadata["arguments_hash"],
        arguments_json=arguments_json,
        risk=metadata["risk"],
    )
    if receipt.get("status") == "rejected":
        return
    result_json = serialize_tool_result(message)
    await store.settle_tool_receipt(
        operation_id=metadata["operation_id"],
        run_id=run_id,
        status="rejected",
        result_json=result_json,
        result_hash=hashlib.sha256(result_json.encode("utf-8")).hexdigest(),
    )


async def _record_preflight_failure(
    *,
    store: LocalStore,
    run_id: str,
    execution_attempt_id: str,
    tool_version: str,
    execution_namespace: str,
    call: ToolCall,
    operation_id: str,
    arguments_hash: str,
    risk: str,
    message: ToolMessage,
) -> None:
    _operation_id, _arguments_hash, arguments_json = tool_operation_identity(
        run_id=run_id,
        tool_call_id=call["id"],
        tool_name=call["name"],
        arguments=call.get("args") or {},
        tool_version=tool_version,
        execution_namespace=execution_namespace,
    )
    receipt = await store.prepare_tool_receipt(
        operation_id=operation_id,
        run_id=run_id,
        execution_attempt_id=execution_attempt_id,
        tool_call_id=call["id"],
        tool_name=call["name"],
        tool_version=tool_version,
        execution_namespace=execution_namespace,
        arguments_hash=arguments_hash,
        arguments_json=arguments_json,
        risk=risk,
    )
    if receipt.get("status") == "failed":
        return
    result_json = serialize_tool_result(message)
    await store.settle_tool_receipt(
        operation_id=operation_id,
        run_id=run_id,
        status="failed",
        result_json=result_json,
        result_hash=hashlib.sha256(result_json.encode("utf-8")).hexdigest(),
        error_type="ToolInputValidationError",
    )


def _tool_input_error(tool: Any, arguments: Any) -> str | None:
    if tool is None:
        return "Tool call rejected: the tool is not available in this Runtime definition."
    if not isinstance(arguments, dict):
        return "Tool call rejected: arguments must be an object."
    try:
        # tool_call_schema excludes injected ToolRuntime/store parameters;
        # get_input_schema includes them and would falsely reject every
        # Deep Agents filesystem tool for a missing `runtime` argument.
        schema = tool.tool_call_schema
        schema.model_validate(arguments)
    except Exception as exc:
        return f"Tool call rejected before execution: {type(exc).__name__}: {exc}"
    return None


def _review_description(tool_name: str, arguments: Any, risk: str) -> str:
    rendered = json.dumps(arguments, ensure_ascii=False, sort_keys=True, default=str)
    return f"Review {risk} tool `{tool_name}` with arguments: {rendered}"
