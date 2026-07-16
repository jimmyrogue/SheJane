from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

from local_host.plugins.manifest import load_plugin_manifest
from local_host.plugins.package import canonical_package_digest, extract_plugin_archive

REPO_ROOT = Path(__file__).resolve().parents[3]
BUILDER = REPO_ROOT / "plugins" / "office" / "spreadsheets" / "build_package.py"


def test_spreadsheets_package_is_deterministic_and_contract_valid(tmp_path: Path) -> None:
    worker = tmp_path / "spreadsheets-worker"
    worker.mkdir()
    (worker / "spreadsheets-worker").write_bytes(b"worker")
    (worker / "_internal").mkdir()
    (worker / "_internal" / "runtime.so").write_bytes(b"runtime")
    digest = "sha256:" + "a" * 64
    outputs = [tmp_path / "first.shejane-plugin", tmp_path / "second.shejane-plugin"]
    for output in outputs:
        subprocess.run(
            [
                sys.executable,
                str(BUILDER),
                "--platform",
                "linux/arm64",
                "--runtime-asset-digest",
                digest,
                "--worker",
                str(worker),
                "--output",
                str(output),
            ],
            check=True,
        )

    assert outputs[0].read_bytes() == outputs[1].read_bytes()
    extracted = tmp_path / "extracted"
    extract_plugin_archive(outputs[0], extracted)
    manifest = load_plugin_manifest(extracted)
    assert manifest.id == "org.shejane.spreadsheets"
    assert manifest.runtime.execution.platforms == ["linux/arm64"]
    assert manifest.runtime.execution.runtime_assets[0].digest == digest
    assert [command.id for command in manifest.contributions.commands] == [
        "read",
        "create",
        "edit",
        "render",
    ]
    for action in manifest.contributions.actions:
        for relative in (action.input_schema, action.output_schema):
            schema = json.loads((extracted / relative).read_text(encoding="utf-8"))
            Draft202012Validator.check_schema(schema)
    assert canonical_package_digest(extracted).startswith("sha256:")
    assert (extracted / "payload" / "_internal" / "runtime.so").read_bytes() == b"runtime"
