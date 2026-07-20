from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

from shejane_runtime.plugins.executor import ManagedWorkerActionExecutor
from shejane_runtime.plugins.runtime_assets import RuntimeAssetHandle

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKER = REPO_ROOT / "runtime" / "plugins" / "speech" / "worker" / "speech_worker.py"
MODEL_SHA256 = "c" * 64


def executable(path: Path, source: str) -> None:
    path.write_text("#!/usr/bin/env python3\n" + source, encoding="utf-8")
    path.chmod(0o500)


def runtime_asset(
    root: Path,
    *,
    asset_id: str,
    version: str,
    source_url: str,
) -> RuntimeAssetHandle:
    payload = root / "payload"
    payload.mkdir(parents=True)
    sbom = root / "sbom.json"
    sbom.write_text("{}", encoding="utf-8")
    return RuntimeAssetHandle(
        asset_id=asset_id,
        version=version,
        platform="darwin/arm64",
        digest="sha256:" + hashlib.sha256(asset_id.encode()).hexdigest(),
        root=root,
        payload=payload,
        license="MIT",
        source_url=source_url,
        sbom=sbom,
    )


def fake_assets(tmp_path: Path) -> tuple[RuntimeAssetHandle, RuntimeAssetHandle]:
    ffmpeg = runtime_asset(
        tmp_path / "ffmpeg-asset",
        asset_id="org.ffmpeg.runtime",
        version="8.1.2+shejane.1",
        source_url="https://ffmpeg.org/",
    )
    ffmpeg_binary = ffmpeg.payload / "bin" / "ffmpeg"
    ffmpeg_binary.parent.mkdir()
    executable(
        ffmpeg_binary,
        """import pathlib, sys
pathlib.Path(sys.argv[-1]).write_bytes(b\"RIFF deterministic pcm\")
""",
    )

    whisper = runtime_asset(
        tmp_path / "whisper-asset",
        asset_id="org.whisper.runtime",
        version="1.8.6+large-v3-turbo-q5-0.shejane.1",
        source_url="https://github.com/ggml-org/whisper.cpp",
    )
    engine = whisper.payload / "bin" / "speech-engine"
    engine.parent.mkdir()
    executable(
        engine,
        f"""import json, pathlib, sys
request = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding=\"utf-8\"))
name = \"unexpected\" if request[\"input_id\"] == \"bad-engine\" else \"whisper.cpp\"
duration_ms = 7_200_001 if request[\"input_id\"] == \"too-long\" else 2750
response = {{
    \"engine\": {{
        \"name\": name,
        \"version\": \"1.8.6\",
        \"commit\": \"23ee03506a91ac3d3f0071b40e66a430eebdfa1d\",
        \"model\": \"large-v3-turbo\",
        \"quantization\": \"Q5_0\",
        \"model_sha256\": \"{MODEL_SHA256}\",
        \"provider\": \"CPU\",
        \"threads\": 1,
    }},
    \"duration_ms\": duration_ms,
    \"resolved_language\": \"zh\",
    \"segments\": [
        {{\"start_ms\": 0, \"end_ms\": 1200, \"text\": \"  你好\\t世界  \"}},
        {{\"start_ms\": 1300, \"end_ms\": 2750, \"text\": \"SheJane 2026\"}},
    ],
}}
pathlib.Path(sys.argv[2]).write_text(json.dumps(response), encoding=\"utf-8\")
""",
    )
    (whisper.payload / "model.sha256").write_text(MODEL_SHA256 + "\n", encoding="ascii")
    return ffmpeg, whisper


