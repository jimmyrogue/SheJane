"""Durable model-call boundary for the Runtime.

Every model invocation reserves a row before contacting a provider, records the
first model-visible output before yielding it, and settles usage from the final
provider response. Product usage is read from this ledger, never reconstructed
from a client SSE connection.
"""

from __future__ import annotations

import asyncio
import json
import math
from collections.abc import AsyncIterator, Callable, Iterator, Sequence
from typing import Any

import httpx
from langchain_core.callbacks import AsyncCallbackManagerForLLMRun, CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    SystemMessage,
    trim_messages,
)
from langchain_core.messages.utils import count_tokens_approximately
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import BaseTool
from pydantic import Field

from ..middleware.tool_visibility import visible_tools_for_messages
from ..store.sqlite import LocalStore
from .backend import BackendLLMError


class ModelContextBudgetExceeded(RuntimeError):
    code = "model_context_budget_exhausted"
    retryable = False


class ModelContextProfileMissing(RuntimeError):
    code = "model_context_profile_missing"
    retryable = False


class LedgerChatModel(BaseChatModel):
    """Wrap one bound provider model with durable reservation and settlement."""

    delegate: BaseChatModel = Field(exclude=True)
    store: Any = Field(exclude=True)
    run_id: str
    execution_attempt_id: str
    model_name: str
    max_calls: int
    tool_schema_tokens: int = 0
    bound_tools: tuple[Any, ...] = Field(default_factory=tuple, exclude=True)
    bound_tool_choice: Any = Field(default=None, exclude=True)
    bound_tool_kwargs: dict[str, Any] = Field(default_factory=dict, exclude=True)

    @property
    def _llm_type(self) -> str:
        return "shejane-ledger"

    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type | Callable[..., Any] | BaseTool],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> BaseChatModel:
        return self.model_copy(
            update={
                "bound_tools": tuple(tools),
                "bound_tool_choice": tool_choice,
                "bound_tool_kwargs": dict(kwargs),
                "tool_schema_tokens": _estimate_tool_tokens(tools),
            }
        )

    def _provider_model(
        self,
        messages: list[BaseMessage],
    ) -> tuple[BaseChatModel, int]:
        if not self.bound_tools:
            return self.delegate, self.tool_schema_tokens
        visible_tools = visible_tools_for_messages(self.bound_tools, messages)
        return (
            self.delegate.bind_tools(
                visible_tools,
                tool_choice=self.bound_tool_choice,
                **self.bound_tool_kwargs,
            ),
            _estimate_tool_tokens(visible_tools),
        )

    async def _reserve(self) -> dict[str, Any]:
        store = self.store
        if not isinstance(store, LocalStore):
            raise RuntimeError("model ledger store is not bound")
        return await store.reserve_model_call(
            run_id=self.run_id,
            execution_attempt_id=self.execution_attempt_id,
            model=self.model_name,
            max_calls=self.max_calls,
        )

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        provider_model, tool_schema_tokens = self._provider_model(messages)
        messages = self._bounded_messages(messages, tool_schema_tokens=tool_schema_tokens)
        receipt = await self._reserve()
        output_started = False
        try:
            message = await provider_model.ainvoke(
                messages,
                stop=stop,
                config={"callbacks": []},
                **kwargs,
            )
            if _has_visible_output(message):
                await self.store.mark_model_call_output(
                    run_id=self.run_id,
                    call_id=receipt["id"],
                )
                output_started = True
            usage = _usage_from_message(message)
            await self.store.settle_model_call(
                run_id=self.run_id,
                call_id=receipt["id"],
                provider_request_id=_request_id_from_message(message),
                input_tokens=usage.get("input_tokens"),
                output_tokens=usage.get("output_tokens"),
                credits_cost=usage.get("credits_cost"),
            )
            return ChatResult(generations=[ChatGeneration(message=message)])
        except BaseException as exc:
            await asyncio.shield(
                self.store.fail_model_call(
                    run_id=self.run_id,
                    call_id=receipt["id"],
                    outcome_unknown=output_started or _outcome_may_be_unknown(exc),
                    error_code=_error_code(exc),
                )
            )
            raise

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        provider_model, tool_schema_tokens = self._provider_model(messages)
        messages = self._bounded_messages(messages, tool_schema_tokens=tool_schema_tokens)
        receipt = await self._reserve()
        output_started = False
        usage: dict[str, int | None] = {}
        provider_request_id: str | None = None
        try:
            async for message in provider_model.astream(
                messages,
                stop=stop,
                config={"callbacks": []},
                **kwargs,
            ):
                if not output_started and _has_visible_output(message):
                    await self.store.mark_model_call_output(
                        run_id=self.run_id,
                        call_id=receipt["id"],
                    )
                    output_started = True
                current_usage = _usage_from_message(message)
                if current_usage:
                    usage = current_usage
                provider_request_id = _request_id_from_message(message) or provider_request_id
                yield ChatGenerationChunk(message=message)
            await self.store.settle_model_call(
                run_id=self.run_id,
                call_id=receipt["id"],
                provider_request_id=provider_request_id,
                input_tokens=usage.get("input_tokens"),
                output_tokens=usage.get("output_tokens"),
                credits_cost=usage.get("credits_cost"),
            )
        except BaseException as exc:
            await asyncio.shield(
                self.store.fail_model_call(
                    run_id=self.run_id,
                    call_id=receipt["id"],
                    outcome_unknown=output_started or _outcome_may_be_unknown(exc),
                    error_code=_error_code(exc),
                )
            )
            raise

    def _bounded_messages(
        self,
        messages: list[BaseMessage],
        *,
        tool_schema_tokens: int | None = None,
    ) -> list[BaseMessage]:
        profile_limit = (self.profile or {}).get("max_input_tokens")
        if not isinstance(profile_limit, int) or profile_limit <= 0:
            raise ModelContextProfileMissing("selected model does not declare max_input_tokens")
        max_input_tokens = int(profile_limit)
        schema_tokens = (
            self.tool_schema_tokens if tool_schema_tokens is None else tool_schema_tokens
        )
        if schema_tokens >= int(max_input_tokens * 0.9):
            raise ModelContextBudgetExceeded(
                "visible tool schemas exceed the selected model's context budget "
                f"({schema_tokens} >= {int(max_input_tokens * 0.9)})"
            )
        # Leave room for provider framing and schemas that cannot be measured
        # exactly by LangChain's message counter.
        message_budget = int(max_input_tokens * 0.9) - max(0, int(schema_tokens))
        if message_budget < 128:
            raise ModelContextBudgetExceeded(
                "selected model has insufficient context capacity for a minimum "
                f"request ({message_budget} tokens remain)"
            )
        return _enforce_context_envelope(messages, max_tokens=message_budget)

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        raise RuntimeError("LedgerChatModel is async-only")

    def _stream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        raise RuntimeError("LedgerChatModel is async-only")


