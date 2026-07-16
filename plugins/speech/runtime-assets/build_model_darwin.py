#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOCK_PATH = ROOT / "whisper-1.8.6.lock.json"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--whisper-source", type=Path, required=True)
    parser.add_argument("--openai-source", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--jobs", type=int, default=max(1, os.cpu_count() or 1))
    args = parser.parse_args()
    if sys.platform != "darwin" or platform.machine().lower() != "arm64":
        parser.error("the locked canonical model build requires Darwin arm64")
    if args.output.suffix != ".bin":
        parser.error("--output must end in .bin")

    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    verify_file(args.whisper_source, lock["whisper_cpp"], "source")
    verify_file(args.openai_source, lock["openai_whisper"], "source")
    verify_file(args.checkpoint, lock["checkpoint"], "checkpoint")
    verify_python(args.python, lock)
    python = args.python.absolute()
    verify_toolchain(lock)

    with tempfile.TemporaryDirectory(prefix="shejane-whisper-model-") as temporary:
        work = Path(temporary)
        whisper_source = extract(
            args.whisper_source, work / "whisper.cpp", "whisper.cpp-1.8.6"
        )
        openai_source = extract(
            args.openai_source, work / "openai-whisper", "whisper-20250625"
        )
        model_dir = work / "model"
        model_dir.mkdir()
        environment = build_environment(work)
        run(
            [
                str(python),
                str(whisper_source / "models" / "convert-pt-to-ggml.py"),
                str(args.checkpoint.resolve(strict=True)),
                str(openai_source),
                str(model_dir),
            ],
            env=environment,
            stdout=subprocess.DEVNULL,
        )
        converted = model_dir / "ggml-model.bin"
        verify_product(
            converted,
            size=int(lock["model_build"]["converted_size_bytes"]),
            digest=str(lock["model_build"]["converted_sha256"]),
            label="converted model",
        )

        quantizer = build_quantizer(
            whisper_source, work, lock, max(1, args.jobs), environment
        )
        quantized = model_dir / str(lock["model_build"]["quantized_name"])
        run(
            [
                str(quantizer),
                str(converted),
                str(quantized),
                str(lock["model_build"]["quantization"]),
            ],
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        verify_product(
            quantized,
            size=int(lock["model_build"]["quantized_size_bytes"]),
            digest=str(lock["model_build"]["quantized_sha256"]),
            label="quantized model",
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary_output = args.output.with_suffix(args.output.suffix + ".tmp")
        shutil.copyfile(quantized, temporary_output)
        temporary_output.replace(args.output)
    print(args.output.resolve())


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_file(path: Path, lock: dict[str, object], kind: str) -> None:
    path = path.resolve(strict=True)
    size_key = "size_bytes" if kind == "checkpoint" else "source_size_bytes"
    digest_key = "sha256" if kind == "checkpoint" else "source_sha256"
    if path.stat().st_size != int(lock[size_key]):
        raise SystemExit(f"{path.name} size does not match the lock")
    if sha256_file(path) != lock[digest_key]:
        raise SystemExit(f"{path.name} SHA-256 does not match the lock")


def verify_python(python: Path, lock: dict[str, object]) -> None:
    executable = python.absolute()
    if not executable.is_file():
        raise SystemExit("model Python executable is unavailable")
    code = "import json,platform,torch,numpy;print(json.dumps([platform.python_version(),torch.__version__,numpy.__version__]))"
    versions = json.loads(
        run([str(executable), "-c", code], capture=True).stdout.strip()
    )
    model = lock["model_build"]
    expected = [
        model["python_version"],
        model["torch_version"],
        model["numpy_version"],
    ]
    if versions != expected:
        raise SystemExit(f"model Python environment changed: {versions!r}")


def verify_toolchain(lock: dict[str, object]) -> None:
    cmake = shutil.which("cmake")
    if cmake is None:
        raise SystemExit("CMake is unavailable")
    actual = run([cmake, "--version"], capture=True).stdout.splitlines()[0]
    if actual != lock["darwin_build"]["cmake_version"]:
        raise SystemExit(f"CMake version changed: {actual}")


def extract(archive_path: Path, destination: Path, expected_root: str) -> Path:
    destination.mkdir()
    with tarfile.open(archive_path, "r:gz") as archive:
        archive.extractall(destination, filter="data")
    roots = [path for path in destination.iterdir() if path.is_dir()]
    if len(roots) != 1 or roots[0].name != expected_root:
        raise SystemExit(f"{archive_path.name} layout changed")
    return roots[0]


def build_environment(work: Path) -> dict[str, str]:
    home = work / "home"
    home.mkdir(exist_ok=True)
    return {
        "HOME": str(home),
        "PATH": "/usr/bin:/bin:/opt/homebrew/bin",
        "LANG": "C",
        "LC_ALL": "C",
        "TZ": "UTC",
        "ZERO_AR_DATE": "1",
        "SOURCE_DATE_EPOCH": "0",
        "MACOSX_DEPLOYMENT_TARGET": "11.0",
        "CC": "/usr/bin/clang",
        "CXX": "/usr/bin/clang++",
        "AR": "/usr/bin/ar",
        "RANLIB": "/usr/bin/ranlib",
    }


def build_quantizer(
    source: Path,
    work: Path,
    lock: dict[str, object],
    jobs: int,
    environment: dict[str, str],
) -> Path:
    cmake = shutil.which("cmake")
    assert cmake is not None
    build = work / "quantizer-build"
    policy = [str(value) for value in lock["cmake_policy"]]
    policy = [
        "-DWHISPER_BUILD_EXAMPLES=ON"
        if value == "-DWHISPER_BUILD_EXAMPLES=OFF"
        else value
        for value in policy
    ]
    run(
        [
            cmake,
            "-S",
            str(source),
            "-B",
            str(build),
            "-G",
            "Unix Makefiles",
            *policy,
            "-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0",
            "-DCMAKE_C_COMPILER=/usr/bin/clang",
            "-DCMAKE_CXX_COMPILER=/usr/bin/clang++",
        ],
        env=environment,
        stdout=subprocess.DEVNULL,
    )
    run(
        [cmake, "--build", str(build), "--target", "whisper-quantize", "--parallel", str(jobs)],
        env=environment,
        stdout=subprocess.DEVNULL,
    )
    quantizer = build / "bin" / "whisper-quantize"
    if not quantizer.is_file():
        raise SystemExit("quantizer build produced no executable")
    return quantizer


def verify_product(path: Path, *, size: int, digest: str, label: str) -> None:
    if not path.is_file() or path.stat().st_size != size:
        raise SystemExit(f"{label} size does not match the lock")
    if sha256_file(path) != digest:
        raise SystemExit(f"{label} SHA-256 does not match the lock")


def run(
    command: list[str],
    *,
    env: dict[str, str] | None = None,
    capture: bool = False,
    stdout: int | None = None,
    stderr: int | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        env=env,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else stdout,
        stderr=stderr,
    )


if __name__ == "__main__":
    main()
