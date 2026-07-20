from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

from shejane_runtime.plugins.manifest import PluginManifest, load_plugin_manifest
from shejane_runtime.plugins.package import extract_plugin_archive

REPO_ROOT = Path(__file__).resolve().parents[2]
ROOT = REPO_ROOT / "runtime" / "plugins" / "pdf"
BUILDER = ROOT / "build_package.py"


def test_pdf_manifest_and_action_schemas_are_strict() -> None:
    template = (ROOT / ".shejane-plugin" / "plugin.template.json").read_text(encoding="utf-8")
    manifest = PluginManifest.model_validate_json(
        template.replace("__PLUGIN_VERSION__", "0.1.0")
        .replace("__ENTRYPOINT__", "payload/pdf-worker")
        .replace("__PLATFORM__", "linux/arm64")
        .replace("__RUNTIME_ASSET_DIGEST__", "sha256:" + "a" * 64)
    )

    assert manifest.runtime.execution.kind == "managed_worker"
    assert manifest.runtime.execution.runtime_assets[0].id == "org.mupdf.runtime"
    assert {action.id for action in manifest.contributions.actions} == {
        "pdf.inspect",
        "pdf.extract_text",
        "pdf.render_pages",
    }
    for action in manifest.contributions.actions:
        for relative in (action.input_schema, action.output_schema):
            schema = json.loads((ROOT / relative).read_text(encoding="utf-8"))
            Draft202012Validator.check_schema(schema)
            assert schema["additionalProperties"] is False


def test_pdf_package_is_deterministic_and_preserves_onedir_worker(tmp_path: Path) -> None:
    worker = tmp_path / "pdf-worker"
    worker.mkdir()
    (worker / "pdf-worker").write_bytes(b"worker")
    (worker / "_internal").mkdir()
    (worker / "_internal" / "libpython.so").write_bytes(b"library")
    outputs = [tmp_path / "first.shejane-plugin", tmp_path / "second.shejane-plugin"]
    for output in outputs:
        subprocess.run(
            [
                sys.executable,
                str(BUILDER),
                "--platform",
                "linux/arm64",
                "--runtime-asset-digest",
                "sha256:" + "a" * 64,
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
    assert manifest.runtime.execution.platforms == ["linux/arm64"]
    assert (extracted / "payload/pdf-worker").read_bytes() == b"worker"
    assert (extracted / "payload/_internal/libpython.so").read_bytes() == b"library"
