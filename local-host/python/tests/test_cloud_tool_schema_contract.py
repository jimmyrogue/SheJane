"""Cross-runtime contract for cloud Tool Gateway schemas.

The Go API advertises model-facing cloud tool schemas through
`/api/v1/agent/tool-capabilities`; the Python daemon exposes matching tools as
LangChain BaseTools. Both runtimes must agree on the model-visible argument
names so web and desktop agents learn the same contract.
"""

from __future__ import annotations

import json
from pathlib import Path

from local_host.tools.code import CODE_TOOLS_for_workspace
from local_host.tools.registry import _serialize_args_schema, describe_tools_sync

SCHEMA_ARTIFACT = (
    Path(__file__).resolve().parents[3] / "api/internal/httpapi/cloud_tool_schemas.json"
)


def test_cloud_gateway_tool_schemas_match_shared_artifact() -> None:
    artifact = json.loads(SCHEMA_ARTIFACT.read_text())
    tools = {tool["name"]: tool for tool in describe_tools_sync()}
    code_tool = CODE_TOOLS_for_workspace("/tmp/shejane-contract")[0]
    tools[code_tool.name] = {
        "name": code_tool.name,
        "description": (code_tool.description or "").strip().splitlines()[0],
        "args_schema": _serialize_args_schema(code_tool),
    }

    for name in ["web.search", "image.generate", "image.edit", "pdf.inspect", "code.execute"]:
        expected = artifact[name]["inputSchema"]
        actual = tools[name]["args_schema"]
        expected_properties = set(expected.get("properties", {}))
        actual_properties = set(actual.get("properties", {}))
        assert expected_properties <= actual_properties, (
            f"{name} local schema missing properties from shared artifact: "
            f"{expected_properties - actual_properties}"
        )
        assert set(expected.get("required", [])) <= set(actual.get("required", []))
