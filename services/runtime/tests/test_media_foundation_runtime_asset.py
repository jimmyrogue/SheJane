from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import sys
import wave
from pathlib import Path

import pytest

from local_host.plugins.executor import ManagedWorkerActionExecutor
from local_host.plugins.macos_vm import load_macos_vm_resources
from local_host.plugins.runtime_assets import RuntimeAssetHandle, RuntimeAssetStore

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER = REPO_ROOT / "plugins" / "media-foundation" / "worker" / "media_worker.py"
ASSET_ENV = "SHEJANE_FFMPEG_RUNTIME_ASSET"
PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
VIDEO_MJPEG_MKV = base64.b64decode(
    "GkXfo6NChoEBQveBAULygQRC84EIQoKIbWF0cm9za2FCh4EEQoWBAhhTgGcBAAAAAAADcxFNm3TAv4Q5E9m4TbuLU6uEFUmpZlOsgaFNu4tTq4QWVK5rU6yBzE27jFOrhBJUw2dTrIIBME27jFOrhBxTu2tTrIIDRewBAAAAAAAAUwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFUmpZqa/hFqKZDUq17GDD0JATYCETGF2ZldBhExhdmZEiYhAj0AAAAAAABZUrmvfv4SG8qMcrgEAAAAAAABQ14EBc8WIAAAAAAAAAAGcgQAitZyDdW5kiIEAhodWX01KUEVHg4EBI+ODhB3NZQDgkLCBELqBEJqBAlWwhFW5gQJV7oEA7AEAAAAAAAACAAASVMNn1b+Etyov6HNzzGPAi2PFiAAAAAAAAAABZ8iXRaOHRU5DT0RFUkSHikxhdmMgbWpwZWdnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1QbW/hPsdWZfngQCjQNOBAACA/9j/4AAQSkZJRgABAgAAAQABAAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAQABADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAE1/f//Zo0DTgQH0gP/Y/+AAEEpGSUYAAQIAAAEAAQAA/9sAQwAIBAQEBAQFBQUFBQUGBgYGBgYGBgYGBgYGBwcHCAgIBwcHBgYHBwgICAgJCQkICAgICQkKCgoMDAsLDg4OEREU/8QATAABAQAAAAAAAAAAAAAAAAAAAAYBAQEAAAAAAAAAAAAAAAAAAAYHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAEAAQAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AiwBNf3//2RxTu2upv4S/gVh3u4+zgQC3iveBAfGCAYrwgQm7kLOCAfS3iveBAfGCAYrwgd8="
)


def real_executor(asset: RuntimeAssetHandle) -> ManagedWorkerActionExecutor:
    frozen = os.environ.get("SHEJANE_TEST_MEDIA_WORKER")
    command = (frozen,) if frozen else (sys.executable, str(WORKER))
    vm_manifest = os.environ.get("SHEJANE_TEST_MACOS_VM_ASSETS")
    return ManagedWorkerActionExecutor(
        command,
        runtime_assets=(asset,),
        vm_resources=(
            load_macos_vm_resources(Path(vm_manifest).resolve(strict=True)) if vm_manifest else None
        ),
        package_root=Path(command[0]).resolve(strict=True).parent if vm_manifest else None,
    )


def invocation(
    action_id: str,
    arguments: dict[str, object],
    source: Path,
    *,
    media_type: str,
) -> dict[str, object]:
    data = source.read_bytes()
    return {
        "schema_version": 1,
        "invocation_id": "723e4567-e89b-42d3-a456-426614174001",
        "operation_id": f"run_01:{action_id}:real-asset",
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
        "limits": {"timeout_ms": 30_000, "memory_mb": 512, "output_mb": 64},
        "environment": {"locale": "en-US", "timezone": "UTC"},
    }


def write_silent_wav(path: Path) -> None:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16_000)
        output.writeframes(b"\0\0" * 1_600)


