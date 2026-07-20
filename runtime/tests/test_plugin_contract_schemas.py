from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator, FormatChecker

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIR = REPO_ROOT / "runtime" / "plugins" / "schemas"
FIXTURE_DIR = REPO_ROOT / "runtime" / "plugins" / "fixtures"


def _json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def manifest_schema() -> dict[str, Any]:
    return _json(SCHEMA_DIR / "plugin-manifest.v1.schema.json")


@pytest.fixture(scope="module")
def invocation_schema() -> dict[str, Any]:
    return _json(SCHEMA_DIR / "plugin-action-input.v1.schema.json")


@pytest.fixture(scope="module")
def result_schema() -> dict[str, Any]:
    return _json(SCHEMA_DIR / "plugin-action-result.v1.schema.json")


@pytest.fixture(scope="module")
def progress_schema() -> dict[str, Any]:
    return _json(SCHEMA_DIR / "plugin-action-progress.v1.schema.json")


def _validator(schema: dict[str, Any]) -> Draft202012Validator:
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def test_reference_manifests_cover_both_execution_kinds(
    manifest_schema: dict[str, Any],
) -> None:
    validator = _validator(manifest_schema)
    wasi = _json(FIXTURE_DIR / "wasi-archive" / ".shejane-plugin" / "plugin.json")
    worker = _json(FIXTURE_DIR / "worker-documents" / ".shejane-plugin" / "plugin.json")

    validator.validate(wasi)
    validator.validate(worker)
    assert wasi["runtime"]["execution"]["kind"] == "wasi"
    assert worker["runtime"]["execution"]["kind"] == "managed_worker"
    for fixture_name, manifest in (("wasi-archive", wasi), ("worker-documents", worker)):
        entrypoint = FIXTURE_DIR / fixture_name / manifest["runtime"]["execution"]["entrypoint"]
        assert entrypoint.is_file()


def test_manifest_rejects_unknown_fields_and_unsafe_package_paths(
    manifest_schema: dict[str, Any],
) -> None:
    validator = _validator(manifest_schema)
    manifest = _json(FIXTURE_DIR / "wasi-archive" / ".shejane-plugin" / "plugin.json")

    unknown = deepcopy(manifest)
    unknown["surprise"] = True
    assert any(
        error.validator == "additionalProperties" for error in validator.iter_errors(unknown)
    )

    traversal = deepcopy(manifest)
    traversal["runtime"]["execution"]["entrypoint"] = "../escape.wasm"
    assert not validator.is_valid(traversal)


def test_managed_worker_package_targets_exactly_one_platform(
    manifest_schema: dict[str, Any],
) -> None:
    validator = _validator(manifest_schema)
    manifest = _json(FIXTURE_DIR / "worker-documents" / ".shejane-plugin" / "plugin.json")

    multiple = deepcopy(manifest)
    multiple["runtime"]["execution"]["platforms"] = [
        "darwin/arm64",
        "windows/amd64",
    ]

    assert not validator.is_valid(multiple)


def test_managed_worker_runtime_assets_are_exact_and_platform_scoped(
    manifest_schema: dict[str, Any],
) -> None:
    validator = _validator(manifest_schema)
    manifest = _json(FIXTURE_DIR / "worker-documents" / ".shejane-plugin" / "plugin.json")
    execution = manifest["runtime"]["execution"]
    execution["runtime_assets"] = [
        {
            "id": "org.libreoffice.runtime",
            "version": "25.8.7",
            "digest": "sha256:" + "a" * 64,
        }
    ]

    assert validator.is_valid(manifest)

    redundant = deepcopy(manifest)
    redundant["runtime"]["execution"]["runtime_assets"][0]["platform"] = "darwin/arm64"
    assert not validator.is_valid(redundant)

    floating = deepcopy(manifest)
    floating["runtime"]["execution"]["runtime_assets"][0]["digest"] = "latest"
    assert not validator.is_valid(floating)


def test_reference_action_schemas_exist_and_are_valid() -> None:
    for fixture_name in ("wasi-archive", "worker-documents"):
        fixture_root = FIXTURE_DIR / fixture_name
        manifest = _json(fixture_root / ".shejane-plugin" / "plugin.json")
        for action in manifest["contributions"]["actions"]:
            for schema_path in (action["input_schema"], action["output_schema"]):
                resolved = (fixture_root / schema_path).resolve()
                resolved.relative_to(fixture_root.resolve())
                _validator(_json(resolved))


def test_reference_envelopes_match_their_action_schemas() -> None:
    for fixture_name in ("wasi-archive", "worker-documents"):
        fixture_root = FIXTURE_DIR / fixture_name
        manifest = _json(fixture_root / ".shejane-plugin" / "plugin.json")
        invocation = _json(fixture_root / "examples" / "invocation.json")
        result = _json(fixture_root / "examples" / "result.json")
        action = next(
            item
            for item in manifest["contributions"]["actions"]
            if item["id"] == invocation["action"]["action_id"]
        )

        _validator(_json(fixture_root / action["input_schema"])).validate(invocation["arguments"])
        _validator(_json(fixture_root / action["output_schema"])).validate(result["output"])
        assert invocation["arguments"]["input_id"] in {item["id"] for item in invocation["inputs"]}


def test_reference_action_envelopes_are_valid(
    invocation_schema: dict[str, Any],
    result_schema: dict[str, Any],
) -> None:
    invocation_validator = _validator(invocation_schema)
    result_validator = _validator(result_schema)

    for fixture_name in ("wasi-archive", "worker-documents"):
        invocation_validator.validate(
            _json(FIXTURE_DIR / fixture_name / "examples" / "invocation.json")
        )
        result_validator.validate(_json(FIXTURE_DIR / fixture_name / "examples" / "result.json"))

    result_validator.validate(_json(FIXTURE_DIR / "worker-documents" / "examples" / "failure.json"))


def test_progress_notification_schema_is_strict(progress_schema: dict[str, Any]) -> None:
    validator = _validator(progress_schema)
    notification = {
        "jsonrpc": "2.0",
        "method": "notifications/progress",
        "params": {
            "schema_version": 1,
            "invocation_id": "00000000-0000-4000-8000-000000000001",
            "operation_id": "toolop_fixture_1",
            "sequence": 1,
            "phase": "render.pages",
            "message": "Rendered page 1",
            "completed": 1,
            "total": 3,
            "unit": "pages",
        },
    }

    validator.validate(notification)
    notification["params"]["surprise"] = True
    assert not validator.is_valid(notification)


def test_action_result_rejects_artifacts_outside_output_root(
    result_schema: dict[str, Any],
) -> None:
    validator = _validator(result_schema)
    result = _json(FIXTURE_DIR / "wasi-archive" / "examples" / "result.json")
    result["artifacts"][0]["path"] = "/etc/passwd"

    assert any(error.validator == "pattern" for error in validator.iter_errors(result))

    traversal = _json(FIXTURE_DIR / "wasi-archive" / "examples" / "result.json")
    traversal["artifacts"][0]["path"] = "/output/../escape.txt"
    assert not validator.is_valid(traversal)


def test_action_invocation_rejects_input_path_traversal(
    invocation_schema: dict[str, Any],
) -> None:
    validator = _validator(invocation_schema)
    invocation = _json(FIXTURE_DIR / "wasi-archive" / "examples" / "invocation.json")
    invocation["inputs"][0]["path"] = "/input/../escape.zip"

    assert not validator.is_valid(invocation)
