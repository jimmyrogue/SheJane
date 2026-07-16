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
LOCK_PATH = ROOT / "mupdf-1.27.2.lock.json"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
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
    verify_source(args.source, lock)
    toolchain = verify_darwin_toolchain(lock)
    with tempfile.TemporaryDirectory(prefix="shejane-mupdf-runtime-") as temporary:
        work = Path(temporary)
        source = extract_source(args.source, work)
        stage = work / "asset"
        payload = stage / "payload"
        payload.mkdir(parents=True)
        mutool = build_mutool(source, payload, lock, toolchain, work, max(1, args.jobs))
        prepare_binary(mutool, args.codesign_identity)
        verify_binary(mutool, lock)
        write_metadata(stage, source, args.source, mutool, lock, toolchain, target)
        pack_asset(stage, args.output)
    print(args.output.resolve())


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_source(path: Path, lock: dict[str, object]) -> None:
    path = path.resolve(strict=True)
    upstream = lock["upstream"]  # type: ignore[index]
    if path.stat().st_size != int(upstream["source_size_bytes"]):  # type: ignore[index]
        raise SystemExit("MuPDF source size does not match the lock")
    if sha256_file(path) != upstream["source_sha256"]:  # type: ignore[index]
        raise SystemExit("MuPDF source SHA-256 does not match the lock")


def verify_darwin_toolchain(lock: dict[str, object]) -> dict[str, str]:
    expected = lock["darwin_build"]  # type: ignore[index]
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
        "deployment_target": str(expected["deployment_target"]),  # type: ignore[index]
        "make_version": run(["/usr/bin/make", "--version"], capture=True).stdout.splitlines()[0],
    }
    expected_strings = {key: str(value) for key, value in expected.items()}  # type: ignore[union-attr]
    if actual != expected_strings:
        raise SystemExit(f"Darwin toolchain does not match the lock: {actual!r}")
    return actual | {"sdk_path": sdk_path}


def extract_source(archive_path: Path, work: Path) -> Path:
    destination = work / "source"
    destination.mkdir()
    with tarfile.open(archive_path, "r:gz") as archive:
        archive.extractall(destination, filter="data")
    roots = [path for path in destination.iterdir() if path.is_dir()]
    if len(roots) != 1 or roots[0].name != "mupdf-1.27.2-source":
        raise SystemExit("MuPDF source archive layout changed")
    return roots[0]


def build_mutool(
    source: Path,
    payload: Path,
    lock: dict[str, object],
    toolchain: dict[str, str],
    work: Path,
    jobs: int,
) -> Path:
    deployment = toolchain["deployment_target"]
    env = {
        "HOME": str(work / "home"),
        "PATH": "/usr/bin:/bin",
        "CC": "/usr/bin/clang",
        "CXX": "/usr/bin/clang++",
        "AR": "/usr/bin/ar",
        "RANLIB": "/usr/bin/ranlib",
        "PKG_CONFIG": "/usr/bin/false",
        "LANG": "C",
        "LC_ALL": "C",
        "TZ": "UTC",
        "ZERO_AR_DATE": "1",
        "MACOSX_DEPLOYMENT_TARGET": deployment,
        "SDKROOT": toolchain["sdk_path"],
    }
    Path(env["HOME"]).mkdir()
    make_policy = [str(item) for item in lock["make_policy"]]  # type: ignore[index]
    run(
        [
            "/usr/bin/make",
            *make_policy,
            "CC=/usr/bin/clang",
            "CXX=/usr/bin/clang++",
            "AR=/usr/bin/ar",
            "RANLIB=/usr/bin/ranlib",
            f"XCFLAGS=-mmacosx-version-min={deployment}",
            f"XLDFLAGS=-mmacosx-version-min={deployment}",
            f"-j{jobs}",
            "build/release/mutool",
        ],
        cwd=source,
        env=env,
    )
    built = source / "build" / "release" / "mutool"
    if not built.is_file():
        raise SystemExit("MuPDF build produced no mutool executable")
    destination = payload / "bin" / "mutool"
    destination.parent.mkdir(parents=True)
    shutil.copy2(built, destination)
    return destination


def prepare_binary(binary: Path, identity: str) -> None:
    run(["/usr/bin/codesign", "--force", "--sign", identity, str(binary)])
    run(["/usr/bin/codesign", "--verify", "--strict", str(binary)])
    binary.chmod(0o500)


