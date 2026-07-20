from __future__ import annotations

import array
import asyncio
import hashlib
import math
import os
import shutil
import subprocess
import sys
import time
import wave
from pathlib import Path

import pytest

from shejane_runtime.plugins.executor import ManagedWorkerActionExecutor
from shejane_runtime.plugins.macos_vm import load_macos_vm_resources
from shejane_runtime.plugins.runtime_assets import RuntimeAssetHandle, RuntimeAssetStore

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKER = REPO_ROOT / "runtime" / "plugins" / "speech" / "worker" / "speech_worker.py"
MEDIA_WORKER = REPO_ROOT / "runtime" / "plugins" / "media-foundation" / "worker" / "media_worker.py"
WHISPER_ASSET_ENV = "SHEJANE_WHISPER_RUNTIME_ASSET"
FFMPEG_ASSET_ENV = "SHEJANE_FFMPEG_RUNTIME_ASSET"


def real_executor(
    ffmpeg: RuntimeAssetHandle, whisper: RuntimeAssetHandle
) -> ManagedWorkerActionExecutor:
    frozen = os.environ.get("SHEJANE_TEST_SPEECH_WORKER")
    command = (frozen,) if frozen else (sys.executable, str(WORKER))
    vm_manifest = os.environ.get("SHEJANE_TEST_MACOS_VM_ASSETS")
    return ManagedWorkerActionExecutor(
        command,
        runtime_assets=(ffmpeg, whisper),
        vm_resources=(
            load_macos_vm_resources(Path(vm_manifest).resolve(strict=True)) if vm_manifest else None
        ),
        package_root=Path(command[0]).resolve(strict=True).parent if vm_manifest else None,
    )


def real_media_executor(ffmpeg: RuntimeAssetHandle) -> ManagedWorkerActionExecutor:
    frozen = os.environ.get("SHEJANE_TEST_MEDIA_WORKER")
    command = (frozen,) if frozen else (sys.executable, str(MEDIA_WORKER))
    vm_manifest = os.environ.get("SHEJANE_TEST_MACOS_VM_ASSETS")
    return ManagedWorkerActionExecutor(
        command,
        runtime_assets=(ffmpeg,),
        vm_resources=(
            load_macos_vm_resources(Path(vm_manifest).resolve(strict=True)) if vm_manifest else None
        ),
        package_root=Path(command[0]).resolve(strict=True).parent if vm_manifest else None,
    )


