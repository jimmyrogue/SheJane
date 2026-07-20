#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
LOCK_PATH = ROOT / "whisper-1.8.6.lock.json"
DOCKERFILE = ROOT / "Dockerfile.linux-arm64"
TARGET = "linux/arm64"
SYSTEM_NEEDED = {"libc.so.6", "libm.so.6"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--whisper-source", type=Path, required=True)
    parser.add_argument("--openai-source", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--jobs", type=int, default=max(1, os.cpu_count() or 1))
    args = parser.parse_args()
    if args.output.suffix != ".shejane-runtime-asset":
        parser.error("--output must end in .shejane-runtime-asset")
    if args.output.exists() or args.output.is_symlink():
        parser.error("--output must not already exist")
    if not 1 <= args.jobs <= 64:
        parser.error("--jobs must be between 1 and 64")

    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    _verify_input(args.whisper_source, lock["whisper_cpp"], "source")
    _verify_input(args.openai_source, lock["openai_whisper"], "source")
    _verify_input(args.checkpoint, lock["checkpoint"], "checkpoint")
    _verify_model(args.model, lock)
    image = _build_image(lock)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="shejane-speech-linux-arm64-", dir=args.output.parent) as temporary:
        work = Path(temporary)
        first = _build_engine(args.whisper_source, work / "first", image, lock, args.jobs)
        second = _build_engine(args.whisper_source, work / "second", image, lock, args.jobs)
        if _file_identity(first) != _file_identity(second):
            raise SystemExit("Speech Linux arm64 engine build is not reproducible")
        whisper_source = _extract(args.whisper_source, work / "whisper-source", "whisper.cpp-1.8.6")
        openai_source = _extract(args.openai_source, work / "openai-source", "whisper-20250625")
        stage = work / "asset"
        payload = stage / "payload"
        (payload / "bin").mkdir(parents=True)
        (payload / "models").mkdir()
        shutil.copyfile(first, payload / "bin" / "speech-engine")
        (payload / "bin" / "speech-engine").chmod(0o500)
        model_name = str(lock["model_build"]["quantized_name"])
        shutil.copyfile(args.model, payload / "models" / model_name)
        (payload / "model.sha256").write_text(
            str(lock["model_build"]["quantized_sha256"]) + "\n", encoding="ascii"
        )
        _verify_engine(payload / "bin" / "speech-engine", image)
        _write_metadata(
            stage,
            whisper_source,
            openai_source,
            args.whisper_source,
            args.openai_source,
            lock,
        )
        _pack_asset(stage, args.output)
    print(args.output.resolve())


def _sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def _verify_input(path: Path, expected: dict[str, Any], kind: str) -> None:
    path = path.resolve(strict=True)
    size_key = "size_bytes" if kind == "checkpoint" else "source_size_bytes"
    digest_key = "sha256" if kind == "checkpoint" else "source_sha256"
    if path.is_symlink() or path.stat().st_size != int(expected[size_key]):
        raise SystemExit(f"{path.name} does not match the lock")
    if _sha256(path) != expected[digest_key]:
        raise SystemExit(f"{path.name} does not match the lock")


def _verify_model(path: Path, lock: dict[str, Any]) -> None:
    path = path.resolve(strict=True)
    model = lock["model_build"]
    if path.is_symlink() or path.stat().st_size != int(model["quantized_size_bytes"]):
        raise SystemExit("quantized model does not match the lock")
    if _sha256(path) != model["quantized_sha256"]:
        raise SystemExit("quantized model does not match the lock")


def _build_image(lock: dict[str, Any]) -> str:
    builder = lock["linux_builder"]
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    for value in (
        builder["oci_image"],
        builder["snapshot"],
        f"build-essential={builder['build_essential_version']}",
        f"cmake={builder['cmake_version']}",
    ):
        if value not in dockerfile:
            raise SystemExit("Linux Speech builder lock and Dockerfile differ")
    tag = f"shejane-speech-builder:{hashlib.sha256(DOCKERFILE.read_bytes()).hexdigest()[:16]}"
    _run(
        [
            "docker",
            "build",
            "--platform",
            TARGET,
            "--file",
            str(DOCKERFILE),
            "--tag",
            tag,
            str(ROOT),
        ],
        timeout=1200,
    )
    inspected = json.loads(
        _run(["docker", "image", "inspect", tag, "--format", "{{json .}}"], capture=True).stdout
    )
    if inspected.get("Os") != "linux" or inspected.get("Architecture") != "arm64":
        raise SystemExit("Linux Speech builder architecture changed")
    probe = _run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--platform",
            TARGET,
            tag,
            "sh",
            "-ceu",
            """
dpkg-query -W -f='${binary:Package}\t${Version}\t${Architecture}\n' | sha256sum | cut -d' ' -f1
for package in gcc-12 make binutils cmake; do
  dpkg-query -W -f='${Version}\n' "$package"
done
""",
        ],
        capture=True,
    ).stdout.splitlines()
    expected = [
        builder["package_manifest_sha256"],
        builder["gcc_version"],
        builder["make_version"],
        builder["binutils_version"],
        builder["cmake_version"],
    ]
    if probe != expected:
        raise SystemExit(f"Linux Speech builder toolchain changed: {probe!r}")
    return tag


