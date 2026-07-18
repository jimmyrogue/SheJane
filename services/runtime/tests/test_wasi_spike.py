from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path

import pytest
from wasmtime import Engine
from wasmtime import component as wasm_component

from local_host.plugins.executor import WasiActionExecutor
from local_host.plugins.wasi import WASI_MAX_BUFFERED_INPUT_BYTES, WasiResourceLimitError

REPO_ROOT = Path(__file__).resolve().parents[3]
COMPONENT = REPO_ROOT / "plugins" / "fixtures" / "wasi-archive" / "payload" / "archive.wasm"
INVOCATION = REPO_ROOT / "plugins" / "fixtures" / "wasi-archive" / "examples" / "invocation.json"


def _invocation(archive_bytes: bytes) -> dict[str, object]:
    invocation = json.loads(INVOCATION.read_text(encoding="utf-8"))
    invocation["action"]["plugin_digest"] = (
        "sha256:" + hashlib.sha256(COMPONENT.read_bytes()).hexdigest()
    )
    invocation["inputs"][0]["size_bytes"] = len(archive_bytes)
    invocation["inputs"][0]["sha256"] = hashlib.sha256(archive_bytes).hexdigest()
    return invocation


@pytest.mark.asyncio
async def test_wasi_component_extracts_authorized_archive_to_staging(tmp_path: Path) -> None:
    archive_buffer = io.BytesIO()
    with zipfile.ZipFile(archive_buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("readme.txt", "SheJane WASI fixture\n")
    archive_bytes = archive_buffer.getvalue()
    input_root = tmp_path / "input"
    output_root = tmp_path / "output"
    source = input_root / "source" / "archive.zip"
    source.parent.mkdir(parents=True)
    source.write_bytes(archive_bytes)
    output_root.mkdir()

    executor = WasiActionExecutor(COMPONENT)
    result = await executor.invoke(
        _invocation(archive_bytes),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "succeeded"
    assert result["output"] == {"file_count": 1}
    assert result["artifacts"] == [
        {
            "path": "/output/archive/readme.txt",
            "media_type": "application/octet-stream",
            "name": "readme.txt",
        }
    ]
    assert (output_root / "archive" / "readme.txt").read_text() == "SheJane WASI fixture\n"


def test_wasi_component_has_no_ambient_capability_imports() -> None:
    engine = Engine()
    component = wasm_component.Component.from_file(engine, COMPONENT)
    imports = set(component.type.imports(engine))

    assert not any(
        name.startswith(
            (
                "wasi:clocks/",
                "wasi:filesystem/",
                "wasi:http/",
                "wasi:random/random",
                "wasi:sockets/",
            )
        )
        for name in imports
    )


@pytest.mark.asyncio
async def test_wasi_rejects_oversized_input_before_buffering(tmp_path: Path) -> None:
    input_root = tmp_path / "input"
    output_root = tmp_path / "output"
    source = input_root / "source" / "archive.zip"
    source.parent.mkdir(parents=True)
    with source.open("wb") as stream:
        stream.truncate(WASI_MAX_BUFFERED_INPUT_BYTES + 1)
    output_root.mkdir()
    invocation = _invocation(b"")
    invocation["inputs"][0]["size_bytes"] = WASI_MAX_BUFFERED_INPUT_BYTES + 1

    with pytest.raises(WasiResourceLimitError, match="Managed Worker"):
        await WasiActionExecutor(COMPONENT).invoke(
            invocation,
            input_root=input_root,
            output_root=output_root,
        )


@pytest.mark.asyncio
async def test_wasi_fuel_exhaustion_is_a_stable_resource_limit_error(tmp_path: Path) -> None:
    archive_buffer = io.BytesIO()
    with zipfile.ZipFile(archive_buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("large.bin", b"0" * (7 * 1024 * 1024))
    archive_bytes = archive_buffer.getvalue()
    input_root = tmp_path / "input"
    output_root = tmp_path / "output"
    source = input_root / "source" / "archive.zip"
    source.parent.mkdir(parents=True)
    source.write_bytes(archive_bytes)
    output_root.mkdir()
    invocation = _invocation(archive_bytes)
    invocation["limits"]["timeout_ms"] = 100

    with pytest.raises(WasiResourceLimitError, match="fuel limit exceeded") as captured:
        await WasiActionExecutor(COMPONENT).invoke(
            invocation,
            input_root=input_root,
            output_root=output_root,
        )

    assert captured.value.code == "resource_exhausted"
    assert list(output_root.iterdir()) == []


@pytest.mark.asyncio
async def test_wasi_component_rejects_archive_path_traversal(tmp_path: Path) -> None:
    archive_buffer = io.BytesIO()
    with zipfile.ZipFile(archive_buffer, "w") as archive:
        archive.writestr("../escape.txt", "escape")
    archive_bytes = archive_buffer.getvalue()
    input_root = tmp_path / "input"
    output_root = tmp_path / "output"
    source = input_root / "source" / "archive.zip"
    source.parent.mkdir(parents=True)
    source.write_bytes(archive_bytes)
    output_root.mkdir()

    executor = WasiActionExecutor(COMPONENT)
    result = await executor.invoke(
        _invocation(archive_bytes),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "failed"
    assert list(output_root.iterdir()) == []
