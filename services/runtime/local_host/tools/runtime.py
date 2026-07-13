"""Task-local tool binding for reusable LangGraph definitions."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool

_CURRENT_TOOLS: ContextVar[dict[str, BaseTool] | None] = ContextVar(
    "shejane_runtime_tools",
    default=None,
)


@contextmanager
def bind_runtime_tools(tools: dict[str, BaseTool]):
    token = _CURRENT_TOOLS.set(tools)
    try:
        yield
    finally:
        _CURRENT_TOOLS.reset(token)


class RuntimeToolProxy(BaseTool):
    """Schema-only tool definition that delegates to this execution's tool."""

    target_name: str

    @classmethod
    def from_tool(
        cls,
        tool: BaseTool,
        *,
        description: str | None = None,
        args_schema: dict[str, Any] | None = None,
    ) -> RuntimeToolProxy:
        return cls(
            name=tool.name,
            target_name=tool.name,
            description=description if description is not None else tool.description,
            args_schema=args_schema if args_schema is not None else tool.tool_call_schema,
            return_direct=tool.return_direct,
        )

    def _active(self) -> BaseTool:
        tools = _CURRENT_TOOLS.get() or {}
        tool = tools.get(self.target_name)
        if tool is None:
            raise RuntimeError(f"runtime tool is not bound: {self.target_name}")
        return tool

    def invoke(
        self,
        input: str | dict[str, Any],
        config: RunnableConfig | None = None,
        **kwargs: Any,
    ) -> Any:
        """Delegate the original ToolCall so formatting happens exactly once."""
        return self._active().invoke(input, config=config, **kwargs)

    async def ainvoke(
        self,
        input: str | dict[str, Any],
        config: RunnableConfig | None = None,
        **kwargs: Any,
    ) -> Any:
        return await self._active().ainvoke(input, config=config, **kwargs)

    def _run(self, config: RunnableConfig | None = None, **kwargs: Any) -> Any:
        return self._active().invoke(kwargs, config=config)

    async def _arun(self, config: RunnableConfig | None = None, **kwargs: Any) -> Any:
        return await self._active().ainvoke(kwargs, config=config)