def invocation(
    source: Path, *, language: str = "en", initial_prompt: str = ""
) -> dict[str, object]:
    data = source.read_bytes()
    return {
        "schema_version": 1,
        "invocation_id": "b23e4567-e89b-42d3-a456-426614174002",
        "operation_id": "run_01:speech.transcribe:real-asset",
        "action": {
            "plugin_id": "org.shejane.speech",
            "plugin_version": "0.1.0",
            "plugin_digest": "sha256:" + "b" * 64,
            "action_id": "speech.transcribe",
        },
        "arguments": {
            "input_id": "source",
            "language": language,
            "initial_prompt": initial_prompt,
            "max_segments": 100,
            "max_characters": 10_000,
            "include_text_artifact": True,
            "include_srt_artifact": True,
            "include_json_artifact": True,
        },
        "inputs": [
            {
                "id": "source",
                "path": f"/input/source/{source.name}",
                "media_type": "audio/wav",
                "size_bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        ],
        "grants": {"capabilities": ["input.read", "artifact.write"]},
        "limits": {"timeout_ms": 300_000, "memory_mb": 4096, "output_mb": 64},
        "environment": {"locale": "en-US", "timezone": "UTC"},
    }


def media_extract_audio_invocation(source: Path) -> dict[str, object]:
    data = source.read_bytes()
    return {
        "schema_version": 1,
        "invocation_id": "c23e4567-e89b-42d3-a456-426614174003",
        "operation_id": "run_01:media.extract_audio:speech-composition",
        "action": {
            "plugin_id": "org.shejane.media-foundation",
            "plugin_version": "0.1.0",
            "plugin_digest": "sha256:" + "c" * 64,
            "action_id": "media.extract_audio",
        },
        "arguments": {
            "input_id": "source",
            "stream_index": 0,
            "format": "flac",
            "sample_rate": 16_000,
            "channels": 1,
        },
        "inputs": [
            {
                "id": "source",
                "path": f"/input/source/{source.name}",
                "media_type": "audio/wav",
                "size_bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        ],
        "grants": {"capabilities": ["input.read", "artifact.write"]},
        "limits": {"timeout_ms": 30_000, "memory_mb": 512, "output_mb": 64},
        "environment": {"locale": "en-US", "timezone": "UTC"},
    }


def write_silence(path: Path) -> None:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16_000)
        output.writeframes(b"\0\0" * 16_000)


def write_spoken_fixture(path: Path, *, voice: str, text: str) -> None:
    say = shutil.which("say")
    afconvert = shutil.which("afconvert")
    if not say or not afconvert:
        pytest.skip("macOS speech fixture tools are unavailable")
    source = path.with_suffix(".aiff")
    subprocess.run(
        [say, "-v", voice, "-r", "165", "-o", str(source), text],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            afconvert,
            "-f",
            "WAVE",
            "-d",
            "LEI16@16000",
            "-c",
            "1",
            str(source),
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def add_background_and_long_pause(
    path: Path, *, pause_seconds: int = 4, voice_gain: float = 1.0
) -> None:
    with wave.open(str(path), "rb") as source:
        channels = source.getnchannels()
        sample_width = source.getsampwidth()
        frame_rate = source.getframerate()
        frames = source.readframes(source.getnframes())
    assert channels == 1
    assert sample_width == 2

    samples = array.array("h")
    samples.frombytes(frames)
    midpoint = len(samples) // 2
    pause = array.array("h", [0]) * (frame_rate * pause_seconds)
    combined = samples[:midpoint] + pause + samples[midpoint:]
    for index, sample in enumerate(combined):
        tone = int(
            70 * math.sin(2 * math.pi * 220 * index / frame_rate)
            + 45 * math.sin(2 * math.pi * 330 * index / frame_rate)
        )
        noise = ((index * 1103515245 + 12345) >> 16) % 41 - 20
        combined[index] = max(-32768, min(32767, int(sample * voice_gain) + tone + noise))

    with wave.open(str(path), "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(sample_width)
        output.setframerate(frame_rate)
        output.writeframes(combined.tobytes())


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.environ.get(WHISPER_ASSET_ENV) or not os.environ.get(FFMPEG_ASSET_ENV),
    reason=f"{WHISPER_ASSET_ENV} and {FFMPEG_ASSET_ENV} are required",
)
async def test_real_whisper_asset_is_input_stable(tmp_path: Path) -> None:
    store = RuntimeAssetStore(tmp_path / "data")
    ffmpeg = store.install(Path(os.environ[FFMPEG_ASSET_ENV]).resolve(strict=True))
    whisper = store.install(Path(os.environ[WHISPER_ASSET_ENV]).resolve(strict=True))
    executor = real_executor(ffmpeg, whisper)
    input_root = tmp_path / "input"
    source = input_root / "source" / "silence.wav"
    source.parent.mkdir(parents=True)
    write_silence(source)

    results = []
    artifact_digests = []
    started = time.monotonic()
    for index in range(2):
        output_root = tmp_path / f"output-{index}"
        output_root.mkdir()
        result = await executor.invoke(
            invocation(source), input_root=input_root, output_root=output_root
        )
        assert result["status"] == "succeeded", result
        assert result["output"]["engine"]["model_sha256"] == (
            "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"
        )
        results.append(result["output"])
        artifact_digests.append(
            tuple(
                hashlib.sha256((output_root / name).read_bytes()).hexdigest()
                for name in ("transcript.txt", "transcript.srt", "transcript.json")
            )
        )

    assert results[0] == results[1]
    assert artifact_digests[0] == artifact_digests[1]
    assert time.monotonic() - started < 300


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.environ.get(WHISPER_ASSET_ENV)
    or not os.environ.get(FFMPEG_ASSET_ENV)
    or not os.environ.get("SHEJANE_TEST_MACOS_VM_ASSETS"),
    reason="real packaged VM assets are required",
)
@pytest.mark.parametrize(
    ("voice", "language", "spoken", "initial_prompt", "expected"),
    [
        (
            "Samantha",
            "en",
            "Deterministic speech test twenty twenty six.",
            "",
            "deterministic speech test 2026",
        ),
        ("Tingting", "zh", "时间语音测试二零二六。", "", "时间语音测试2026"),
    ],
)
async def test_real_whisper_asset_transcribes_english_and_mandarin(
    tmp_path: Path,
    voice: str,
    language: str,
    spoken: str,
    initial_prompt: str,
    expected: str,
) -> None:
    store = RuntimeAssetStore(tmp_path / "data")
    ffmpeg = store.install(Path(os.environ[FFMPEG_ASSET_ENV]).resolve(strict=True))
    whisper = store.install(Path(os.environ[WHISPER_ASSET_ENV]).resolve(strict=True))
    executor = real_executor(ffmpeg, whisper)
    input_root = tmp_path / "input"
    source = input_root / "source" / "spoken.wav"
    source.parent.mkdir(parents=True)
    write_spoken_fixture(source, voice=voice, text=spoken)
    output_root = tmp_path / "output"
    output_root.mkdir()

    result = await executor.invoke(
        invocation(source, language=language, initial_prompt=initial_prompt),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "succeeded", result
    normalized = " ".join(result["output"]["transcript"].casefold().split())
    assert expected in normalized, result


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.environ.get(WHISPER_ASSET_ENV)
    or not os.environ.get(FFMPEG_ASSET_ENV)
    or not os.environ.get("SHEJANE_TEST_MACOS_VM_ASSETS"),
    reason="real packaged VM assets are required",
)
async def test_real_whisper_asset_auto_detects_japanese_with_background_and_long_pause(
    tmp_path: Path,
) -> None:
    store = RuntimeAssetStore(tmp_path / "data")
    ffmpeg = store.install(Path(os.environ[FFMPEG_ASSET_ENV]).resolve(strict=True))
    whisper = store.install(Path(os.environ[WHISPER_ASSET_ENV]).resolve(strict=True))
    executor = real_executor(ffmpeg, whisper)
    input_root = tmp_path / "input"
    source = input_root / "source" / "japanese.wav"
    source.parent.mkdir(parents=True)
    write_spoken_fixture(
        source,
        voice="Kyoko",
        text=(
            "日本語の音声認識テストです。"
            "長い休止の後も文章を正しく認識します。"
            "コード、プラグイン、ランタイムという技術用語も確認します。"
            "最後にもう一度、日本語の音声認識テストを完了します。"
        ),
    )
    add_background_and_long_pause(source)
    output_root = tmp_path / "output"
    output_root.mkdir()

    result = await executor.invoke(
        invocation(source, language="auto"),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "succeeded", result
    assert result["output"]["resolved_language"] == "ja", result
    transcript = result["output"]["transcript"]
    assert "日本語" in transcript, result
    assert "音声認識" in transcript, result
    assert result["output"]["input_duration_ms"] >= 12_000, result


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.environ.get(WHISPER_ASSET_ENV)
    or not os.environ.get(FFMPEG_ASSET_ENV)
    or not os.environ.get("SHEJANE_TEST_MACOS_VM_ASSETS"),
    reason="real packaged VM assets are required",
)
async def test_real_whisper_asset_handles_low_volume_accented_long_form(
    tmp_path: Path,
) -> None:
    store = RuntimeAssetStore(tmp_path / "data")
    ffmpeg = store.install(Path(os.environ[FFMPEG_ASSET_ENV]).resolve(strict=True))
    whisper = store.install(Path(os.environ[WHISPER_ASSET_ENV]).resolve(strict=True))
    executor = real_executor(ffmpeg, whisper)
    input_root = tmp_path / "input"
    source = input_root / "source" / "long-form.wav"
    source.parent.mkdir(parents=True)
    write_spoken_fixture(
        source,
        voice="Rishi",
        text=(
            "Long form speech verification begins with a deliberately quiet recording. "
            "This fixture checks whether an accented English voice remains understandable "
            "during a sustained technical explanation. The plugin receives one immutable "
            "audio file and normalizes it before transcription. It records exact runtime "
            "assets, model identity, timestamps, and deterministic output limits. "
            "The discussion includes WebAssembly, WASI, Kubernetes, TypeScript, PostgreSQL, "
            "and content addressed artifacts. These terms are supplied as an initial prompt, "
            "but the prompt is only a hint and never a correction guarantee. "
            "After a long pause, the recording continues with another complete paragraph. "
            "Cancellation must remove temporary audio, failures must commit no artifacts, "
            "and successful output must remain bounded. A single modality chat model can "
            "then cite the resulting transcript without receiving binary audio. "
            "Long form speech verification is complete."
        ),
    )
    add_background_and_long_pause(source, pause_seconds=6, voice_gain=0.45)
    output_root = tmp_path / "output"
    output_root.mkdir()

    result = await executor.invoke(
        invocation(
            source,
            language="en",
            initial_prompt="WebAssembly, WASI, Kubernetes, TypeScript, PostgreSQL",
        ),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "succeeded", result
    assert result["output"]["resolved_language"] == "en", result
    normalized = " ".join(result["output"]["transcript"].casefold().replace("-", " ").split())
    assert "long form speech verification begins" in normalized, result
    assert "long form speech verification is complete" in normalized, result
    assert result["output"]["input_duration_ms"] >= 45_000, result


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.environ.get(WHISPER_ASSET_ENV)
    or not os.environ.get(FFMPEG_ASSET_ENV)
    or not os.environ.get("SHEJANE_TEST_MACOS_VM_ASSETS")
    or not os.environ.get("SHEJANE_TEST_MEDIA_WORKER"),
    reason="real packaged VM assets and Media Worker are required",
)
async def test_real_media_audio_artifact_chains_into_speech_without_inline_bytes(
    tmp_path: Path,
) -> None:
    store = RuntimeAssetStore(tmp_path / "data")
    ffmpeg = store.install(Path(os.environ[FFMPEG_ASSET_ENV]).resolve(strict=True))
    whisper = store.install(Path(os.environ[WHISPER_ASSET_ENV]).resolve(strict=True))
    media_executor = real_media_executor(ffmpeg)
    speech_executor = real_executor(ffmpeg, whisper)
    media_input_root = tmp_path / "media-input"
    source = media_input_root / "source" / "spoken.wav"
    source.parent.mkdir(parents=True)
    write_spoken_fixture(
        source,
        voice="Samantha",
        text="Media artifact composition reaches deterministic speech transcription.",
    )

    speech_input_root = tmp_path / "speech-input"
    artifact_root = speech_input_root / "source"
    artifact_root.mkdir(parents=True)
    extracted = await media_executor.invoke(
        media_extract_audio_invocation(source),
        input_root=media_input_root,
        output_root=artifact_root,
    )
    assert extracted["status"] == "succeeded", extracted
    assert [artifact["name"] for artifact in extracted["artifacts"]] == ["audio.flac"]
    assert extracted["artifacts"][0]["media_type"] == "audio/flac"
    audio_artifact = artifact_root / "audio.flac"
    assert audio_artifact.is_file()

    speech_output_root = tmp_path / "speech-output"
    speech_output_root.mkdir()
    transcribed = await speech_executor.invoke(
        invocation(audio_artifact),
        input_root=speech_input_root,
        output_root=speech_output_root,
    )

    assert transcribed["status"] == "succeeded", transcribed
    normalized = " ".join(transcribed["output"]["transcript"].casefold().split())
    assert "media artifact composition" in normalized, transcribed
    assert "audio.flac" not in str(transcribed["output"])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [b"", b"RIFF" + b"\xff" * 32, b"ID3" + b"\0" * 65_536],
    ids=("empty", "truncated-wav", "hostile-id3"),
)
@pytest.mark.skipif(
    not os.environ.get(WHISPER_ASSET_ENV) or not os.environ.get(FFMPEG_ASSET_ENV),
    reason=f"{WHISPER_ASSET_ENV} and {FFMPEG_ASSET_ENV} are required",
)
async def test_real_speech_assets_reject_hostile_audio_without_artifacts(
    tmp_path: Path, payload: bytes
) -> None:
    store = RuntimeAssetStore(tmp_path / "data")
    ffmpeg = store.install(Path(os.environ[FFMPEG_ASSET_ENV]).resolve(strict=True))
    whisper = store.install(Path(os.environ[WHISPER_ASSET_ENV]).resolve(strict=True))
    executor = real_executor(ffmpeg, whisper)
    input_root = tmp_path / "input"
    source = input_root / "source" / "hostile.wav"
    source.parent.mkdir(parents=True)
    source.write_bytes(payload)
    output_root = tmp_path / "output"
    output_root.mkdir()

    result = await executor.invoke(
        invocation(source), input_root=input_root, output_root=output_root
    )

    assert result["status"] == "failed", result
    assert result["artifacts"] == []
    assert not any(path.is_file() for path in output_root.rglob("*"))


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.environ.get(WHISPER_ASSET_ENV)
    or not os.environ.get(FFMPEG_ASSET_ENV)
    or not os.environ.get("SHEJANE_TEST_MACOS_VM_ASSETS"),
    reason="real packaged VM assets are required",
)
async def test_real_speech_asset_cancellation_discards_partial_output(tmp_path: Path) -> None:
    store = RuntimeAssetStore(tmp_path / "data")
    ffmpeg = store.install(Path(os.environ[FFMPEG_ASSET_ENV]).resolve(strict=True))
    whisper = store.install(Path(os.environ[WHISPER_ASSET_ENV]).resolve(strict=True))
    executor = real_executor(ffmpeg, whisper)
    input_root = tmp_path / "input"
    source = input_root / "source" / "spoken.wav"
    source.parent.mkdir(parents=True)
    write_spoken_fixture(
        source,
        voice="Samantha",
        text="SheJane cancellation test with enough speech to start transcription.",
    )
    output_root = tmp_path / "output"
    output_root.mkdir()
    transcription_started = asyncio.Event()

    def on_progress(event: dict[str, object]) -> None:
        if event.get("phase") == "transcribe.audio":
            transcription_started.set()

    task = asyncio.create_task(
        executor.invoke(
            invocation(source),
            input_root=input_root,
            output_root=output_root,
            on_progress=on_progress,
        )
    )
    await asyncio.wait_for(transcription_started.wait(), timeout=30)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert not any(path.is_file() for path in output_root.rglob("*"))
