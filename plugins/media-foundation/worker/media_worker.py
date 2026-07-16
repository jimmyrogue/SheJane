#!/usr/bin/env python3
"""One-shot Media Foundation Managed Worker using an exact FFmpeg Runtime Asset."""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Any

ASSET_ID = "org.ffmpeg.runtime"


def send(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def response(request_id: int, result: Any) -> None:
    send({"jsonrpc": "2.0", "id": request_id, "result": result})


def fail_result(invocation: dict[str, Any], code: str, message: str) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "invocation_id": invocation["invocation_id"],
        "operation_id": invocation["operation_id"],
        "status": "failed",
        "artifacts": [],
        "error": {"code": code, "message": message, "retryable": False},
    }


class Progress:
    def __init__(self, invocation: dict[str, Any]) -> None:
        self.invocation = invocation
        self.sequence = 0

    def emit(
        self,
        phase: str,
        message: str,
        *,
        completed: int | float | None = None,
        total: int | float | None = None,
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


def contained_file(root: Path, virtual_path: str, prefix: str) -> Path:
    relative = PurePosixPath(virtual_path).relative_to(prefix)
    if not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        raise ValueError("unsafe staged path")
    candidate = root.joinpath(*relative.parts)
    if candidate.is_symlink() or not candidate.is_file():
        raise ValueError("staged input is unavailable")
    candidate.resolve(strict=True).relative_to(root.resolve(strict=True))
    return candidate


def engine_binary(name: str) -> Path:
    try:
        assets = json.loads(os.environ["SHEJANE_PLUGIN_RUNTIME_ASSETS"])
        payload = Path(assets[ASSET_ID]).resolve(strict=True)
    except (KeyError, OSError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("FFmpeg Runtime Asset is unavailable") from exc
    executable = payload / "bin" / (f"{name}.exe" if os.name == "nt" else name)
    if executable.is_symlink() or not executable.is_file():
        raise ValueError(f"{name} is unavailable in the FFmpeg Runtime Asset")
    executable.resolve(strict=True).relative_to(payload)
    return executable


def selected_input_reference(invocation: dict[str, Any]) -> dict[str, Any]:
    input_id = invocation["arguments"]["input_id"]
    return next(item for item in invocation["inputs"] if item["id"] == input_id)


def selected_input(invocation: dict[str, Any]) -> Path:
    reference = selected_input_reference(invocation)
    return contained_file(
        Path(os.environ["SHEJANE_PLUGIN_INPUT_ROOT"]),
        str(reference["path"]),
        "/input",
    )


def output_file(relative: str) -> Path:
    root = Path(os.environ["SHEJANE_PLUGIN_OUTPUT_ROOT"]).resolve(strict=True)
    destination = root / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.parent.resolve(strict=True).relative_to(root)
    return destination


def run_engine(command: list[str]) -> subprocess.CompletedProcess[str]:
    runtime_library_path = str(Path(command[0]).resolve(strict=True).parent.parent / "lib")
    library_environment = (
        {"DYLD_LIBRARY_PATH": runtime_library_path}
        if sys.platform == "darwin"
        else {"LD_LIBRARY_PATH": runtime_library_path}
        if os.name != "nt"
        else {}
    )
    return subprocess.run(
        command,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        env={
            key: value
            for key, value in os.environ.items()
            if key
            in {
                "PATH",
                "SystemRoot",
                "WINDIR",
                "TMP",
                "TEMP",
                "TMPDIR",
                "SHEJANE_PLUGIN_INPUT_ROOT",
                "SHEJANE_PLUGIN_OUTPUT_ROOT",
                "SHEJANE_PLUGIN_RUNTIME_ASSETS",
            }
        }
        | library_environment
        | {"LC_ALL": "C", "LANG": "C", "TZ": "UTC"},
    )


def finite_number(value: Any, *, minimum: float = 0, maximum: float = 10**12) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and minimum <= number <= maximum else None


def positive_int(value: Any, *, maximum: int = 10**9) -> int | None:
    number = finite_number(value, minimum=0, maximum=maximum)
    if number is None or not number.is_integer():
        return None
    return int(number)


def probe(
    invocation: dict[str, Any], progress: Progress
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    source = selected_input(invocation)
    progress.emit("probe", "Reading media metadata")
    completed = run_engine(
        [
            str(engine_binary("ffprobe")),
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            str(source),
        ]
    )
    if completed.returncode != 0 or len(completed.stdout.encode("utf-8")) > 4 * 1024 * 1024:
        raise ValueError("ffprobe could not read this media file")
    try:
        raw = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("ffprobe returned invalid metadata") from exc
    streams: list[dict[str, Any]] = []
    for item in raw.get("streams", [])[:128]:
        if not isinstance(item, dict):
            continue
        stream: dict[str, Any] = {
            "index": positive_int(item.get("index"), maximum=1024) or 0,
            "codec_type": str(item.get("codec_type") or "unknown")[:32],
            "codec_name": str(item.get("codec_name") or "unknown")[:64],
        }
        for key, maximum in (("width", 100_000), ("height", 100_000), ("channels", 1024)):
            value = positive_int(item.get(key), maximum=maximum)
            if value is not None:
                stream[key] = value
        sample_rate = positive_int(item.get("sample_rate"), maximum=10_000_000)
        if sample_rate is not None:
            stream["sample_rate"] = sample_rate
        duration = finite_number(item.get("duration"), maximum=10**9)
        if duration is not None:
            stream["duration_seconds"] = duration
        frame_rate = str(item.get("avg_frame_rate") or "")[:64]
        if frame_rate:
            stream["average_frame_rate"] = frame_rate
        streams.append(stream)
    format_item = raw.get("format") if isinstance(raw.get("format"), dict) else {}
    format_output: dict[str, Any] = {"name": str(format_item.get("format_name") or "unknown")[:128]}
    for source_key, target_key, maximum in (
        ("duration", "duration_seconds", 10**9),
        ("size", "size_bytes", 10**12),
        ("bit_rate", "bit_rate", 10**12),
    ):
        value = finite_number(format_item.get(source_key), maximum=maximum)
        if value is not None:
            format_output[target_key] = int(value) if target_key != "duration_seconds" else value
    progress.emit("probe", "Media metadata ready", completed=1, total=1, unit="files")
    return {"format": format_output, "streams": streams}, []


def common_ffmpeg(source: Path) -> list[str]:
    return [
        str(engine_binary("ffmpeg")),
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostats",
        "-i",
        str(source),
    ]


def thumbnail(
    invocation: dict[str, Any], progress: Progress
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    source = selected_input(invocation)
    arguments = invocation["arguments"]
    timestamp = float(arguments["timestamp_seconds"])
    width = int(arguments["max_width"])
    height = int(arguments["max_height"])
    destination = output_file("thumbnail.png")
    progress.emit("thumbnail", "Rendering thumbnail")
    command = common_ffmpeg(source)
    media_type = str(selected_input_reference(invocation)["media_type"])
    if media_type.startswith("image/"):
        if timestamp != 0:
            raise ValueError("static image thumbnails require timestamp_seconds 0")
    else:
        command[6:6] = ["-ss", format(timestamp, ".6f")]
    command.extend(
        [
            "-frames:v",
            "1",
            "-vf",
            f"scale={width}:{height}:force_original_aspect_ratio=decrease",
            "-map_metadata",
            "-1",
            "-fflags",
            "+bitexact",
            "-flags:v",
            "+bitexact",
            "-f",
            "image2",
            str(destination),
        ]
    )
    if run_engine(command).returncode != 0 or not destination.is_file():
        raise ValueError("FFmpeg could not render the thumbnail")
    progress.emit("thumbnail", "Thumbnail ready", completed=1, total=1, unit="images")
    return (
        {"timestamp_seconds": timestamp, "width_limit": width, "height_limit": height},
        [{"path": "/output/thumbnail.png", "media_type": "image/png", "name": "thumbnail.png"}],
    )


def extract_frames(
    invocation: dict[str, Any], progress: Progress
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    source = selected_input(invocation)
    arguments = invocation["arguments"]
    timestamps = [float(value) for value in arguments["timestamps_seconds"]]
    width = int(arguments["max_width"])
    height = int(arguments["max_height"])
    artifacts: list[dict[str, str]] = []
    frames: list[dict[str, Any]] = []
    for index, timestamp in enumerate(timestamps, start=1):
        name = f"frame-{index:03d}.png"
        destination = output_file(f"frames/{name}")
        progress.emit(
            "extract.frames",
            f"Rendering frame {index} of {len(timestamps)}",
            completed=index - 1,
            total=len(timestamps),
            unit="frames",
        )
        command = common_ffmpeg(source)
        command[6:6] = ["-ss", format(timestamp, ".6f")]
        command.extend(
            [
                "-frames:v",
                "1",
                "-vf",
                f"scale={width}:{height}:force_original_aspect_ratio=decrease",
                "-map_metadata",
                "-1",
                "-fflags",
                "+bitexact",
                "-flags:v",
                "+bitexact",
                "-f",
                "image2",
                str(destination),
            ]
        )
        if run_engine(command).returncode != 0 or not destination.is_file():
            raise ValueError(f"FFmpeg could not render frame {index}")
        path = f"/output/frames/{name}"
        frames.append({"timestamp_seconds": timestamp, "artifact_name": name})
        artifacts.append({"path": path, "media_type": "image/png", "name": name})
    progress.emit(
        "extract.frames",
        "Frames ready",
        completed=len(timestamps),
        total=len(timestamps),
        unit="frames",
    )
    return {"frames": frames}, artifacts


def extract_audio(
    invocation: dict[str, Any], progress: Progress
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    source = selected_input(invocation)
    arguments = invocation["arguments"]
    output_format = str(arguments["format"])
    sample_rate = int(arguments["sample_rate"])
    channels = int(arguments["channels"])
    stream_index = int(arguments["stream_index"])
    name = f"audio.{output_format}"
    destination = output_file(name)
    progress.emit("extract.audio", "Extracting audio")
    command = common_ffmpeg(source)
    command.extend(
        [
            "-map",
            f"0:{stream_index}",
            "-vn",
            "-ar",
            str(sample_rate),
            "-ac",
            str(channels),
            "-map_metadata",
            "-1",
            "-fflags",
            "+bitexact",
        ]
    )
    if output_format == "wav":
        command.extend(["-c:a", "pcm_s16le", "-f", "wav"])
        media_type = "audio/wav"
    else:
        command.extend(["-c:a", "flac", "-f", "flac"])
        media_type = "audio/flac"
    command.append(str(destination))
    if run_engine(command).returncode != 0 or not destination.is_file():
        raise ValueError("FFmpeg could not extract the audio stream")
    progress.emit("extract.audio", "Audio ready", completed=1, total=1, unit="files")
    return (
        {
            "format": output_format,
            "sample_rate": sample_rate,
            "channels": channels,
            "stream_index": stream_index,
        },
        [{"path": f"/output/{name}", "media_type": media_type, "name": name}],
    )


ACTIONS = {
    "media.probe": probe,
    "media.thumbnail": thumbnail,
    "media.extract_frames": extract_frames,
    "media.extract_audio": extract_audio,
}


def invoke(invocation: dict[str, Any]) -> dict[str, Any]:
    try:
        action_id = str(invocation["action"]["action_id"])
        handler = ACTIONS[action_id]
        output, artifacts = handler(invocation, Progress(invocation))
        return {
            "schema_version": 1,
            "invocation_id": invocation["invocation_id"],
            "operation_id": invocation["operation_id"],
            "status": "succeeded",
            "output": output,
            "artifacts": artifacts,
        }
    except (KeyError, StopIteration, TypeError, ValueError, OSError) as exc:
        return fail_result(invocation, "media_processing_failed", str(exc)[:500])


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
