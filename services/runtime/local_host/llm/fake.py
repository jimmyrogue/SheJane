"""FakeBackendChatModel — a deterministic, network-free chat model.

Gated by SHEJANE_FAKE_LLM (config.fake_llm). Streams a fixed reply so the
real run → SSE pipeline (event names + envelope) can be contract-tested
without a live cloud LLM. NEVER enabled in production.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from typing import Any

from langchain_core.callbacks import (
    AsyncCallbackManagerForLLMRun,
    CallbackManagerForLLMRun,
)
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

FAKE_REPLY = "Fake daemon reply for the SSE contract test."


class FakeBackendChatModel(BaseChatModel):
    """Streams `FAKE_REPLY` token-by-token, makes no tool calls, no network."""

    @property
    def _llm_type(self) -> str:
        return "shejane-fake"

    def bind_tools(self, tools: Any = None, **kwargs: Any) -> BaseChatModel:
        # The fake never calls tools; binding is a no-op that keeps the
        # create_deep_agent assembly path (which binds tools) working.
        return self

    def _pieces(self) -> list[str]:
        words = FAKE_REPLY.split(" ")
        return [w + (" " if i < len(words) - 1 else "") for i, w in enumerate(words)]

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        for piece in self._pieces():
            chunk = ChatGenerationChunk(message=AIMessageChunk(content=piece))
            if run_manager is not None:
                await run_manager.on_llm_new_token(piece, chunk=chunk)
            yield chunk

    def _stream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        for piece in self._pieces():
            yield ChatGenerationChunk(message=AIMessageChunk(content=piece))

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=FAKE_REPLY))])

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=FAKE_REPLY))])
