"""Canonical Tool input schemas shared by discovery and P10 validation."""

from __future__ import annotations

from copy import deepcopy
from typing import Any


def tool_input_schema(tool: Any) -> dict[str, Any] | None:
    """Return the model-visible schema, closing implicit Pydantic objects.

    Pydantic models ignore unknown fields unless configured otherwise, while
    JSON Schema treats a missing ``additionalProperties`` as open. Built-in
    Tools have fixed argument names, so expose and enforce a closed top-level
    object. Explicit dictionary schemas (notably MCP) retain the server's own
    additional-properties contract.
    """
    schema_attr = getattr(tool, "tool_call_schema", None) or getattr(tool, "args_schema", None)
    if schema_attr is None:
        return None
    if isinstance(schema_attr, dict):
        return deepcopy(schema_attr)
    schema = schema_attr.model_json_schema()
    if not isinstance(schema, dict):
        raise TypeError("tool schema must be an object")
    if _is_object_schema(schema) and "additionalProperties" not in schema:
        schema = {**schema, "additionalProperties": False}
    return schema


def validate_tool_input(tool: Any, arguments: dict[str, Any]) -> None:
    """Validate one Tool call against the same contract discovery publishes."""
    from jsonschema.validators import validator_for

    schema_attr = getattr(tool, "tool_call_schema", None) or getattr(tool, "args_schema", None)
    if schema_attr is None:
        return
    if not isinstance(schema_attr, dict):
        # Preserve Pydantic field/custom validation before applying the closed
        # JSON Schema envelope used by discovery.
        schema_attr.model_validate(arguments)
    schema = tool_input_schema(tool)
    if schema is None:
        return
    validator = validator_for(schema)
    validator.check_schema(schema)
    validator(schema).validate(arguments)


def _is_object_schema(schema: dict[str, Any]) -> bool:
    return schema.get("type") == "object" or isinstance(schema.get("properties"), dict)
