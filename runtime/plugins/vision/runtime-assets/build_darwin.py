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
from typing import Any

ROOT = Path(__file__).resolve().parent
LOCK_PATH = ROOT / "llama-mtmd-b10025.lock.json"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--llama-source", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--projector", type=Path, required=True)
    parser.add_argument("--apache-license", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--codesign-identity", default="-")
    parser.add_argument("--jobs", type=int, default=max(1, os.cpu_count() or 1))
    args = parser.parse_args()
    if sys.platform != "darwin" or platform.machine().lower() != "arm64":
        parser.error("the locked Vision build requires Darwin arm64")
    if args.output.suffix != ".shejane-runtime-asset":
        parser.error("--output must end in .shejane-runtime-asset")

    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    source_archive = verify_file(args.llama_source, lock["llama_cpp"], "source")
    model = verify_file(args.model, lock["model"], "model")
    projector = verify_file(args.projector, lock["projector"], "projector")
    apache_license = verify_file(
        args.apache_license, lock["model_license"], "model license"
    )
    toolchain = verify_toolchain(lock)

    with tempfile.TemporaryDirectory(prefix="shejane-vision-runtime-") as temporary:
        work = Path(temporary)
        source = extract(source_archive, work / "source", "llama.cpp-b10025")
        stage = work / "asset"
        payload = stage / "payload"
        (payload / "bin").mkdir(parents=True)
        (payload / "models").mkdir()
        shutil.copyfile(model, payload / "models" / lock["model"]["filename"])
        shutil.copyfile(projector, payload / "models" / lock["projector"]["filename"])
        (payload / "model-lock.json").write_text(
            json.dumps(
                {"model": lock["model"], "projector": lock["projector"]},
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )
        engine = build_engine(source, payload, work, lock, toolchain, max(1, args.jobs))
        sign_and_verify(engine, args.codesign_identity, lock)
        write_metadata(
            stage,
            source,
            source_archive,
            apache_license,
            engine,
            lock,
            toolchain,
        )
        pack_asset(stage, args.output)
    print(args.output.resolve())


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_file(path: Path, expected: dict[str, Any], kind: str) -> Path:
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise SystemExit(f"locked {kind} is unavailable: {path.name}") from exc
    if resolved.is_symlink() or not resolved.is_file():
        raise SystemExit(f"locked {kind} is not a regular file: {path.name}")
    size = expected.get("source_size_bytes", expected.get("size_bytes"))
    digest = expected.get("source_sha256", expected.get("sha256"))
    if resolved.stat().st_size != int(size) or sha256_file(resolved) != digest:
        raise SystemExit(f"{resolved.name} does not match the lock")
    return resolved


def verify_toolchain(lock: dict[str, Any]) -> dict[str, str]:
    cmake = shutil.which("cmake")
    if cmake is None:
        raise SystemExit("CMake is unavailable")
    expected = {key: str(value) for key, value in lock["darwin_build"].items()}
    xcode = run(["/usr/bin/xcodebuild", "-version"], capture=True).stdout.splitlines()
    actual = {
        "architecture": platform.machine().lower(),
        "deployment_target": expected["deployment_target"],
        "cmake_version": run([cmake, "--version"], capture=True).stdout.splitlines()[0],
        "xcode_version": xcode[0],
        "xcode_build": xcode[1].removeprefix("Build version "),
        "clang_version": run(
            ["/usr/bin/clang", "--version"], capture=True
        ).stdout.splitlines()[0],
        "sdk_version": run(
            ["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-version"],
            capture=True,
        ).stdout.strip(),
        "make_version": run(
            ["/usr/bin/make", "--version"], capture=True
        ).stdout.splitlines()[0],
    }
    if actual != expected:
        raise SystemExit(f"Darwin toolchain does not match the lock: {actual!r}")
    return actual | {
        "cmake_path": cmake,
        "sdk_path": run(
            ["/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path"],
            capture=True,
        ).stdout.strip(),
    }


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
    lock: dict[str, Any],
    toolchain: dict[str, str],
    jobs: int,
) -> Path:
    build = work / "build"
    reproducibility = lock["reproducibility_policy"]
    repository_root = ROOT.parents[3]
    prefix_flags = " ".join(
        (
            f"-ffile-prefix-map={source}={reproducibility['llama_source_prefix']}",
            f"-fdebug-prefix-map={source}={reproducibility['llama_source_prefix']}",
            f"-fmacro-prefix-map={source}={reproducibility['llama_source_prefix']}",
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
            f"-DLLAMA_SOURCE={source}",
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
            "vision-engine",
            "--parallel",
            str(jobs),
        ],
        env=environment,
    )
    built = build / "vision-engine"
    if not built.is_file():
        raise SystemExit("build produced no vision-engine executable")
    destination = payload / "bin" / "vision-engine"
    shutil.copy2(built, destination)
    return destination


def sign_and_verify(binary: Path, identity: str, lock: dict[str, Any]) -> None:
    run(["/usr/bin/codesign", "--force", "--sign", identity, str(binary)])
    run(["/usr/bin/codesign", "--verify", "--strict", str(binary)])
    binary.chmod(0o500)
    dependencies = run(["/usr/bin/otool", "-L", str(binary)], capture=True).stdout
    for line in dependencies.splitlines()[1:]:
        dependency = line.strip().split(" ", 1)[0]
        if not dependency.startswith(("/usr/lib/", "/System/Library/")):
            raise SystemExit(f"vision-engine links an undeclared library: {dependency}")
    for marker in ("Metal.framework", "Accelerate.framework", "libcurl", "libomp"):
        if marker in dependencies:
            raise SystemExit(f"vision-engine includes a forbidden backend: {marker}")
    load_commands = run(["/usr/bin/otool", "-l", str(binary)], capture=True).stdout
    match = re.search(
        r"cmd LC_BUILD_VERSION\s+cmdsize \d+\s+platform \d+\s+minos ([0-9.]+)\s+sdk ([0-9.]+)",
        load_commands,
    )
    darwin = lock["darwin_build"]
    expected = (str(darwin["deployment_target"]), str(darwin["sdk_version"]))
    if match is None or match.groups() != expected:
        raise SystemExit("vision-engine Mach-O version changed")


def write_metadata(
    stage: Path,
    source: Path,
    source_archive: Path,
    apache_license: Path,
    engine: Path,
    lock: dict[str, Any],
    toolchain: dict[str, str],
) -> None:
    sources = stage / "sources"
    sources.mkdir()
    shutil.copy2(source_archive, sources / source_archive.name)
    (sources / "model-sources.json").write_text(
        json.dumps(
            {"model": lock["model"], "projector": lock["projector"]},
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )
    licenses = stage / "licenses"
    (licenses / "llama.cpp").mkdir(parents=True)
    shutil.copy2(source / "LICENSE", licenses / "llama.cpp" / "LICENSE")
    (licenses / "SmolVLM2").mkdir()
    shutil.copy2(apache_license, licenses / "SmolVLM2" / "Apache-2.0.txt")

    metadata = stage / ".shejane-runtime-asset"
    metadata.mkdir()
    public_toolchain = {
        key: value
        for key, value in toolchain.items()
        if key not in {"sdk_path", "cmake_path"}
    }
    provenance = {
        "schema_version": 1,
        "target": lock["platform"],
        "llama_cpp": lock["llama_cpp"],
        "model": lock["model"],
        "projector": lock["projector"],
        "inference_policy": lock["inference_policy"],
        "cmake_policy": lock["cmake_policy"],
        "reproducibility_policy": lock["reproducibility_policy"],
        "toolchain": public_toolchain,
    }
    (metadata / "build-provenance.json").write_text(
        json.dumps(provenance, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    packages = []
    for index, component in enumerate(lock["compiled_components"], start=1):
        model_component = component["name"].startswith("SmolVLM2")
        packages.append(
            {
                "name": component["name"],
                "SPDXID": f"SPDXRef-Package-{index}",
                "versionInfo": component["version"],
                "downloadLocation": (
                    lock["model"]["source_url"]
                    if model_component
                    else lock["llama_cpp"]["source_url"]
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
        "name": "shejane-vision-runtime-darwin-arm64",
        "documentNamespace": (
            "https://shejane.org/spdx/runtime-assets/vision/"
            f"{lock['asset_version']}/{lock['model']['sha256']}"
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
        json.dumps(sbom, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    manifest = {
        "schema_version": 1,
        "id": lock["asset_id"],
        "version": lock["asset_version"],
        "platform": lock["platform"],
        "license": "MIT AND Apache-2.0",
        "source_url": lock["llama_cpp"]["source_url"],
        "payload": "payload",
        "sbom": ".shejane-runtime-asset/sbom.spdx.json",
        "executables": [engine.relative_to(stage).as_posix()],
    }
    (metadata / "asset.json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )


def pack_asset(source: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    try:
        with zipfile.ZipFile(
            temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9
        ) as archive:
            for path in sorted(source.rglob("*")):
                relative = path.relative_to(source).as_posix()
                if path.is_dir():
                    archive.writestr(
                        zip_info(relative + "/", stat.S_IFDIR | 0o700), b""
                    )
                elif path.is_file():
                    mode = 0o500 if path.stat().st_mode & 0o111 else 0o600
                    info = zip_info(relative, stat.S_IFREG | mode)
                    with (
                        archive.open(info, "w") as target,
                        path.open("rb") as input_file,
                    ):
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
