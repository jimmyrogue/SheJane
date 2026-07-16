from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from local_host.plugins.manifest import PluginManifest, load_plugin_manifest
from local_host.plugins.package import canonical_package_digest, extract_plugin_archive

REPO_ROOT = Path(__file__).resolve().parents[3]
ROOT = REPO_ROOT / "plugins" / "vision"
BUILDER = ROOT / "build_package.py"


def manifest(backend: str) -> PluginManifest:
    template = (ROOT / ".shejane-plugin" / f"plugin.{backend}.template.json").read_text(
        encoding="utf-8"
    )
    rendered = (
        template.replace("__PLUGIN_VERSION__", "0.1.0")
        .replace("__ENTRYPOINT__", "payload/vision-worker")
        .replace("__PLATFORM__", "linux/arm64")
        .replace("__RUNTIME_ASSET_VERSION__", "0.1.0-smolvlm2-test")
        .replace("__RUNTIME_ASSET_DIGEST__", "sha256:" + "a" * 64)
    )
    return PluginManifest.model_validate_json(rendered)


def test_vision_backends_share_action_and_output_but_not_authority() -> None:
    local = manifest("local")
    cloud = manifest("cloud")

    assert local.runtime.execution.kind == cloud.runtime.execution.kind == "managed_worker"
    assert local.id == "org.shejane.vision.local"
    assert cloud.id == "org.shejane.vision.cloud"
    assert [asset.id for asset in local.runtime.execution.runtime_assets] == [
        "org.llama-mtmd.runtime"
    ]
    assert cloud.runtime.execution.runtime_assets == []
    local_action = local.contributions.actions[0]
    cloud_action = cloud.contributions.actions[0]
    assert local_action.id == cloud_action.id == "vision.analyze_images"
    assert local_action.output_schema == cloud_action.output_schema
    assert local_action.determinism == "input_stable"
    assert cloud_action.determinism == "nondeterministic"
    assert "model.vision.invoke" not in local_action.capabilities
    assert "model.vision.invoke" in cloud_action.capabilities


def test_vision_action_schemas_are_strict_and_backend_explicit() -> None:
    for backend in ("local", "cloud"):
        input_schema = json.loads(
            (ROOT / "actions" / f"vision.analyze_images.{backend}.input.json").read_text(
                encoding="utf-8"
            )
        )
        Draft202012Validator.check_schema(input_schema)
        assert input_schema["additionalProperties"] is False
        assert input_schema["properties"]["backend"]["const"] == backend
    output_schema = json.loads(
        (ROOT / "actions" / "vision.analyze_images.output.json").read_text(encoding="utf-8")
    )
    Draft202012Validator.check_schema(output_schema)
    assert output_schema["additionalProperties"] is False


@pytest.mark.parametrize("backend", ["local", "cloud"])
def test_vision_backend_package_is_deterministic(
    tmp_path: Path,
    backend: str,
) -> None:
    worker = tmp_path / "vision-worker"
    worker.mkdir()
    (worker / "vision-worker").write_bytes(b"worker")
    (worker / "_internal").mkdir()
    (worker / "_internal" / "libpython.so").write_bytes(b"library")
    outputs = [
        tmp_path / f"{backend}-first.shejane-plugin",
        tmp_path / f"{backend}-second.shejane-plugin",
    ]
    for output in outputs:
        command = [
            sys.executable,
            str(BUILDER),
            "--backend",
            backend,
            "--platform",
            "linux/arm64",
            "--worker",
            str(worker),
            "--output",
            str(output),
        ]
        if backend == "local":
            command.extend(
                [
                    "--runtime-asset-version",
                    "0.1.0-smolvlm2-test",
                    "--runtime-asset-digest",
                    "sha256:" + "a" * 64,
                ]
            )
        subprocess.run(command, check=True)

    assert outputs[0].read_bytes() == outputs[1].read_bytes()
    extracted = tmp_path / f"{backend}-extracted"
    extract_plugin_archive(outputs[0], extracted)
    packaged = load_plugin_manifest(extracted)
    assert packaged.id == f"org.shejane.vision.{backend}"
    assert canonical_package_digest(extracted).startswith("sha256:")
    assert (extracted / "payload/vision-worker").read_bytes() == b"worker"
    assert (extracted / "payload/_internal/libpython.so").read_bytes() == b"library"
