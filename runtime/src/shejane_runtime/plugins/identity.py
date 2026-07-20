"""Plugin-specific version context for the existing tool receipt identity."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any


def plugin_action_tool_version(
    invocation: dict[str, Any],
    *,
    action_schema_digest: str,
) -> str:
    """Bind security-relevant plugin context without attempt-specific ids."""

    action = invocation["action"]
    context = {
        "protocol": "plugin-action-v1",
        "action": {
            "plugin_id": action["plugin_id"],
            "plugin_version": action["plugin_version"],
            "plugin_digest": action["plugin_digest"],
            "action_id": action["action_id"],
            "action_schema_digest": action_schema_digest,
        },
        "inputs": sorted(
            (
                {
                    "id": item["id"],
                    "path": item["path"],
                    "media_type": item["media_type"],
                    "size_bytes": item["size_bytes"],
                    "sha256": item["sha256"],
                }
                for item in invocation["inputs"]
            ),
            key=lambda item: (item["id"], item["path"]),
        ),
        "capabilities": sorted(invocation["grants"]["capabilities"]),
        "limits": invocation["limits"],
        "environment": invocation["environment"],
        "model_binding": _plain_json(invocation.get("model_binding")),
    }
    canonical = json.dumps(
        context,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return "plugin-action-v1:sha256:" + hashlib.sha256(canonical.encode()).hexdigest()


def _plain_json(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _plain_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain_json(item) for item in value]
    return value


def plugin_action_catalog_hash(manifest: dict[str, Any], *, plugin_digest: str) -> str:
    """Hash the immutable action surface contributed by one package digest."""

    payload = {
        "protocol": "plugin-action-catalog-v1",
        "plugin_id": manifest["id"],
        "plugin_version": manifest["version"],
        "plugin_digest": plugin_digest,
        "actions": manifest["contributions"]["actions"],
    }
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return "sha256:" + hashlib.sha256(canonical.encode()).hexdigest()