def _build_engine(
    archive: Path,
    output: Path,
    image: str,
    lock: dict[str, Any],
    jobs: int,
) -> Path:
    output.mkdir()
    builder = lock["linux_builder"]
    cmake_flags = " ".join(str(value) for value in lock["cmake_policy"])
    linker_flags = " ".join(str(value) for value in builder["linker_policy"])
    model_digest = str(lock["model_build"]["quantized_sha256"])
    epoch = int(builder["source_date_epoch"])
    script = f"""
mkdir -p /work/whisper /work/build
tar -xzf /input/whisper.tar.gz -C /work/whisper --strip-components=1
export HOME=/tmp/home SOURCE_DATE_EPOCH={epoch} TZ=UTC LC_ALL=C LANG=C
mkdir -p "$HOME"
cmake -S /src -B /work/build -G 'Unix Makefiles' \
  -DWHISPER_SOURCE=/work/whisper \
  -DSHEJANE_MODEL_SHA256={model_digest} \
  {cmake_flags} \
  -DCMAKE_C_FLAGS='-ffile-prefix-map=/work/whisper=/usr/src/whisper.cpp -ffile-prefix-map=/src=/usr/src/shejane' \
  -DCMAKE_CXX_FLAGS='-ffile-prefix-map=/work/whisper=/usr/src/whisper.cpp -ffile-prefix-map=/src=/usr/src/shejane' \
  -DCMAKE_EXE_LINKER_FLAGS='{linker_flags}' >/dev/null
cmake --build /work/build --target speech-engine --parallel {jobs} >/dev/null
install -m 0500 /work/build/speech-engine /output/speech-engine
touch -d '@{epoch}' /output/speech-engine
chown -R {os.getuid()}:{os.getgid()} /output
"""
    _run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--platform",
            TARGET,
            "--volume",
            f"{archive.resolve(strict=True)}:/input/whisper.tar.gz:ro",
            "--volume",
            f"{ROOT}:/src:ro",
            "--volume",
            f"{output.resolve()}:/output",
            image,
            "sh",
            "-ceu",
            script,
        ],
        timeout=1800,
    )
    return output / "speech-engine"


def _verify_engine(engine: Path, image: str) -> None:
    with engine.open("rb") as source:
        header = source.read(20)
    if (
        len(header) != 20
        or header[:4] != b"\x7fELF"
        or header[4:6] != b"\x02\x01"
        or int.from_bytes(header[18:20], "little") != 183
    ):
        raise SystemExit("speech-engine is not a Linux arm64 ELF executable")
    needed = set(
        _run(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--platform",
                TARGET,
                "--volume",
                f"{engine.resolve()}:/input/speech-engine:ro",
                image,
                "sh",
                "-ceu",
                "readelf -d /input/speech-engine | sed -n 's/.*Shared library: \\[\\(.*\\)\\]/\\1/p'",
            ],
            capture=True,
        ).stdout.splitlines()
    )
    if needed != SYSTEM_NEEDED:
        raise SystemExit(f"speech-engine runtime dependencies changed: {sorted(needed)}")


def _extract(archive: Path, destination: Path, expected_root: str) -> Path:
    destination.mkdir()
    with tarfile.open(archive, "r:gz") as source:
        source.extractall(destination, filter="data")
    roots = [path for path in destination.iterdir() if path.is_dir()]
    if len(roots) != 1 or roots[0].name != expected_root:
        raise SystemExit(f"{archive.name} layout changed")
    return roots[0]