def _has_visible_output(message: BaseMessage) -> bool:
    content = getattr(message, "content", None)
    if isinstance(content, str) and bool(content):
        return True
    if isinstance(content, list) and bool(content):
        return True
    if isinstance(message, (AIMessage, AIMessageChunk)):
        if message.tool_calls or getattr(message, "tool_call_chunks", None):
            return True
        return bool(message.additional_kwargs.get("reasoning_content"))
    return False


def _usage_from_message(message: BaseMessage) -> dict[str, int | None]:
    raw = getattr(message, "usage_metadata", None)
    if not isinstance(raw, dict) and isinstance(message, (AIMessage, AIMessageChunk)):
        raw = message.additional_kwargs.get("usage")
    if not isinstance(raw, dict):
        return {}
    return {
        "input_tokens": _int_or_none(raw.get("input_tokens")),
        "output_tokens": _int_or_none(raw.get("output_tokens")),
        "credits_cost": _int_or_none(raw.get("credits_cost")),
    }


def _request_id_from_message(message: BaseMessage) -> str | None:
    metadata = getattr(message, "response_metadata", None)
    if not isinstance(metadata, dict):
        return None
    value = metadata.get("request_id") or metadata.get("id")
    return str(value) if value else None


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _outcome_may_be_unknown(exc: BaseException) -> bool:
    return isinstance(
        exc,
        (
            asyncio.CancelledError,
            httpx.TimeoutException,
            httpx.TransportError,
            TimeoutError,
            ConnectionError,
        ),
    )


