"""workspace.open — register and remember an authorized filesystem root.

This is the Python equivalent of the Node `workspace.open` tool. It does NOT
itself execute filesystem operations — it just records authorization in the
store. Downstream fs tools (FileManagementToolkit, ShellToolMiddleware,
FilesystemFileSearchMiddleware) are bound to a workspace path per-run by the
agent builder (see `local_host.agent.builder`).
"""

from __future__ import annotations

import os
from pathlib import Path

from langchain_core.tools import InjectedToolArg, tool
from typing_extensions import Annotated

from ..store.sqlite import LocalStore


def make_workspace_open_tool(store: LocalStore):
    """Bind workspace.open against a specific store instance.

    Returns a `BaseTool`. We can't use a top-level `@tool` here because the
    store has to be captured — `InjectedToolArg` would also work but the
    callable-bound form is cleaner for our usage.
    """

    @tool("workspace.open")
    async def workspace_open(path: str, label: str = "") -> dict[str, str]:
        """Authorize a filesystem root for subsequent fs / shell tool calls.

        Args:
            path: Absolute filesystem path that the agent may read/write
                  within. Must already exist as a directory.
            label: Optional human label. Defaults to the basename of path.
        """
        if not path:
            return {"ok": "false", "error": "path required"}
        resolved = os.path.abspath(os.path.expanduser(path))
        if not Path(resolved).is_dir():
            return {
                "ok": "false",
                "error": f"path is not an accessible directory: {resolved}",
            }
        label = label or Path(resolved).name or resolved
        ws = await store.create_workspace(path=resolved, label=label)
        return {
            "ok": "true",
            "workspace_id": ws["id"],
            "path": ws["path"],
            "label": ws["label"],
        }

    return workspace_open


def make_fs_toolkit(workspace_root: str | None):
    """Build the LangChain FileManagementToolkit slice we expose to agents.

    We pick a deliberately narrow set (read / write / list) — the toolkit
    also ships copy/move/delete/file_search but those are either redundant
    (delete is destructive enough to belong behind explicit permission, not
    a "trivial" tool) or duplicate functionality we get from middleware
    (file_search is filename-glob; content grep lives in
    FilesystemFileSearchMiddleware).
    """
    if not workspace_root:
        return []

    from langchain_community.agent_toolkits import FileManagementToolkit

    tk = FileManagementToolkit(
        root_dir=workspace_root,
        selected_tools=["read_file", "write_file", "list_directory"],
    )
    return list(tk.get_tools())


# `InjectedToolArg` is exported for callers that want to inject store/run
# context into a custom tool without exposing it to the LLM schema. Re-exported
# here so other tools in this package can pick the canonical type.
__all__ = [
    "InjectedToolArg",
    "make_fs_toolkit",
    "make_workspace_open_tool",
]
