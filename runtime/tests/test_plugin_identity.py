from __future__ import annotations

from copy import deepcopy
from typing import Any

from shejane_runtime.plugins.identity import plugin_action_tool_version


def _invocation() -> dict[str, Any]:
    return {
        "invocation_id": "123e4567-e89b-42d3-a456-426614174000",
        "operation_id": "attempt-specific",
        "action": {
            "plugin_id": "dev.shejane.fixture.archive",
            "plugin_version": "0.1.0",
            "plugin_digest": "sha256:" + "a" * 64,
            "action_id": "archive.extract",
        },
        "inputs": [
            {
                "id": "second",
                "path": "/input/second.zip",
                "media_type": "application/zip",
                "size_bytes": 2,
                "sha256": "2" * 64,
            },
            {
                "id": "first",
                "path": "/input/first.zip",
                "media_type": "application/zip",
                "size_bytes": 1,
                "sha256": "1" * 64,
            },
        ],
        "grants": {"capabilities": ["input.read", "artifact.write"]},
        "limits": {"timeout_ms": 10_000, "memory_mb": 128, "output_mb": 8},
        "environment": {"locale": "en-US", "timezone": "UTC"},
    }


def test_plugin_action_tool_version_is_stable_but_binds_security_context() -> None:
    original = _invocation()
    reordered = deepcopy(original)
    reordered["inputs"] = list(reversed(reordered["inputs"]))
    reordered["grants"]["capabilities"].reverse()
    reordered["invocation_id"] = "223e4567-e89b-42d3-a456-426614174001"
    reordered["operation_id"] = "another-attempt"

    expected = plugin_action_tool_version(original, action_schema_digest="sha256:" + "b" * 64)
    assert expected == plugin_action_tool_version(
        reordered,
        action_schema_digest="sha256:" + "b" * 64,
    )

    changed = deepcopy(original)
    changed["inputs"][0]["sha256"] = "3" * 64
    assert expected != plugin_action_tool_version(
        changed,
        action_schema_digest="sha256:" + "b" * 64,
    )
