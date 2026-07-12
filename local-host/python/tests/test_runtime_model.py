from __future__ import annotations

import asyncio
from typing import Any

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from local_host.llm.runtime import RuntimeModelProxy, bind_runtime_model


class NamedModel(BaseChatModel):
    label: str

    @property
    def _llm_type(self) -> str:
        return "named-test-model"

    def bind_tools(self, _tools: Any, **_kwargs: Any) -> BaseChatModel:
        return self.model_copy(update={"label": f"{self.label}-bound"})

    async def _agenerate(
        self,
        _messages: list[BaseMessage],
        **_kwargs: Any,
    ) -> ChatResult:
        await asyncio.sleep(0)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=self.label))])

    def _generate(self, _messages: list[BaseMessage], **_kwargs: Any) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=self.label))])


async def test_runtime_model_proxy_is_task_local_and_preserves_tool_binding() -> None:
    proxy = RuntimeModelProxy().bind_tools([{"name": "demo"}])

    async def invoke(label: str) -> str:
        with bind_runtime_model(NamedModel(label=label)):
            result = await proxy.ainvoke([("user", "hello")])
            return str(result.content)

    assert await asyncio.gather(invoke("alpha"), invoke("beta")) == [
        "alpha-bound",
        "beta-bound",
    ]


async def test_runtime_model_proxy_rejects_unbound_calls() -> None:
    with pytest.raises(RuntimeError, match="outside a bound execution"):
        await RuntimeModelProxy().ainvoke([("user", "hello")])
