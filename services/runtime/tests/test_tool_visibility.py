from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool

from local_host.middleware.tool_visibility import ToolVisibilityMiddleware
from local_host.tools.mcp import MCP_TOOL_SEARCH_RESULT_KIND, make_mcp_tool_search


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


@tool("docs_lookup")
def docs_lookup(query: str) -> str:
    """Search the product documentation for setup and API details."""
    return query


@tool("issues_create")
def issues_create(title: str) -> str:
    """Create an issue in the project tracker."""
    return title


def test_mcp_tool_search_returns_ranked_machine_readable_results() -> None:
    search = make_mcp_tool_search([docs_lookup, issues_create])

    result = search.invoke({"query": "API documentation", "limit": 1})

    assert result["kind"] == MCP_TOOL_SEARCH_RESULT_KIND
    assert [item["name"] for item in result["tools"]] == ["docs_lookup"]


def test_mcp_tools_are_hidden_until_search_reveals_them() -> None:
    search = make_mcp_tool_search([docs_lookup, issues_create])
    request = _request([HumanMessage("set up an integration")])
    request.tools = [workspace_read, docs_lookup, issues_create, search]
    middleware = ToolVisibilityMiddleware(deferred_tool_names={"docs_lookup", "issues_create"})

    initial = middleware._apply(request, middleware.deferred_tool_names)
    assert [item.name for item in initial.tools] == ["workspace.read", "mcp.search_tools"]

    request.messages.extend(
        [
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "mcp.search_tools",
                        "args": {"query": "API documentation"},
                        "id": "search-1",
                    }
                ],
            ),
            ToolMessage(
                content={
                    "kind": MCP_TOOL_SEARCH_RESULT_KIND,
                    "tools": [
                        {
                            "name": "docs_lookup",
                            "description": docs_lookup.description,
                        }
                    ],
                },
                tool_call_id="search-1",
                name="mcp.search_tools",
            ),
        ]
    )

    revealed = middleware._apply(request, middleware.deferred_tool_names)
    assert [item.name for item in revealed.tools] == [
        "workspace.read",
        "docs_lookup",
        "mcp.search_tools",
    ]
