"""FakeBackendChatModel — a deterministic, network-free chat model.

Gated by SHEJANE_FAKE_LLM (config.fake_llm). It provides deterministic E2E
scenarios so the real agent, tool, pause/resume and SSE paths can be tested
without a live provider. NEVER enabled in production.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Iterator
from typing import Any

from langchain_core.callbacks import (
    AsyncCallbackManagerForLLMRun,
    CallbackManagerForLLMRun,
)
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

FAKE_REPLY = "Fake daemon reply for the SSE contract test."


class FakeBackendChatModel(BaseChatModel):
    """Streams deterministic replies and tool calls without network access."""

    @property
    def _llm_type(self) -> str:
        return "shejane-fake"

    def bind_tools(self, tools: Any = None, **kwargs: Any) -> BaseChatModel:
        # Binding is a no-op; deterministic tool calls are produced by
        # _response while the real compiled agent executes the tools.
        return self

    def _pieces(self, text: str) -> list[str]:
        words = text.split(" ")
        return [w + (" " if i < len(words) - 1 else "") for i, w in enumerate(words)]

    def _response(self, messages: list[BaseMessage]) -> AIMessage:
        prompt = "\n".join(str(message.content) for message in messages)
        if "[[e2e:write-file]]" in prompt:
            result = _last_tool_result(messages, "write_file")
            if result is None:
                return AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": "call_e2e_write_file",
                            "name": "write_file",
                            "args": {
                                "file_path": "approved.txt",
                                "content": "approved by E2E",
                            },
                        }
                    ],
                )
            return AIMessage(content="E2E approved file written.")
        if "[[e2e:ask]]" in prompt:
            result = _last_tool_result(messages, "user.ask")
            if result is None:
                return AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": "call_e2e_question",
                            "name": "user.ask",
                            "args": {
                                "question": "Choose an E2E option",
                                "options": ["Option A", "Option B"],
                            },
                        }
                    ],
                )
            return AIMessage(content=f"E2E selected: {result.content}")
        if "[[e2e:read-attachment]]" in prompt:
            result = _last_tool_result(messages, "read_file")
            if result is None:
                return AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": "call_e2e_read_attachment",
                            "name": "read_file",
                            "args": {"file_path": "/attachments/e2e-receipt.pdf"},
                        }
                    ],
                )
            extracted = (
                "E2E rental receipt"
                if "E2E rental receipt" in str(result.content)
                else "attachment text missing"
            )
            return AIMessage(content=f"E2E attachment read: {extracted}")
        return AIMessage(content=FAKE_REPLY)

    def _chunks(self, messages: list[BaseMessage]) -> Iterator[ChatGenerationChunk]:
        response = self._response(messages)
        if response.tool_calls:
            for index, call in enumerate(response.tool_calls):
                yield ChatGenerationChunk(
                    message=AIMessageChunk(
                        content="",
                        tool_call_chunks=[
                            {
                                "id": call["id"],
                                "name": call["name"],
                                "args": json.dumps(call["args"]),
                                "index": index,
                            }
                        ],
                    )
                )
            return
        for piece in self._pieces(str(response.content)):
            yield ChatGenerationChunk(message=AIMessageChunk(content=piece))

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        if "[[e2e:slow]]" in "\n".join(str(message.content) for message in messages):
            chunk = ChatGenerationChunk(message=AIMessageChunk(content="E2E working "))
            if run_manager is not None:
                await run_manager.on_llm_new_token("E2E working ", chunk=chunk)
            yield chunk
            await asyncio.sleep(30)
            yield ChatGenerationChunk(message=AIMessageChunk(content="finished"))
            return
        for chunk in self._chunks(messages):
            if run_manager is not None and chunk.message.content:
                await run_manager.on_llm_new_token(str(chunk.message.content), chunk=chunk)
            yield chunk

    def _stream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        yield from self._chunks(messages)

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=self._response(messages))])

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=self._response(messages))])


def _last_tool_result(messages: list[BaseMessage], name: str) -> ToolMessage | None:
    return next(
        (
            message
            for message in reversed(messages)
            if isinstance(message, ToolMessage) and message.name == name
        ),
        None,
    )