def verify_binary(binary: Path, lock: dict[str, object]) -> None:
    version = run([str(binary), "-v"], capture=True).stdout.strip()
    if version != "mutool version 1.27.2":
        raise SystemExit(f"built MuPDF version changed: {version!r}")
    draw_help = run([str(binary), "draw"], capture=True, check=False).stdout
    if "ocr'd text:" not in draw_help or "(disabled)" not in draw_help:
        raise SystemExit("MuPDF OCR capability is unexpectedly enabled")
    strings = run(["/usr/bin/strings", str(binary)], capture=True).stdout
    forbidden_markers = ("TessBaseAPI", "BrotliDecoder", "ZXing", "archive_read_new")
    if marker := next((item for item in forbidden_markers if item in strings), None):
        raise SystemExit(f"MuPDF includes a disabled optional component: {marker}")
    dependencies = run(["/usr/bin/otool", "-L", str(binary)], capture=True).stdout
    for line in dependencies.splitlines()[1:]:
        dependency = line.strip().split(" ", 1)[0]
        if not dependency.startswith(("/usr/lib/", "/System/Library/")):
            raise SystemExit(f"mutool links an undeclared library: {dependency}")
    darwin = lock["darwin_build"]  # type: ignore[index]
    load_commands = run(["/usr/bin/otool", "-l", str(binary)], capture=True).stdout
    match = re.search(
        r"cmd LC_BUILD_VERSION\s+cmdsize \d+\s+platform \d+\s+minos ([0-9.]+)\s+sdk ([0-9.]+)",
        load_commands,
    )
    expected = (str(darwin["deployment_target"]), str(darwin["sdk_version"]))  # type: ignore[index]
    if match is None or match.groups() != expected:
        raise SystemExit(f"mutool Mach-O build version changed: {match.groups() if match else None}")


def write_metadata(
    stage: Path,
    source: Path,
    source_archive: Path,
    mutool: Path,
    lock: dict[str, object],
    toolchain: dict[str, str],
    target: str,
) -> None:
    sources = stage / "sources"
    sources.mkdir()
    shutil.copy2(source_archive, sources / source_archive.name)
    licenses = stage / "licenses"
    packages: list[dict[str, object]] = []
    for index, component in enumerate(lock["compiled_components"]):  # type: ignore[union-attr]
        component_id = f"SPDXRef-Package-{index + 1}"
        destination = licenses / f"{index + 1:02d}-{component['name'].lower().replace(' ', '-')}"
        destination.mkdir(parents=True)
        license_source = source / str(component["license_path"])
        shutil.copy2(license_source, destination / license_source.name)
        packages.append(
            {
                "name": component["name"],
                "SPDXID": component_id,
                "versionInfo": component["version"],
                "downloadLocation": lock["upstream"]["source_url"],  # type: ignore[index]
                "filesAnalyzed": False,
                "licenseConcluded": component["license"],
                "licenseDeclared": component["license"],
                "copyrightText": "NOASSERTION",
            }
        )
    metadata = stage / ".shejane-runtime-asset"
    metadata.mkdir()
    public_toolchain = {key: value for key, value in toolchain.items() if key != "sdk_path"}
    provenance = {
        "schema_version": 1,
        "target": target,
        "source_sha256": lock["upstream"]["source_sha256"],  # type: ignore[index]
        "make_policy": lock["make_policy"],
        "toolchain": public_toolchain,
    }
    (metadata / "build-provenance.json").write_text(
        json.dumps(provenance, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    sbom = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": f"shejane-mupdf-runtime-{target.replace('/', '-')}",
        "documentNamespace": (
            "https://shejane.org/spdx/runtime-assets/mupdf/"
            f"{lock['asset_version']}/{target.replace('/', '-')}/{lock['upstream']['source_sha256']}"  # type: ignore[index]
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
        "license": lock["upstream"]["license"],  # type: ignore[index]
        "source_url": lock["upstream"]["source_url"],  # type: ignore[index]
        "payload": "payload",
        "sbom": ".shejane-runtime-asset/sbom.spdx.json",
        "executables": [mutool.relative_to(stage).as_posix()],
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
                    with archive.open(info, "w") as target_file, path.open("rb") as source_file:
                        shutil.copyfileobj(source_file, target_file, length=1024 * 1024)
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
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    capture: bool = False,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        env=env,
        check=check,
        text=True,
        encoding="utf-8",
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
    )


if __name__ == "__main__":
    main()