def _write_metadata(
    stage: Path,
    whisper_source: Path,
    openai_source: Path,
    whisper_archive: Path,
    openai_archive: Path,
    lock: dict[str, Any],
) -> None:
    sources = stage / "sources"
    sources.mkdir()
    shutil.copyfile(whisper_archive, sources / whisper_archive.name)
    shutil.copyfile(openai_archive, sources / openai_archive.name)
    (sources / "checkpoint.json").write_text(
        json.dumps(lock["checkpoint"], sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    licenses = stage / "licenses"
    (licenses / "whisper.cpp").mkdir(parents=True)
    shutil.copyfile(whisper_source / "LICENSE", licenses / "whisper.cpp" / "LICENSE")
    (licenses / "openai-whisper").mkdir()
    shutil.copyfile(openai_source / "LICENSE", licenses / "openai-whisper" / "LICENSE")
    (licenses / "nlohmann-json").mkdir()
    (licenses / "nlohmann-json" / "LICENSE.txt").write_text(
        "nlohmann JSON 3.11.2\nSPDX-License-Identifier: MIT\n", encoding="utf-8"
    )
    metadata = stage / ".shejane-runtime-asset"
    metadata.mkdir()
    provenance = {
        "schema_version": 1,
        "target": TARGET,
        "whisper_cpp": lock["whisper_cpp"],
        "openai_whisper": lock["openai_whisper"],
        "checkpoint": lock["checkpoint"],
        "model_build": lock["model_build"],
        "cmake_policy": lock["cmake_policy"],
        "reproducibility_policy": lock["reproducibility_policy"],
        "toolchain": lock["linux_builder"],
        "builder_script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "builder_dockerfile_sha256": hashlib.sha256(DOCKERFILE.read_bytes()).hexdigest(),
    }
    (metadata / "build-provenance.json").write_text(
        json.dumps(provenance, sort_keys=True, separators=(",", ":")), encoding="utf-8"
    )
    packages = [
        {
            "name": component["name"],
            "SPDXID": f"SPDXRef-Package-{index}",
            "versionInfo": component["version"],
            "downloadLocation": (
                lock["checkpoint"]["source_url"]
                if component["name"] == "OpenAI Whisper model"
                else lock["whisper_cpp"]["source_url"]
            ),
            "filesAnalyzed": False,
            "licenseConcluded": component["license"],
            "licenseDeclared": component["license"],
            "copyrightText": "NOASSERTION",
        }
        for index, component in enumerate(lock["compiled_components"], start=1)
    ]
    sbom = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": "shejane-whisper-runtime-linux-arm64",
        "documentNamespace": (
            "https://shejane.org/spdx/runtime-assets/whisper/"
            f"{lock['asset_version']}/linux-arm64/{lock['model_build']['quantized_sha256']}"
        ),
        "creationInfo": {
            "created": lock["created_at"],
            "creators": ["Organization: SheJane"],
        },
        "packages": packages,
        "relationships": [
            {
                "spdxElementId": "SPDXRef-DOCUMENT",
                "relationshipType": "DESCRIBES",
                "relatedSpdxElement": package["SPDXID"],
            }
            for package in packages
        ],
    }
    (metadata / "sbom.spdx.json").write_text(
        json.dumps(sbom, sort_keys=True, separators=(",", ":")), encoding="utf-8"
    )
    manifest = {
        "schema_version": 1,
        "id": lock["asset_id"],
        "version": lock["asset_version"],
        "platform": TARGET,
        "license": "MIT",
        "source_url": lock["whisper_cpp"]["source_url"],
        "payload": "payload",
        "sbom": ".shejane-runtime-asset/sbom.spdx.json",
        "executables": ["payload/bin/speech-engine"],
    }
    (metadata / "asset.json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")), encoding="utf-8"
    )


def _file_identity(path: Path) -> tuple[int, str]:
    return path.stat().st_size, _sha256(path)


def _pack_asset(source: Path, output: Path) -> None:
    temporary = output.with_suffix(output.suffix + ".tmp")
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(source.rglob("*")):
                relative = path.relative_to(source).as_posix()
                if path.is_dir():
                    archive.writestr(_zip_info(relative + "/", stat.S_IFDIR | 0o700), b"")
                elif path.is_file():
                    mode = 0o700 if path.stat().st_mode & 0o111 else 0o600
                    with archive.open(_zip_info(relative, stat.S_IFREG | mode), "w") as target:
                        with path.open("rb") as source_file:
                            shutil.copyfileobj(source_file, target, length=1024 * 1024)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)


def _zip_info(name: str, mode: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = mode << 16
    return info


def _run(
    command: list[str], *, capture: bool = False, timeout: int = 120
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        timeout=timeout,
    )


if __name__ == "__main__":
    main()
