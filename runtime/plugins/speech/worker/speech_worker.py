#!/usr/bin/env python3
"""One-shot Speech Managed Worker using exact FFmpeg and whisper.cpp assets."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Any

FFMPEG_ASSET_ID = "org.ffmpeg.runtime"
WHISPER_ASSET_ID = "org.whisper.runtime"
ENGINE_IDENTITY = {
    "name": "whisper.cpp",
    "version": "1.8.6",
    "commit": "23ee03506a91ac3d3f0071b40e66a430eebdfa1d",
    "model": "large-v3-turbo",
    "quantization": "Q5_0",
    "provider": "CPU",
    "threads": 1,
}
NORMALIZATION = {
    "engine": "FFmpeg",
    "version": "8.1.2",
    "sample_rate_hz": 16_000,
    "channels": 1,
    "sample_format": "s16",
}
SUPPORTED_MEDIA_TYPES = {
    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
    "audio/flac",
    "audio/ogg",
    "audio/webm",
    "audio/aac",
    "audio/x-m4a",
}
MAX_DURATION_MS = 7_200_000
MAX_ENGINE_SEGMENTS = 20_000
MAX_ENGINE_CHARACTERS = 500_000
MAX_ENGINE_RESPONSE_BYTES = 64 * 1024 * 1024
ARTIFACT_NAMES = ("transcript.txt", "transcript.srt", "transcript.json")


class SpeechActionError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def send(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def response(request_id: int, result: Any) -> None:
    send({"jsonrpc": "2.0", "id": request_id, "result": result})


class Progress:
    def __init__(self, invocation: dict[str, Any]) -> None:
        self.invocation = invocation
        self.sequence = 0

    def emit(
        self,
        phase: str,
        message: str,
        *,
        completed: int | None = None,
        total: int | None = None,
        unit: str | None = None,
    ) -> None:
        self.sequence += 1
        params: dict[str, Any] = {
            "schema_version": 1,
            "invocation_id": self.invocation["invocation_id"],
            "operation_id": self.invocation["operation_id"],
            "sequence": self.sequence,
            "phase": phase,
            "message": message,
        }
        if completed is not None:
            params["completed"] = completed
        if total is not None:
            params["total"] = total
        if unit is not None:
            params["unit"] = unit
        send({"jsonrpc": "2.0", "method": "notifications/progress", "params": params})


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def contained_file(root: Path, virtual_path: str) -> Path:
    try:
        relative = PurePosixPath(virtual_path).relative_to("/input")
    except ValueError as exc:
        raise SpeechActionError("invalid_input", "Speech input path is invalid") from exc
    if not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        raise SpeechActionError("invalid_input", "Speech input path is invalid")
    candidate = root.joinpath(*relative.parts)
    if candidate.is_symlink() or not candidate.is_file():
        raise SpeechActionError("invalid_input", "Speech input is unavailable")
    try:
        candidate.resolve(strict=True).relative_to(root.resolve(strict=True))
    except (OSError, ValueError) as exc:
        raise SpeechActionError("invalid_input", "Speech input is unavailable") from exc
    return candidate


def selected_input(invocation: dict[str, Any]) -> tuple[dict[str, Any], Path]:
    input_id = invocation["arguments"]["input_id"]
    if not isinstance(input_id, str) or not 1 <= len(input_id) <= 100:
        raise SpeechActionError("invalid_input", "Speech input selection is invalid")
    try:
        reference = next(item for item in invocation["inputs"] if item["id"] == input_id)
    except (KeyError, StopIteration, TypeError) as exc:
        raise SpeechActionError("invalid_input", "Selected Speech input is unavailable") from exc
    if reference.get("media_type") not in SUPPORTED_MEDIA_TYPES:
        raise SpeechActionError("invalid_input", "Selected input is not supported audio")
    source = contained_file(Path(os.environ["SHEJANE_PLUGIN_INPUT_ROOT"]), str(reference["path"]))
    if source.stat().st_size != reference.get("size_bytes") or sha256_file(source) != reference.get(
        "sha256"
    ):
        raise SpeechActionError("invalid_input", "Selected Speech input identity changed")
    return reference, source


def output_root() -> Path:
    return Path(os.environ["SHEJANE_PLUGIN_OUTPUT_ROOT"]).resolve(strict=True)


def output_file(name: str) -> Path:
    destination = output_root() / name
    destination.parent.resolve(strict=True).relative_to(output_root())
    return destination


def runtime_temp() -> Path:
    temporary = output_root() / ".runtime-tmp"
    temporary.mkdir(mode=0o700, exist_ok=True)
    temporary.resolve(strict=True).relative_to(output_root())
    return temporary


def asset_payload(asset_id: str) -> Path:
    try:
        assets = json.loads(os.environ["SHEJANE_PLUGIN_RUNTIME_ASSETS"])
        payload = Path(assets[asset_id]).resolve(strict=True)
    except (KeyError, OSError, ValueError, json.JSONDecodeError) as exc:
        raise SpeechActionError(
            "runtime_unavailable", f"{asset_id} Runtime Asset is unavailable"
        ) from exc
    return payload


def asset_binary(asset_id: str, name: str) -> Path:
    payload = asset_payload(asset_id)
    executable = payload / "bin" / (f"{name}.exe" if os.name == "nt" else name)
    if executable.is_symlink() or not executable.is_file():
        raise SpeechActionError("runtime_unavailable", f"{name} is unavailable")
    try:
        executable.resolve(strict=True).relative_to(payload)
    except (OSError, ValueError) as exc:
        raise SpeechActionError("runtime_unavailable", f"{name} is unavailable") from exc
    return executable


def expected_model_sha256() -> str:
    path = asset_payload(WHISPER_ASSET_ID) / "model.sha256"
    try:
        value = path.read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError) as exc:
        raise SpeechActionError(
            "runtime_unavailable", "Whisper model identity is unavailable"
        ) from exc
    if path.is_symlink() or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise SpeechActionError("runtime_unavailable", "Whisper model identity is unavailable")
    return value


def engine_environment(temporary: Path, executable: str) -> dict[str, str]:
    allowed = {
        key: value for key, value in os.environ.items() if key in {"PATH", "SystemRoot", "WINDIR"}
    }
    runtime_library_path = str(Path(executable).resolve(strict=True).parent.parent / "lib")
    library_environment = (
        {"DYLD_LIBRARY_PATH": runtime_library_path}
        if sys.platform == "darwin"
        else {"LD_LIBRARY_PATH": runtime_library_path}
        if os.name != "nt"
        else {}
    )
    return (
        allowed
        | library_environment
        | {
            "HOME": str(temporary),
            "TMPDIR": str(temporary),
            "TMP": str(temporary),
            "TEMP": str(temporary),
            "LC_ALL": "C",
            "LANG": "C",
            "TZ": "UTC",
        }
    )


def run_engine(
    command: list[str],
    temporary: Path,
    *,
    failure_code: str,
    failure_message: str,
) -> None:
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=engine_environment(temporary, command[0]),
    )
    assert process.stdout is not None and process.stderr is not None
    overflow: list[str] = []

    def drain(name: str, stream: Any, limit: int) -> None:
        size = 0
        while data := stream.read(64 * 1024):
            size += len(data)
            if size > limit:
                overflow.append(name)
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                return

    threads = [
        threading.Thread(target=drain, args=("stdout", process.stdout, 64 * 1024)),
        threading.Thread(target=drain, args=("stderr", process.stderr, 256 * 1024)),
    ]
    for thread in threads:
        thread.start()
    returncode = process.wait()
    for thread in threads:
        thread.join()
    if overflow:
        raise SpeechActionError(
            "resource_exhausted", f"Speech engine {overflow[0]} exceeded its limit"
        )
    if returncode != 0:
        raise SpeechActionError(failure_code, failure_message)


def normalized_text(value: Any) -> str:
    if not isinstance(value, str) or len(value) > MAX_ENGINE_CHARACTERS:
        raise SpeechActionError("engine_protocol_violation", "Speech engine response is invalid")
    without_controls = "".join(
        " "
        if character in "\t\n\r"
        else ""
        if unicodedata.category(character) == "Cc"
        else character
        for character in value
    )
    return " ".join(without_controls.split())


def bounded_int(value: Any, *, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise SpeechActionError("engine_protocol_violation", "Speech engine response is invalid")
    if not minimum <= value <= maximum:
        raise SpeechActionError("engine_protocol_violation", "Speech engine response is invalid")
    return value


def load_engine_response(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_ENGINE_RESPONSE_BYTES:
        raise SpeechActionError("engine_protocol_violation", "Speech engine response is invalid")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SpeechActionError(
            "engine_protocol_violation", "Speech engine response is invalid"
        ) from exc
    if not isinstance(raw, dict):
        raise SpeechActionError("engine_protocol_violation", "Speech engine response is invalid")
    return raw


def normalize_engine_response(
    raw: dict[str, Any], *, expected_model_sha: str
) -> tuple[dict[str, Any], int, str, list[dict[str, Any]]]:
    expected_engine = dict(ENGINE_IDENTITY) | {"model_sha256": expected_model_sha}
    if raw.get("engine") != expected_engine:
        raise SpeechActionError("engine_protocol_violation", "Speech engine identity is invalid")
    duration_ms = bounded_int(raw.get("duration_ms"), minimum=0, maximum=MAX_DURATION_MS)
    resolved_language = raw.get("resolved_language")
    if not isinstance(resolved_language, str) or not re.fullmatch(r"[a-z]{2}", resolved_language):
        raise SpeechActionError("engine_protocol_violation", "Speech engine language is invalid")
    raw_segments = raw.get("segments")
    if not isinstance(raw_segments, list) or len(raw_segments) > MAX_ENGINE_SEGMENTS:
        raise SpeechActionError("engine_protocol_violation", "Speech engine response is invalid")
    segments: list[dict[str, Any]] = []
    total_characters = 0
    previous_start = 0
    for item in raw_segments:
        if not isinstance(item, dict) or set(item) != {"start_ms", "end_ms", "text"}:
            raise SpeechActionError("engine_protocol_violation", "Speech engine segment is invalid")
        start_ms = bounded_int(item["start_ms"], minimum=0, maximum=duration_ms)
        end_ms = bounded_int(item["end_ms"], minimum=start_ms, maximum=duration_ms)
        if start_ms < previous_start:
            raise SpeechActionError(
                "engine_protocol_violation", "Speech engine segment order is invalid"
            )
        text = normalized_text(item["text"])
        previous_start = start_ms
        if not text:
            continue
        total_characters += len(text)
        if total_characters > MAX_ENGINE_CHARACTERS:
            raise SpeechActionError(
                "resource_exhausted", "Speech transcript exceeds the supported limit"
            )
        segments.append({"start_ms": start_ms, "end_ms": end_ms, "text": text})
    return expected_engine, duration_ms, resolved_language, segments


def inline_segments(
    segments: list[dict[str, Any]], *, max_segments: int, max_characters: int
) -> tuple[list[dict[str, Any]], bool]:
    result: list[dict[str, Any]] = []
    remaining = max_characters
    for segment in segments:
        if len(result) >= max_segments or remaining == 0:
            break
        text = segment["text"][:remaining]
        if text:
            result.append(
                {
                    "start_ms": segment["start_ms"],
                    "end_ms": segment["end_ms"],
                    "text": text,
                }
            )
            remaining -= len(text)
        if len(text) < len(segment["text"]):
            break
    truncated = result != segments
    return result, truncated


def srt_timestamp(milliseconds: int) -> str:
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def srt_text(segments: list[dict[str, Any]]) -> str:
    blocks = []
    for index, segment in enumerate(segments, start=1):
        blocks.append(
            f"{index}\n{srt_timestamp(segment['start_ms'])} --> "
            f"{srt_timestamp(segment['end_ms'])}\n{segment['text']}"
        )
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def validate_arguments(arguments: dict[str, Any]) -> tuple[str, str, int, int]:
    language = arguments["language"]
    prompt = arguments["initial_prompt"]
    if not isinstance(language, str) or not re.fullmatch(r"(?:auto|[a-z]{2})", language):
        raise SpeechActionError("invalid_arguments", "Speech language is invalid")
    if (
        not isinstance(prompt, str)
        or len(prompt) > 512
        or any(unicodedata.category(character) == "Cc" for character in prompt)
    ):
        raise SpeechActionError("invalid_arguments", "Speech initial prompt is invalid")
    max_segments = arguments["max_segments"]
    max_characters = arguments["max_characters"]
    if (
        isinstance(max_segments, bool)
        or not isinstance(max_segments, int)
        or not 1 <= max_segments <= MAX_ENGINE_SEGMENTS
        or isinstance(max_characters, bool)
        or not isinstance(max_characters, int)
        or not 1 <= max_characters <= MAX_ENGINE_CHARACTERS
    ):
        raise SpeechActionError("invalid_arguments", "Speech output limits are invalid")
    return language, prompt, max_segments, max_characters


def transcribe(
    invocation: dict[str, Any], progress: Progress
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    arguments = invocation["arguments"]
    language, prompt, max_segments, max_characters = validate_arguments(arguments)
    reference, source = selected_input(invocation)
    temporary = runtime_temp()
    normalized_wav = temporary / "normalized.wav"
    request_path = temporary / "request.json"
    response_path = temporary / "response.json"

    progress.emit("normalize.audio", "Normalizing audio", completed=0, total=1, unit="files")
    run_engine(
        [
            str(asset_binary(FFMPEG_ASSET_ID, "ffmpeg")),
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostats",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-sample_fmt",
            "s16",
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            "-y",
            str(normalized_wav),
        ],
        temporary,
        failure_code="audio_decode_failed",
        failure_message="FFmpeg could not normalize the selected audio",
    )
    if normalized_wav.is_symlink() or not normalized_wav.is_file():
        raise SpeechActionError("audio_decode_failed", "FFmpeg did not produce normalized audio")
    progress.emit("normalize.audio", "Audio normalized", completed=1, total=1, unit="files")

    model_sha = expected_model_sha256()
    request_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "input_id": reference["id"],
                "audio_path": str(normalized_wav),
                "language": language,
                "initial_prompt": prompt,
                "configuration": {
                    "task": "transcribe",
                    "threads": 1,
                    "processors": 1,
                    "decoding": "greedy",
                    "best_of": 1,
                    "temperature": 0,
                    "temperature_fallback": False,
                    "flash_attention": False,
                    "word_timestamps": False,
                },
                "limits": {
                    "duration_ms": MAX_DURATION_MS,
                    "segments": MAX_ENGINE_SEGMENTS,
                    "characters": MAX_ENGINE_CHARACTERS,
                },
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    progress.emit("transcribe.audio", "Transcribing audio", completed=0, total=1, unit="files")
    run_engine(
        [
            str(asset_binary(WHISPER_ASSET_ID, "speech-engine")),
            str(request_path),
            str(response_path),
        ],
        temporary,
        failure_code="transcription_failed",
        failure_message="Speech engine could not transcribe the selected audio",
    )
    engine, duration_ms, resolved_language, complete_segments = normalize_engine_response(
        load_engine_response(response_path), expected_model_sha=model_sha
    )
    complete_transcript = "\n".join(segment["text"] for segment in complete_segments)
    visible_segments, truncated = inline_segments(
        complete_segments,
        max_segments=max_segments,
        max_characters=max_characters,
    )
    visible_transcript = "\n".join(segment["text"] for segment in visible_segments)
    total_characters = sum(len(segment["text"]) for segment in complete_segments)

    artifacts: list[dict[str, str]] = []
    text_name = "transcript.txt" if bool(arguments["include_text_artifact"]) else None
    srt_name = "transcript.srt" if bool(arguments["include_srt_artifact"]) else None
    json_name = "transcript.json" if bool(arguments["include_json_artifact"]) else None
    if text_name:
        output_file(text_name).write_text(complete_transcript + "\n", encoding="utf-8")
        artifacts.append(
            {"path": f"/output/{text_name}", "media_type": "text/plain", "name": text_name}
        )
    if srt_name:
        output_file(srt_name).write_text(srt_text(complete_segments), encoding="utf-8")
        artifacts.append(
            {
                "path": f"/output/{srt_name}",
                "media_type": "application/x-subrip",
                "name": srt_name,
            }
        )
    artifact_document = {
        "schema_version": 1,
        "engine": engine,
        "normalization": dict(NORMALIZATION),
        "input_duration_ms": duration_ms,
        "requested_language": language,
        "resolved_language": resolved_language,
        "segments": complete_segments,
        "transcript": complete_transcript,
        "total_segments": len(complete_segments),
        "total_characters": total_characters,
    }
    if json_name:
        output_file(json_name).write_text(
            json.dumps(
                artifact_document,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )
        artifacts.append(
            {
                "path": f"/output/{json_name}",
                "media_type": "application/json",
                "name": json_name,
            }
        )

    progress.emit("transcribe.audio", "Transcript ready", completed=1, total=1, unit="files")
    return {
        "engine": engine,
        "normalization": dict(NORMALIZATION),
        "input_duration_ms": duration_ms,
        "requested_language": language,
        "resolved_language": resolved_language,
        "segments": visible_segments,
        "transcript": visible_transcript,
        "total_segments": len(complete_segments),
        "total_characters": total_characters,
        "truncated": truncated,
        "text_artifact_name": text_name,
        "srt_artifact_name": srt_name,
        "json_artifact_name": json_name,
    }, artifacts


def fail_result(invocation: dict[str, Any], code: str, message: str) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "invocation_id": invocation["invocation_id"],
        "operation_id": invocation["operation_id"],
        "status": "failed",
        "artifacts": [],
        "error": {"code": code, "message": message, "retryable": False},
    }


def cleanup_outputs() -> None:
    root = Path(os.environ["SHEJANE_PLUGIN_OUTPUT_ROOT"])
    for name in ARTIFACT_NAMES:
        (root / name).unlink(missing_ok=True)


def invoke(invocation: dict[str, Any]) -> dict[str, Any]:
    try:
        if invocation["action"]["action_id"] != "speech.transcribe":
            raise SpeechActionError("unsupported_action", "Speech action is unsupported")
        output, artifacts = transcribe(invocation, Progress(invocation))
        return {
            "schema_version": 1,
            "invocation_id": invocation["invocation_id"],
            "operation_id": invocation["operation_id"],
            "status": "succeeded",
            "output": output,
            "artifacts": artifacts,
        }
    except SpeechActionError as exc:
        cleanup_outputs()
        return fail_result(invocation, exc.code, str(exc)[:500])
    except (KeyError, TypeError, ValueError, OSError):
        cleanup_outputs()
        return fail_result(invocation, "speech_processing_failed", "Speech processing failed")
    finally:
        shutil.rmtree(
            Path(os.environ["SHEJANE_PLUGIN_OUTPUT_ROOT"]) / ".runtime-tmp",
            ignore_errors=True,
        )


def main() -> None:
    initialize = json.loads(sys.stdin.readline())
    response(
        initialize["id"],
        {
            "protocol_version": 1,
            "process_isolated": True,
            "access_isolated": os.environ.get("SHEJANE_PLUGIN_ACCESS_ISOLATED") == "1",
            "resource_isolated": os.environ.get("SHEJANE_PLUGIN_RESOURCE_ISOLATED") == "1",
            "sandboxed": os.environ.get("SHEJANE_PLUGIN_SANDBOXED") == "1",
        },
    )
    request = json.loads(sys.stdin.readline())
    response(request["id"], invoke(request["params"]))
    shutdown = json.loads(sys.stdin.readline())
    response(shutdown["id"], {})


if __name__ == "__main__":
    main()
