"""Task-local model binding for reusable LangGraph definitions."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable, Iterator, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from langchain_core.callbacks import (
    AsyncCallbackManagerForLLMRun,
    CallbackManagerForLLMRun,
)
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import BaseTool
from pydantic import Field

_CURRENT_MODEL: ContextVar[BaseChatModel | None] = ContextVar(
    "shejane_runtime_model",
    default=None,
)


@contextmanager
def bind_runtime_model(model: BaseChatModel):
    token = _CURRENT_MODEL.set(model)
    try:
        yield
    finally:
        _CURRENT_MODEL.reset(token)


class RuntimeModelProxy(BaseChatModel):
    """Model placeholder whose calls use the current execution's model."""

    bound_tools: list[Any] = Field(default_factory=list, exclude=True)
    tool_choice: str | None = Field(default=None, exclude=True)
    binding_kwargs: dict[str, Any] = Field(default_factory=dict, exclude=True)

    @property
    def _llm_type(self) -> str:
        return "shejane-runtime-model"

    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type | Callable[..., Any] | BaseTool],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> BaseChatModel:
        return self.model_copy(
            update={
                "bound_tools": list(tools),
                "tool_choice": tool_choice,
                "binding_kwargs": kwargs,
            }
        )

    def _active(self) -> Any:
        model = _CURRENT_MODEL.get()
        if model is None:
            raise RuntimeError("model call is outside a bound execution")
        if self.bound_tools:
            return model.bind_tools(
                self.bound_tools,
                tool_choice=self.tool_choice,
                **self.binding_kwargs,
            )
        return model

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        message = await self._active().ainvoke(messages, stop=stop, **kwargs)
        return ChatResult(generations=[ChatGeneration(message=message)])

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        message = self._active().invoke(messages, stop=stop, **kwargs)
        return ChatResult(generations=[ChatGeneration(message=message)])

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        async for message in self._active().astream(messages, stop=stop, **kwargs):
            yield ChatGenerationChunk(message=message)

    def _stream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        for message in self._active().stream(messages, stop=stop, **kwargs):
            yield ChatGenerationChunk(message=message)