def _error_code(exc: BaseException) -> str:
    if isinstance(exc, BackendLLMError) and exc.code:
        return exc.code[:100]
    if isinstance(exc, httpx.HTTPStatusError):
        return f"http_{exc.response.status_code}"
    return type(exc).__name__[:100]


def _enforce_context_envelope(
    messages: list[BaseMessage],
    *,
    max_tokens: int,
) -> list[BaseMessage]:
    """Return a deterministic, explicit provider-safe message envelope."""
    if _conservative_token_count(messages) <= max_tokens:
        return messages

    max_single_chars = max(1_000, int(max_tokens * 0.65))
    bounded = [_truncate_large_message(message, max_chars=max_single_chars) for message in messages]
    if _conservative_token_count(bounded) <= max_tokens:
        return bounded

    marker = SystemMessage(
        content=(
            "[Runtime context envelope: older model input was omitted to fit the "
            "selected model's declared context window. Do not assume omitted details.]"
        )
    )
    marker_tokens = _conservative_token_count([marker])
    trimmed = trim_messages(
        bounded,
        max_tokens=max(128, max_tokens - marker_tokens),
        token_counter=_conservative_token_count,
        strategy="last",
        allow_partial=True,
        include_system=True,
    )
    insert_at = 1 if trimmed and isinstance(trimmed[0], SystemMessage) else 0
    result = [*trimmed[:insert_at], marker, *trimmed[insert_at:]]
    if _conservative_token_count(result) <= max_tokens:
        return result
    return trim_messages(
        result,
        max_tokens=max_tokens,
        token_counter=_conservative_token_count,
        strategy="last",
        allow_partial=True,
        include_system=True,
    )


def _truncate_large_message(message: BaseMessage, *, max_chars: int) -> BaseMessage:
    content = message.content
    if not isinstance(content, str) or len(content) <= max_chars:
        return message
    marker = f"\n\n[Runtime truncated {len(content) - max_chars} characters from this message.]\n\n"
    available = max(2, max_chars - len(marker))
    head = available // 2
    tail = available - head
    return message.model_copy(update={"content": content[:head] + marker + content[-tail:]})


def _estimate_tool_tokens(
    tools: Sequence[dict[str, Any] | type | Callable[..., Any] | BaseTool],
) -> int:
    serializable: list[Any] = []
    for tool in tools:
        if isinstance(tool, dict):
            serializable.append(tool)
            continue
        schema: Any = {}
        args_schema = getattr(tool, "args_schema", None)
        if args_schema is not None:
            try:
                schema = args_schema.model_json_schema()
            except Exception:
                schema = str(args_schema)
        serializable.append(
            {
                "name": getattr(tool, "name", getattr(tool, "__name__", "")),
                "description": getattr(tool, "description", ""),
                "input_schema": schema,
            }
        )
    payload = json.dumps(serializable, ensure_ascii=False, default=str)
    try:
        import tiktoken

        encoded = tiktoken.get_encoding("cl100k_base").encode(payload)
        # Tool schemas are controlled Runtime JSON rather than arbitrary user
        # prose. A 50% margin covers provider tokenizer differences while
        # avoiding the unusable one-character-per-token bound for ASCII JSON.
        return max(0, math.ceil(len(encoded) * 1.5))
    except Exception:
        # Fail conservatively when the tokenizer is unavailable.
        return max(0, len(payload))


def _conservative_token_count(messages: list[BaseMessage]) -> int:
    return count_tokens_approximately(messages, chars_per_token=1.0)