@pytest.mark.asyncio
@pytest.mark.skipif(not os.environ.get(ASSET_ENV), reason=f"{ASSET_ENV} is not set")
async def test_real_ffmpeg_asset_executes_all_media_actions(tmp_path: Path) -> None:
    archive = Path(os.environ[ASSET_ENV]).resolve(strict=True)
    asset = RuntimeAssetStore(tmp_path / "data").install(archive)
    executor = real_executor(asset)
    input_root = tmp_path / "input"
    image = input_root / "source" / "pixel.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(PNG_1X1)

    probe_output = tmp_path / "probe-output"
    probe_output.mkdir()
    probed = await executor.invoke(
        invocation("media.probe", {"input_id": "source"}, image, media_type="image/png"),
        input_root=input_root,
        output_root=probe_output,
    )
    assert probed["status"] == "succeeded", probed
    assert probed["output"]["streams"][0]["codec_name"] == "png"

    thumbnail_output = tmp_path / "thumbnail-output"
    thumbnail_output.mkdir()
    thumbnail = await executor.invoke(
        invocation(
            "media.thumbnail",
            {"input_id": "source", "timestamp_seconds": 0, "max_width": 16, "max_height": 16},
            image,
            media_type="image/png",
        ),
        input_root=input_root,
        output_root=thumbnail_output,
    )
    assert thumbnail["status"] == "succeeded", thumbnail
    thumbnail_bytes = (thumbnail_output / "thumbnail.png").read_bytes()
    assert thumbnail_bytes.startswith(b"\x89PNG\r\n\x1a\n")
    assert hashlib.sha256(thumbnail_bytes).hexdigest() == (
        "60f1715032e4505a21621cdfe32dba0cd441e561617f1a3db2e5f73a3523fc64"
    )

    frames_output = tmp_path / "frames-output"
    frames_output.mkdir()
    video = input_root / "source" / "fixture.mkv"
    video.write_bytes(VIDEO_MJPEG_MKV)
    frames = await executor.invoke(
        invocation(
            "media.extract_frames",
            {
                "input_id": "source",
                "timestamps_seconds": [0, 0.5],
                "max_width": 16,
                "max_height": 16,
            },
            video,
            media_type="video/x-matroska",
        ),
        input_root=input_root,
        output_root=frames_output,
    )
    assert frames["status"] == "succeeded", frames
    for name in ("frame-001.png", "frame-002.png"):
        frame = (frames_output / "frames" / name).read_bytes()
        assert frame.startswith(b"\x89PNG\r\n\x1a\n")
        assert hashlib.sha256(frame).hexdigest() == (
            "e6aeb8688de618cf3c8d49d4c0798db5eb5e6fd9cd58e63b38b5f348f743d014"
        )

    audio = input_root / "source" / "silence.wav"
    write_silent_wav(audio)
    audio_output = tmp_path / "audio-output"
    audio_output.mkdir()
    extracted = await executor.invoke(
        invocation(
            "media.extract_audio",
            {
                "input_id": "source",
                "stream_index": 0,
                "format": "flac",
                "sample_rate": 16_000,
                "channels": 1,
            },
            audio,
            media_type="audio/wav",
        ),
        input_root=input_root,
        output_root=audio_output,
    )
    assert extracted["status"] == "succeeded", extracted
    flac = (audio_output / "audio.flac").read_bytes()
    assert flac.startswith(b"fLaC")
    assert hashlib.sha256(flac).hexdigest() == (
        "3904f51fae7e7452aed3c36458eb4377d108722648da06187ff0898e34f40191"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        b"",
        b"\x1aE\xdf\xa3" + b"\0" * 65_536,
        b"RIFF\xff\xff\xff\xffWAVEfmt ",
        b"\x89PNG\r\n\x1a\n" + b"\xff" * 65_536,
    ],
    ids=("empty", "truncated-matroska", "oversized-wave", "truncated-png"),
)
@pytest.mark.skipif(not os.environ.get(ASSET_ENV), reason=f"{ASSET_ENV} is not set")
async def test_real_ffmpeg_asset_hostile_corpus_fails_closed(
    tmp_path: Path, payload: bytes
) -> None:
    archive = Path(os.environ[ASSET_ENV]).resolve(strict=True)
    asset = RuntimeAssetStore(tmp_path / "data").install(archive)
    executor = real_executor(asset)
    input_root = tmp_path / "input"
    source = input_root / "source" / "hostile.bin"
    source.parent.mkdir(parents=True)
    source.write_bytes(payload)
    output_root = tmp_path / "output"
    output_root.mkdir()

    result = await executor.invoke(
        invocation(
            "media.probe",
            {"input_id": "source"},
            source,
            media_type="application/octet-stream",
        ),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "failed", result
    assert result["artifacts"] == []
    assert not any(path.is_file() for path in output_root.rglob("*"))


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.environ.get(ASSET_ENV) or not os.environ.get("SHEJANE_TEST_MACOS_VM_ASSETS"),
    reason="real packaged VM assets are required",
)
async def test_real_ffmpeg_asset_cancellation_discards_partial_frames(tmp_path: Path) -> None:
    archive = Path(os.environ[ASSET_ENV]).resolve(strict=True)
    asset = RuntimeAssetStore(tmp_path / "data").install(archive)
    executor = real_executor(asset)
    input_root = tmp_path / "input"
    source = input_root / "source" / "fixture.mkv"
    source.parent.mkdir(parents=True)
    source.write_bytes(VIDEO_MJPEG_MKV)
    output_root = tmp_path / "output"
    output_root.mkdir()
    render_started = asyncio.Event()

    def on_progress(event: dict[str, object]) -> None:
        if event.get("phase") == "extract.frames":
            render_started.set()

    task = asyncio.create_task(
        executor.invoke(
            invocation(
                "media.extract_frames",
                {
                    "input_id": "source",
                    "timestamps_seconds": [index / 10 for index in range(16)],
                    "max_width": 1920,
                    "max_height": 1080,
                },
                source,
                media_type="video/x-matroska",
            ),
            input_root=input_root,
            output_root=output_root,
            on_progress=on_progress,
        )
    )
    await asyncio.wait_for(render_started.wait(), timeout=30)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert not any(path.is_file() for path in output_root.rglob("*"))

    probe_output = tmp_path / "probe-output"
    probe_output.mkdir()
    replay = await executor.invoke(
        invocation(
            "media.probe",
            {"input_id": "source"},
            source,
            media_type="video/x-matroska",
        ),
        input_root=input_root,
        output_root=probe_output,
    )
    assert replay["status"] == "succeeded", replay
