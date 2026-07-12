from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool

from local_host.middleware.tool_visibility import ToolVisibilityMiddleware


@tool("office.read")
def office_read(path: str) -> str:
    """Read an Office document."""
    return path


@tool("workspace.read")
def workspace_read(path: str) -> str:
    """Read a workspace file."""
    return path


def _request(messages: list[Any], goal: str = "") -> Any:
    request = SimpleNamespace(
        messages=messages,
        tools=[office_read, workspace_read],
        runtime=SimpleNamespace(context=SimpleNamespace(task_goal=goal)),
    )
    request.override = lambda **changes: SimpleNamespace(
        **{**request.__dict__, **changes, "override": request.override}
    )
    return request


def test_irrelevant_office_tools_are_hidden_only_for_the_model_request() -> None:
    original = _request([HumanMessage("explain this Python function")])

    filtered = ToolVisibilityMiddleware._apply(original)

    assert [item.name for item in filtered.tools] == ["workspace.read"]
    assert [item.name for item in original.tools] == ["office.read", "workspace.read"]


def test_current_office_goal_keeps_office_tools() -> None:
    request = _request([HumanMessage("continue")], goal="edit quarterly-report.xlsx")

    filtered = ToolVisibilityMiddleware._apply(request)

    assert [item.name for item in filtered.tools] == ["office.read", "workspace.read"]


def test_office_follow_up_is_detected_from_retained_tool_history() -> None:
    messages = [
        HumanMessage("edit the deck"),
        AIMessage(
            content="",
            tool_calls=[{"name": "office.read", "args": {"path": "deck.pptx"}, "id": "1"}],
        ),
        ToolMessage("loaded", tool_call_id="1", name="office.read"),
        HumanMessage("continue with the second page and make it blue"),
    ]

    filtered = ToolVisibilityMiddleware._apply(_request(messages))

    assert [item.name for item in filtered.tools] == ["office.read", "workspace.read"]


def test_fork_goal_can_enable_office_without_changing_registered_tools() -> None:
    original = _request([HumanMessage("retry")], goal="update the presentation")

    filtered = ToolVisibilityMiddleware._apply(original)

    assert [item.name for item in filtered.tools] == ["office.read", "workspace.read"]
    assert filtered.tools is original.tools
