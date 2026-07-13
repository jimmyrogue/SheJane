from __future__ import annotations

import asyncio

import pytest
from langchain_core.tools import BaseTool, tool

from local_host.tools.runtime import RuntimeToolProxy, bind_runtime_tools


def _named_tool(label: str) -> BaseTool:
    @tool("remote.lookup")
    async def lookup(value: str) -> str:
        """Look up one value."""
        await asyncio.sleep(0)
        return f"{label}:{value}"

    return lookup


async def test_runtime_tool_proxy_is_task_local() -> None:
    proxy = RuntimeToolProxy.from_tool(_named_tool("schema"))

    async def invoke(label: str) -> str:
        active = _named_tool(label)
        with bind_runtime_tools({active.name: active}):
            return str(await proxy.ainvoke({"value": "item"}))

    assert await asyncio.gather(invoke("alpha"), invoke("beta")) == [
        "alpha:item",
        "beta:item",
    ]


async def test_runtime_tool_proxy_rejects_unbound_calls() -> None:
    proxy = RuntimeToolProxy.from_tool(_named_tool("schema"))
    with pytest.raises(RuntimeError, match="runtime tool is not bound"):
        await proxy.ainvoke({"value": "item"})


async def test_runtime_tool_proxy_preserves_content_and_artifact() -> None:
    @tool("remote.artifact", response_format="content_and_artifact")
    async def artifact_tool(value: str) -> tuple[str, dict[str, str]]:
        """Return content and its source artifact."""
        return f"found:{value}", {"source": value}

    proxy = RuntimeToolProxy.from_tool(artifact_tool)
    tool_call = {
        "type": "tool_call",
        "name": proxy.name,
        "args": {"value": "item"},
        "id": "call-1",
    }
    with bind_runtime_tools({artifact_tool.name: artifact_tool}):
        result = await proxy.ainvoke(tool_call)

    assert result.content == "found:item"
    assert result.artifact == {"source": "item"}
    assert result.tool_call_id == "call-1"