def invocation(input_id: str, source: Path) -> dict[str, object]:
    data = source.read_bytes()
    return {
        "schema_version": 1,
        "invocation_id": "a23e4567-e89b-42d3-a456-426614174002",
        "operation_id": "run_01:speech.transcribe:001",
        "action": {
            "plugin_id": "org.shejane.speech",
            "plugin_version": "0.1.0",
            "plugin_digest": "sha256:" + "b" * 64,
            "action_id": "speech.transcribe",
        },
        "arguments": {
            "input_id": input_id,
            "language": "auto",
            "initial_prompt": "",
            "max_segments": 100,
            "max_characters": 10_000,
            "include_text_artifact": True,
            "include_srt_artifact": True,
            "include_json_artifact": True,
        },
        "inputs": [
            {
                "id": input_id,
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


def staged_audio(tmp_path: Path) -> tuple[Path, Path, Path]:
    input_root = tmp_path / "input"
    output_root = tmp_path / "output"
    source = input_root / "source" / "speech.wav"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"fake audio")
    output_root.mkdir()
    return input_root, output_root, source


@pytest.mark.asyncio
async def test_speech_worker_normalizes_transcribes_and_writes_artifacts(
    tmp_path: Path,
) -> None:
    input_root, output_root, source = staged_audio(tmp_path)
    executor = ManagedWorkerActionExecutor(
        (sys.executable, str(WORKER)), runtime_assets=fake_assets(tmp_path)
    )

    result = await executor.invoke(
        invocation("speech", source), input_root=input_root, output_root=output_root
    )

    assert result["status"] == "succeeded", result
    assert result["output"]["engine"]["model_sha256"] == MODEL_SHA256
    assert result["output"]["normalization"] == {
        "engine": "FFmpeg",
        "version": "8.1.2",
        "sample_rate_hz": 16000,
        "channels": 1,
        "sample_format": "s16",
    }
    assert result["output"]["resolved_language"] == "zh"
    assert result["output"]["transcript"] == "你好 世界\nSheJane 2026"
    assert [segment["start_ms"] for segment in result["output"]["segments"]] == [0, 1300]
    assert [artifact["name"] for artifact in result["artifacts"]] == [
        "transcript.txt",
        "transcript.srt",
        "transcript.json",
    ]
    assert (output_root / "transcript.txt").read_text(encoding="utf-8") == (
        "你好 世界\nSheJane 2026\n"
    )
    assert "00:00:01,300 --> 00:00:02,750" in (output_root / "transcript.srt").read_text(
        encoding="utf-8"
    )
    assert not (output_root / ".runtime-tmp").exists()


@pytest.mark.asyncio
async def test_speech_worker_rejects_engine_identity_without_artifacts(
    tmp_path: Path,
) -> None:
    input_root, output_root, source = staged_audio(tmp_path)
    executor = ManagedWorkerActionExecutor(
        (sys.executable, str(WORKER)), runtime_assets=fake_assets(tmp_path)
    )

    result = await executor.invoke(
        invocation("bad-engine", source),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "failed", result
    assert result["error"]["code"] == "engine_protocol_violation"
    assert result["artifacts"] == []
    assert not any(path.is_file() for path in output_root.rglob("*"))


@pytest.mark.asyncio
async def test_speech_worker_rejects_audio_over_two_hours_without_artifacts(
    tmp_path: Path,
) -> None:
    input_root, output_root, source = staged_audio(tmp_path)
    executor = ManagedWorkerActionExecutor(
        (sys.executable, str(WORKER)), runtime_assets=fake_assets(tmp_path)
    )

    result = await executor.invoke(
        invocation("too-long", source),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "failed", result
    assert result["error"]["code"] == "engine_protocol_violation"
    assert result["artifacts"] == []
    assert not any(path.is_file() for path in output_root.rglob("*"))


@pytest.mark.asyncio
async def test_speech_worker_truncates_inline_result_but_keeps_complete_artifact(
    tmp_path: Path,
) -> None:
    input_root, output_root, source = staged_audio(tmp_path)
    executor = ManagedWorkerActionExecutor(
        (sys.executable, str(WORKER)), runtime_assets=fake_assets(tmp_path)
    )
    request = invocation("speech", source)
    arguments = request["arguments"]
    assert isinstance(arguments, dict)
    arguments["max_segments"] = 1
    arguments["max_characters"] = 4
    arguments["include_srt_artifact"] = False
    arguments["include_json_artifact"] = False

    result = await executor.invoke(request, input_root=input_root, output_root=output_root)

    assert result["status"] == "succeeded", result
    assert result["output"]["transcript"] == "你好 世"
    assert result["output"]["segments"] == [{"start_ms": 0, "end_ms": 1200, "text": "你好 世"}]
    assert result["output"]["truncated"] is True
    assert result["output"]["total_segments"] == 2
    assert result["output"]["total_characters"] == 17
    assert (output_root / "transcript.txt").read_text(encoding="utf-8") == (
        "你好 世界\nSheJane 2026\n"
    )
