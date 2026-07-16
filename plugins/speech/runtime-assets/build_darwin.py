#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOCK_PATH = ROOT / "whisper-1.8.6.lock.json"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--whisper-source", type=Path, required=True)
    parser.add_argument("--openai-source", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--codesign-identity", default="-")
    parser.add_argument("--jobs", type=int, default=max(1, os.cpu_count() or 1))
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("build_darwin.py must run on macOS")
    if args.output.suffix != ".shejane-runtime-asset":
        parser.error("--output must end in .shejane-runtime-asset")
    machine = platform.machine().lower()
    target = "darwin/arm64" if machine == "arm64" else "darwin/amd64"
    if machine not in {"arm64", "x86_64", "amd64"}:
        parser.error("unsupported Darwin architecture")

    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    verify_input(args.whisper_source, lock["whisper_cpp"], "source")
    verify_input(args.openai_source, lock["openai_whisper"], "source")
    verify_input(args.checkpoint, lock["checkpoint"], "checkpoint")
    verify_model(args.model, lock)
    toolchain = verify_darwin_toolchain(lock)

    with tempfile.TemporaryDirectory(prefix="shejane-whisper-runtime-") as temporary:
        work = Path(temporary)
        source = extract(args.whisper_source, work / "source", "whisper.cpp-1.8.6")
        openai_source = extract(
            args.openai_source, work / "openai-source", "whisper-20250625"
        )
        stage = work / "asset"
        payload = stage / "payload"
        (payload / "bin").mkdir(parents=True)
        (payload / "models").mkdir()
        model_name = str(lock["model_build"]["quantized_name"])
        shutil.copyfile(args.model, payload / "models" / model_name)
        (payload / "model.sha256").write_text(
            str(lock["model_build"]["quantized_sha256"]) + "\n", encoding="ascii"
        )
        engine = build_engine(
            source,
            payload,
            work,
            lock,
            toolchain,
            max(1, args.jobs),
        )
        prepare_binary(engine, args.codesign_identity)
        verify_binary(engine, lock)
        write_metadata(
            stage,
            source,
            openai_source,
            args.whisper_source,
            args.openai_source,
            engine,
            lock,
            toolchain,
            target,
        )
        pack_asset(stage, args.output)
    print(args.output.resolve())


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_input(path: Path, lock: dict[str, object], kind: str) -> None:
    path = path.resolve(strict=True)
    size_key = "size_bytes" if kind == "checkpoint" else "source_size_bytes"
    digest_key = "sha256" if kind == "checkpoint" else "source_sha256"
    if path.stat().st_size != int(lock[size_key]) or sha256_file(path) != lock[digest_key]:
        raise SystemExit(f"{path.name} does not match the lock")


def verify_model(path: Path, lock: dict[str, object]) -> None:
    model = lock["model_build"]
    path = path.resolve(strict=True)
    if (
        path.stat().st_size != int(model["quantized_size_bytes"])
        or sha256_file(path) != model["quantized_sha256"]
    ):
        raise SystemExit("quantized model does not match the lock")


def verify_darwin_toolchain(lock: dict[str, object]) -> dict[str, str]:
    expected = lock["darwin_build"]
    cmake = shutil.which("cmake")
    if cmake is None:
        raise SystemExit("CMake is unavailable")
    clang = run(["/usr/bin/clang", "--version"], capture=True).stdout.splitlines()[0]
    xcode_lines = run(["/usr/bin/xcodebuild", "-version"], capture=True).stdout.splitlines()
    sdk_version = run(
        ["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-version"], capture=True
    ).stdout.strip()
    sdk_path = run(
        ["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path"], capture=True
    ).stdout.strip()
    actual = {
        "xcode_version": xcode_lines[0].removeprefix("Xcode "),
        "xcode_build": xcode_lines[1].removeprefix("Build version "),
        "clang_version": clang,
        "sdk_version": sdk_version,
        "deployment_target": str(expected["deployment_target"]),
        "cmake_version": run([cmake, "--version"], capture=True).stdout.splitlines()[0],
    }
    expected_strings = {key: str(value) for key, value in expected.items()}
    if actual != expected_strings:
        raise SystemExit(f"Darwin toolchain does not match the lock: {actual!r}")
    return actual | {"sdk_path": sdk_path, "cmake_path": cmake}


def extract(archive_path: Path, destination: Path, expected_root: str) -> Path:
    destination.mkdir()
    with tarfile.open(archive_path, "r:gz") as archive:
        archive.extractall(destination, filter="data")
    roots = [path for path in destination.iterdir() if path.is_dir()]
    if len(roots) != 1 or roots[0].name != expected_root:
        raise SystemExit(f"{archive_path.name} layout changed")
    return roots[0]


def build_engine(
    source: Path,
    payload: Path,
    work: Path,
    lock: dict[str, object],
    toolchain: dict[str, str],
    jobs: int,
) -> Path:
    build = work / "build"
    reproducibility = lock["reproducibility_policy"]
    repository_root = ROOT.parents[3]
    prefix_flags = " ".join(
        (
            f"-ffile-prefix-map={source}={reproducibility['whisper_source_prefix']}",
            f"-fdebug-prefix-map={source}={reproducibility['whisper_source_prefix']}",
            f"-fmacro-prefix-map={source}={reproducibility['whisper_source_prefix']}",
            f"-ffile-prefix-map={repository_root}={reproducibility['shejane_source_prefix']}",
            f"-fdebug-prefix-map={repository_root}={reproducibility['shejane_source_prefix']}",
            f"-fmacro-prefix-map={repository_root}={reproducibility['shejane_source_prefix']}",
        )
    )
    environment = {
        "HOME": str(work / "home"),
        "PATH": "/usr/bin:/bin:/opt/homebrew/bin",
        "LANG": "C",
        "LC_ALL": "C",
        "TZ": "UTC",
        "ZERO_AR_DATE": str(reproducibility["zero_ar_date"]),
        "SOURCE_DATE_EPOCH": str(reproducibility["source_date_epoch"]),
        "MACOSX_DEPLOYMENT_TARGET": toolchain["deployment_target"],
        "SDKROOT": toolchain["sdk_path"],
        "CC": "/usr/bin/clang",
        "CXX": "/usr/bin/clang++",
        "AR": "/usr/bin/ar",
        "RANLIB": "/usr/bin/ranlib",
    }
    Path(environment["HOME"]).mkdir()
    run(
        [
            toolchain["cmake_path"],
            "-S",
            str(ROOT),
            "-B",
            str(build),
            "-G",
            "Unix Makefiles",
            f"-DWHISPER_SOURCE={source}",
            f"-DSHEJANE_MODEL_SHA256={lock['model_build']['quantized_sha256']}",
            *[str(value) for value in lock["cmake_policy"]],
            f"-DCMAKE_C_FLAGS={prefix_flags}",
            f"-DCMAKE_CXX_FLAGS={prefix_flags}",
            f"-DCMAKE_OSX_DEPLOYMENT_TARGET={toolchain['deployment_target']}",
            "-DCMAKE_C_COMPILER=/usr/bin/clang",
            "-DCMAKE_CXX_COMPILER=/usr/bin/clang++",
        ],
        env=environment,
    )
    run(
        [
            toolchain["cmake_path"],
            "--build",
            str(build),
            "--target",
            "speech-engine",
            "--parallel",
            str(jobs),
        ],
        env=environment,
    )
    built = build / "speech-engine"
    if not built.is_file():
        raise SystemExit("build produced no speech-engine executable")
    destination = payload / "bin" / "speech-engine"
    shutil.copy2(built, destination)
    return destination


def prepare_binary(binary: Path, identity: str) -> None:
    run(["/usr/bin/codesign", "--force", "--sign", identity, str(binary)])
    run(["/usr/bin/codesign", "--verify", "--strict", str(binary)])
    binary.chmod(0o500)


def verify_binary(binary: Path, lock: dict[str, object]) -> None:
    dependencies = run(["/usr/bin/otool", "-L", str(binary)], capture=True).stdout
    for line in dependencies.splitlines()[1:]:
        dependency = line.strip().split(" ", 1)[0]
        if not dependency.startswith(("/usr/lib/", "/System/Library/")):
            raise SystemExit(f"speech-engine links an undeclared library: {dependency}")
    forbidden = (
        "Metal.framework",
        "Accelerate.framework",
        "CoreML.framework",
        "libcurl",
        "libomp",
    )
    if marker := next((value for value in forbidden if value in dependencies), None):
        raise SystemExit(f"speech-engine includes a forbidden backend: {marker}")
    load_commands = run(["/usr/bin/otool", "-l", str(binary)], capture=True).stdout
    match = re.search(
        r"cmd LC_BUILD_VERSION\s+cmdsize \d+\s+platform \d+\s+minos ([0-9.]+)\s+sdk ([0-9.]+)",
        load_commands,
    )
    darwin = lock["darwin_build"]
    expected = (str(darwin["deployment_target"]), str(darwin["sdk_version"]))
    if match is None or match.groups() != expected:
        raise SystemExit("speech-engine Mach-O version changed")


def write_metadata(
    stage: Path,
    source: Path,
    openai_source: Path,
    whisper_archive: Path,
    openai_archive: Path,
    engine: Path,
    lock: dict[str, object],
    toolchain: dict[str, str],
    target: str,
) -> None:
    sources = stage / "sources"
    sources.mkdir()
    shutil.copy2(whisper_archive, sources / whisper_archive.name)
    shutil.copy2(openai_archive, sources / openai_archive.name)
    (sources / "checkpoint.json").write_text(
        json.dumps(lock["checkpoint"], sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    licenses = stage / "licenses"
    (licenses / "whisper.cpp").mkdir(parents=True)
    shutil.copy2(source / "LICENSE", licenses / "whisper.cpp" / "LICENSE")
    (licenses / "openai-whisper").mkdir()
    shutil.copy2(openai_source / "LICENSE", licenses / "openai-whisper" / "LICENSE")
    (licenses / "nlohmann-json").mkdir()
    (licenses / "nlohmann-json" / "LICENSE.txt").write_text(
        "nlohmann JSON 3.11.2\nSPDX-FileCopyrightText: 2013-2022 Niels Lohmann\nSPDX-License-Identifier: MIT\n",
        encoding="utf-8",
    )

    metadata = stage / ".shejane-runtime-asset"
    metadata.mkdir()
    public_toolchain = {
        key: value
        for key, value in toolchain.items()
        if key not in {"sdk_path", "cmake_path"}
    }
    provenance = {
        "schema_version": 1,
        "target": target,
        "whisper_cpp": lock["whisper_cpp"],
        "openai_whisper": lock["openai_whisper"],
        "checkpoint": lock["checkpoint"],
        "model_build": lock["model_build"],
        "cmake_policy": lock["cmake_policy"],
        "reproducibility_policy": lock["reproducibility_policy"],
        "toolchain": public_toolchain,
    }
    (metadata / "build-provenance.json").write_text(
        json.dumps(provenance, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    packages = []
    for index, component in enumerate(lock["compiled_components"], start=1):
        packages.append(
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
        )
    sbom = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": f"shejane-whisper-runtime-{target.replace('/', '-')}",
        "documentNamespace": (
            "https://shejane.org/spdx/runtime-assets/whisper/"
            f"{lock['asset_version']}/{target.replace('/', '-')}/"
            f"{lock['model_build']['quantized_sha256']}"
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
        json.dumps(sbom, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    manifest = {
        "schema_version": 1,
        "id": lock["asset_id"],
        "version": lock["asset_version"],
        "platform": target,
        "license": "MIT",
        "source_url": lock["whisper_cpp"]["source_url"],
        "payload": "payload",
        "sbom": ".shejane-runtime-asset/sbom.spdx.json",
        "executables": [engine.relative_to(stage).as_posix()],
    }
    (metadata / "asset.json").write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )


def pack_asset(source: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(source.rglob("*")):
                relative = path.relative_to(source).as_posix()
                if path.is_dir():
                    archive.writestr(zip_info(relative + "/", stat.S_IFDIR | 0o700), b"")
                elif path.is_file():
                    mode = 0o500 if path.stat().st_mode & 0o111 else 0o600
                    info = zip_info(relative, stat.S_IFREG | mode)
                    with archive.open(info, "w") as target, path.open("rb") as input_file:
                        shutil.copyfileobj(input_file, target, length=1024 * 1024)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)


def zip_info(name: str, mode: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = mode << 16
    return info


def run(
    command: list[str],
    *,
    env: dict[str, str] | None = None,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        env=env,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
    )


if __name__ == "__main__":
    main()
