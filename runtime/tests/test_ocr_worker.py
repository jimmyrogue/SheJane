from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

from shejane_runtime.plugins.executor import ManagedWorkerActionExecutor
from shejane_runtime.plugins.runtime_assets import RuntimeAssetHandle

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKER = REPO_ROOT / "runtime" / "plugins" / "ocr" / "worker" / "ocr_worker.py"


def executable(path: Path, source: str) -> None:
    path.write_text("#!/usr/bin/env python3\n" + source, encoding="utf-8")
    path.chmod(0o500)


def fake_asset(tmp_path: Path) -> RuntimeAssetHandle:
    root = tmp_path / "rapidocr-asset"
    payload = root / "payload"
    binary = payload / "bin" / "ocr-engine"
    binary.parent.mkdir(parents=True)
    executable(
        binary,
        """import json, pathlib, sys
request = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
images = []
for index, item in enumerate(request["inputs"], start=1):
    images.append({
        "input_id": item["id"],
        "width": 640,
        "height": 480,
        "lines": [
            {"text": f"page {index} primary", "confidence": 0.987654, "polygon": [[1, 2], [100, 2], [100, 20], [1, 20]]},
            {"text": "low confidence", "confidence": 0.2, "polygon": [[2, 30], [80, 30], [80, 50], [2, 50]]},
        ],
    })
engine_name = "Unexpected" if request["inputs"][0]["id"] == "bad-engine" else "RapidOCR"
response = {
    "engine": {"name": engine_name, "version": "3.9.1", "model": "PP-OCRv6-medium", "provider": "CPUExecutionProvider"},
    "images": images,
}
pathlib.Path(sys.argv[2]).write_text(json.dumps(response), encoding="utf-8")
""",
    )
    sbom = root / "sbom.json"
    sbom.write_text("{}", encoding="utf-8")
    return RuntimeAssetHandle(
        asset_id="org.rapidocr.runtime",
        version="3.9.1+ppocrv6-medium.1",
        platform="darwin/arm64",
        digest="sha256:" + "a" * 64,
        root=root,
        payload=payload,
        license="Apache-2.0",
        source_url="https://github.com/RapidAI/RapidOCR",
        sbom=sbom,
    )


def invocation(
    input_ids: list[str],
    sources: list[tuple[str, Path, str]],
) -> dict[str, object]:
    inputs = []
    for input_id, source, media_type in sources:
        data = source.read_bytes()
        inputs.append(
            {
                "id": input_id,
                "path": f"/input/source/{source.name}",
                "media_type": media_type,
                "size_bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )
    return {
        "schema_version": 1,
        "invocation_id": "a23e4567-e89b-42d3-a456-426614174001",
        "operation_id": "run_01:ocr.recognize_images:001",
        "action": {
            "plugin_id": "org.shejane.ocr",
            "plugin_version": "0.1.0",
            "plugin_digest": "sha256:" + "b" * 64,
            "action_id": "ocr.recognize_images",
        },
        "arguments": {
            "input_ids": input_ids,
            "minimum_confidence": 0.5,
            "max_lines": 100,
            "max_characters": 1_000,
            "include_text_artifact": True,
            "include_json_artifact": True,
        },
        "inputs": inputs,
        "grants": {"capabilities": ["input.read", "artifact.write"]},
        "limits": {"timeout_ms": 30_000, "memory_mb": 2048, "output_mb": 64},
        "environment": {"locale": "en-US", "timezone": "UTC"},
    }


def image_sources(tmp_path: Path) -> tuple[Path, Path, list[tuple[str, Path, str]]]:
    input_root = tmp_path / "input"
    output_root = tmp_path / "output"
    source_root = input_root / "source"
    source_root.mkdir(parents=True)
    first = source_root / "first.png"
    second = source_root / "second.jpg"
    first.write_bytes(b"fake png")
    second.write_bytes(b"fake jpeg")
    output_root.mkdir()
    return (
        input_root,
        output_root,
        [
            ("first", first, "image/png"),
            ("second", second, "image/jpeg"),
        ],
    )


@pytest.mark.asyncio
async def test_ocr_worker_preserves_batch_order_filters_and_writes_artifacts(
    tmp_path: Path,
) -> None:
    input_root, output_root, sources = image_sources(tmp_path)
    executor = ManagedWorkerActionExecutor(
        (sys.executable, str(WORKER)), runtime_assets=(fake_asset(tmp_path),)
    )

    result = await executor.invoke(
        invocation(["second", "first"], sources),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "succeeded", result
    assert result["output"]["engine"] == {
        "name": "RapidOCR",
        "version": "3.9.1",
        "model": "PP-OCRv6-medium",
        "provider": "CPUExecutionProvider",
    }
    assert [image["input_id"] for image in result["output"]["images"]] == [
        "second",
        "first",
    ]
    assert [line["text"] for line in result["output"]["images"][0]["lines"]] == ["page 1 primary"]
    assert result["output"]["images"][0]["lines"][0]["confidence"] == 0.98765
    assert result["output"]["total_lines"] == 2
    assert (output_root / "ocr.txt").is_file()
    assert (output_root / "ocr.json").is_file()
    assert [artifact["name"] for artifact in result["artifacts"]] == [
        "ocr.txt",
        "ocr.json",
    ]


@pytest.mark.asyncio
async def test_ocr_worker_rejects_unexpected_engine_identity_without_artifacts(
    tmp_path: Path,
) -> None:
    input_root, output_root, sources = image_sources(tmp_path)
    bad_source = sources[0]
    sources[0] = ("bad-engine", bad_source[1], bad_source[2])
    executor = ManagedWorkerActionExecutor(
        (sys.executable, str(WORKER)), runtime_assets=(fake_asset(tmp_path),)
    )

    result = await executor.invoke(
        invocation(["bad-engine"], sources),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "failed", result
    assert result["error"]["code"] == "engine_protocol_violation"
    assert result["artifacts"] == []
    assert not any(path.is_file() for path in output_root.rglob("*"))


@pytest.mark.asyncio
async def test_ocr_worker_applies_global_character_limit_deterministically(
    tmp_path: Path,
) -> None:
    input_root, output_root, sources = image_sources(tmp_path)
    executor = ManagedWorkerActionExecutor(
        (sys.executable, str(WORKER)), runtime_assets=(fake_asset(tmp_path),)
    )
    request = invocation(["first", "second"], sources)
    arguments = request["arguments"]
    assert isinstance(arguments, dict)
    arguments["max_characters"] = 5
    arguments["include_text_artifact"] = False
    arguments["include_json_artifact"] = False

    result = await executor.invoke(
        request,
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "succeeded", result
    assert result["output"]["images"][0]["full_text"] == "page "
    assert result["output"]["images"][0]["truncated"] is True
    assert result["output"]["images"][1]["lines"] == []
    assert result["output"]["images"][1]["truncated"] is True
    assert result["output"]["total_characters"] == 5
    assert result["artifacts"] == []
