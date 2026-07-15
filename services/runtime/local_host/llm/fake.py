"""FakeBackendChatModel — a deterministic, network-free chat model.

Gated by SHEJANE_FAKE_LLM (config.fake_llm). It provides deterministic E2E
scenarios so the real agent, tool, pause/resume and SSE paths can be tested
without a live provider. NEVER enabled in production.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
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
        if "[[e2e:skill]]" in prompt:
            if "E2E_SKILL_ACTIVE" in prompt:
                return AIMessage(content="E2E Skill result: E2E_SKILL_ACTIVE")
            skill_path = _e2e_skill_path(prompt)
            if skill_path is None:
                return AIMessage(content="E2E Skill was not exposed to the model.")
            return AIMessage(
                content="",
                tool_calls=[
                    {
                        "id": "call_e2e_skill_read",
                        "name": "read_file",
                        "args": {"file_path": skill_path},
                    }
                ],
            )
        if "[[e2e:subagent-child]]" in prompt:
            return AIMessage(content="E2E_SUBAGENT_RESULT")
        if "[[e2e:subagent]]" in prompt:
            result = _last_tool_result(
                messages,
                "task",
                tool_call_id="call_e2e_subagent",
            )
            if result is None:
                return AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": "call_e2e_subagent",
                            "name": "task",
                            "args": {
                                "description": (
                                    "[[e2e:subagent-child]] Return the exact E2E result token."
                                ),
                                "subagent_type": "writer",
                            },
                        }
                    ],
                )
            return AIMessage(content=f"E2E parent received: {result.content}")
        if "[[e2e:write-todos]]" in prompt:
            result = _last_tool_result(
                messages,
                "write_todos",
                tool_call_id="call_e2e_write_todos",
            )
            if result is None:
                return AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": "call_e2e_write_todos",
                            "name": "write_todos",
                            "args": {
                                "todos": [
                                    {
                                        "content": "E2E_TODO_ACTIVE",
                                        "status": "in_progress",
                                    }
                                ]
                            },
                        }
                    ],
                )
            return AIMessage(content=f"E2E Todo result: {result.content}")
        if "Please remember that E2E memory fact." in prompt:
            result = _last_tool_result(messages, "memory.write")
            if result is None:
                return AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": "call_e2e_memory_write",
                            "name": "memory.write",
                            "args": {"fact": "E2E memory fact."},
                        }
                    ],
                )
            return AIMessage(content=f"E2E memory result: {result.content}")
        tool_request = _e2e_tool_request(prompt)
        if tool_request is not None:
            name, args = tool_request
            result = _last_tool_result(
                messages,
                name,
                tool_call_id="call_e2e_generic_tool",
            )
            if result is None:
                return AIMessage(
                    content="",
                    tool_calls=[{"id": "call_e2e_generic_tool", "name": name, "args": args}],
                )
            return AIMessage(content=f"E2E tool result ({name}): {result.content}")
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
                attachment_path = _attachment_path(prompt)
                if attachment_path is None:
                    return AIMessage(content="E2E attachment path missing from Runtime context.")
                return AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": "call_e2e_read_attachment",
                            "name": "read_file",
                            "args": {"file_path": attachment_path},
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


def _last_tool_result(
    messages: list[BaseMessage],
    name: str,
    *,
    tool_call_id: str | None = None,
) -> BaseMessage | None:
    return next(
        (
            message
            for message in reversed(messages)
            if getattr(message, "type", None) == "tool"
            and (
                getattr(message, "name", None) == name
                or (
                    tool_call_id is not None
                    and getattr(message, "tool_call_id", None) == tool_call_id
                )
            )
        ),
        None,
    )


def _attachment_path(prompt: str) -> str | None:
    match = re.search(
        r"本次附件（只读）:[^\n]*`(/attachments/[^`\n]+)`",
        prompt,
    )
    return match.group(1) if match else None


def _e2e_skill_path(prompt: str) -> str | None:
    match = re.search(r"Read `([^`\n]*/e2e-active-skill/SKILL\.md)`", prompt)
    return match.group(1) if match else None


def _e2e_tool_request(prompt: str) -> tuple[str, dict[str, Any]] | None:
    match = re.search(r"\[\[e2e:tool:([A-Za-z0-9_-]+)\]\]", prompt)
    if match is None:
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(match.group(1) + "=="))
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("name"), str):
        return None
    args = payload.get("args")
    return payload["name"], args if isinstance(args, dict) else {}
