from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from shejane_runtime.plugins.manifest import load_plugin_manifest
from shejane_runtime.plugins.package import canonical_package_digest, extract_plugin_archive

REPO_ROOT = Path(__file__).resolve().parents[2]
BUILDER = REPO_ROOT / "runtime" / "plugins" / "office" / "documents" / "build_package.py"


def test_documents_package_is_deterministic_and_contract_valid(tmp_path: Path) -> None:
    worker = tmp_path / "documents-worker"
    worker.mkdir()
    (worker / "documents-worker").write_bytes(b"worker")
    internal = worker / "_internal"
    internal.mkdir()
    (internal / "libpython.so").write_bytes(b"library")
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
    assert manifest.id == "org.shejane.documents"
    assert manifest.runtime.execution.platforms == ["linux/arm64"]
    assert manifest.runtime.execution.runtime_assets[0].digest == digest
    assert (extracted / "payload/documents-worker").read_bytes() == b"worker"
    assert (extracted / "payload/_internal/libpython.so").read_bytes() == b"library"
    assert [command.id for command in manifest.contributions.commands] == [
        "read",
        "create",
        "edit",
        "render",
    ]
    assert canonical_package_digest(extracted).startswith("sha256:")
