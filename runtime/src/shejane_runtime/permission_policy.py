"""Shared permission-scope rules owned by Runtime."""

from __future__ import annotations

IRREVERSIBLE_TOOLS = {
    "office.delete_paragraph",
    "office.delete_slide",
}

RUN_GRANT_RISKS = {
    "control_flow",
    "read_only",
    "runtime_state",
    "sandboxed_command",
    "workspace_write",
}


class PermissionScopeNotAllowedError(ValueError):
    """Raised when a concrete approval cannot safely become a run grant."""


def can_grant_for_run(*, tool_name: str, risk: str | None) -> bool:
    return tool_name not in IRREVERSIBLE_TOOLS and risk in RUN_GRANT_RISKS


def require_allowed_permission_scope(
    *,
    tool_name: str,
    risk: str | None,
    status: str,
    scope: str,
) -> None:
    if (
        status == "approved"
        and scope == "run"
        and not can_grant_for_run(
            tool_name=tool_name,
            risk=risk,
        )
    ):
        raise PermissionScopeNotAllowedError(
            "this operation cannot be approved for the rest of the run"
        )
