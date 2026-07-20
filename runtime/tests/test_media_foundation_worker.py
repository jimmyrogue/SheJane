from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

from shejane_runtime.plugins.executor import ManagedWorkerActionExecutor
from shejane_runtime.plugins.runtime_assets import RuntimeAssetHandle

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKER = REPO_ROOT / "runtime" / "plugins" / "media-foundation" / "worker" / "media_worker.py"


def executable(path: Path, source: str) -> None:
    path.write_text("#!/usr/bin/env python3\n" + source, encoding="utf-8")
    path.chmod(0o500)


def fake_asset(tmp_path: Path) -> RuntimeAssetHandle:
    root = tmp_path / "ffmpeg-asset"
    payload = root / "payload"
    binaries = payload / "bin"
    binaries.mkdir(parents=True)
    executable(
        binaries / "ffprobe",
        """import json
print(json.dumps({"format":{"format_name":"mov,mp4","duration":"12.5","size":"4096","bit_rate":"2621"},"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"duration":"12.5","avg_frame_rate":"30/1"},{"index":1,"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2}]}))
""",
    )
    executable(
        binaries / "ffmpeg",
        """import pathlib, sys
target = pathlib.Path(sys.argv[-1])
if target.suffix in {".wav", ".flac"}:
    mapping = sys.argv[sys.argv.index("-map") + 1]
    if mapping != "0:1":
        raise SystemExit(f"unexpected stream mapping: {mapping}")
if sys.argv[sys.argv.index("-i") + 1].endswith(".png") and "-ss" in sys.argv:
    raise SystemExit("static image must not be seeked")
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(b"RIFFfake" if target.suffix == ".wav" else b"fLaCfake" if target.suffix == ".flac" else b"PNGfake")
""",
    )
    sbom = root / "sbom.json"
    sbom.write_text("{}", encoding="utf-8")
    return RuntimeAssetHandle(
        asset_id="org.ffmpeg.runtime",
        version="8.1.2+shejane.1",
        platform="darwin/arm64",
        digest="sha256:" + "a" * 64,
        root=root,
        payload=payload,
        license="LGPL-2.1-or-later",
        source_url="https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz",
        sbom=sbom,
    )


def invocation(
    action_id: str,
    arguments: dict[str, object],
    source: Path,
    *,
    media_type: str = "video/mp4",
) -> dict[str, object]:
    data = source.read_bytes()
    return {
        "schema_version": 1,
        "invocation_id": "623e4567-e89b-42d3-a456-426614174001",
        "operation_id": f"run_01:{action_id}:001",
        "action": {
            "plugin_id": "org.shejane.media-foundation",
            "plugin_version": "0.1.0",
            "plugin_digest": "sha256:" + "b" * 64,
            "action_id": action_id,
        },
        "arguments": arguments,
        "inputs": [
            {
                "id": "source",
                "path": f"/input/source/{source.name}",
                "media_type": media_type,
                "size_bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        ],
        "grants": {"capabilities": ["input.read", "artifact.write"]},
        "limits": {"timeout_ms": 5_000, "memory_mb": 512, "output_mb": 64},
        "environment": {"locale": "en-US", "timezone": "UTC"},
    }


@pytest.mark.asyncio
async def test_media_worker_uses_exact_asset_for_probe_and_bounded_metadata(
    tmp_path: Path,
) -> None:
    input_root = tmp_path / "input"
    output_root = tmp_path / "output"
    source = input_root / "source" / "video.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"fixture media")
    output_root.mkdir()
    progress: list[dict[str, object]] = []
    executor = ManagedWorkerActionExecutor(
        (sys.executable, str(WORKER)), runtime_assets=(fake_asset(tmp_path),)
    )

    result = await executor.invoke(
        invocation("media.probe", {"input_id": "source"}, source),
        input_root=input_root,
        output_root=output_root,
        on_progress=progress.append,
    )

    assert result["status"] == "succeeded"
    assert result["output"]["format"] == {
        "name": "mov,mp4",
        "duration_seconds": 12.5,
        "size_bytes": 4096,
        "bit_rate": 2621,
    }
    assert [stream["codec_name"] for stream in result["output"]["streams"]] == [
        "h264",
        "aac",
    ]
    assert result["artifacts"] == []
    assert progress[-1]["completed"] == 1


@pytest.mark.asyncio
async def test_media_worker_does_not_seek_a_static_image(tmp_path: Path) -> None:
    input_root = tmp_path / "input"
    output_root = tmp_path / "output"
    source = input_root / "source" / "pixel.png"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"fixture image")
    output_root.mkdir()
    executor = ManagedWorkerActionExecutor(
        (sys.executable, str(WORKER)), runtime_assets=(fake_asset(tmp_path),)
    )

    result = await executor.invoke(
        invocation(
            "media.thumbnail",
            {"input_id": "source", "timestamp_seconds": 0, "max_width": 16, "max_height": 16},
            source,
            media_type="image/png",
        ),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "succeeded"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("action_id", "arguments", "expected_names"),
    [
        (
            "media.thumbnail",
            {"input_id": "source", "timestamp_seconds": 1.25, "max_width": 640, "max_height": 360},
            ["thumbnail.png"],
        ),
        (
            "media.extract_frames",
            {
                "input_id": "source",
                "timestamps_seconds": [0, 2.5],
                "max_width": 640,
                "max_height": 360,
            },
            ["frame-001.png", "frame-002.png"],
        ),
        (
            "media.extract_audio",
            {
                "input_id": "source",
                "stream_index": 1,
                "format": "wav",
                "sample_rate": 16000,
                "channels": 1,
            },
            ["audio.wav"],
        ),
    ],
)
async def test_media_worker_stages_declared_artifacts(
    tmp_path: Path,
    action_id: str,
    arguments: dict[str, object],
    expected_names: list[str],
) -> None:
    input_root = tmp_path / "input"
    output_root = tmp_path / "output"
    source = input_root / "source" / "video.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"fixture media")
    output_root.mkdir()
    executor = ManagedWorkerActionExecutor(
        (sys.executable, str(WORKER)), runtime_assets=(fake_asset(tmp_path),)
    )

    result = await executor.invoke(
        invocation(action_id, arguments, source),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "succeeded"
    assert [artifact["name"] for artifact in result["artifacts"]] == expected_names
    for artifact in result["artifacts"]:
        assert (output_root / str(artifact["path"]).removeprefix("/output/")).is_file()
