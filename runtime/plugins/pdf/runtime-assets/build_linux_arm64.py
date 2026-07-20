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
LOCK_PATH = ROOT / "mupdf-1.27.2.lock.json"
DOCKERFILE = ROOT / "Dockerfile.linux-arm64"
TARGET = "linux/arm64"
_MUTOOL_NEEDED = {"libc.so.6", "libm.so.6"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
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
    _verify_source(args.source, lock)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="shejane-mupdf-linux-arm64-", dir=args.output.parent) as temporary:
        work = Path(temporary)
        source = _extract_source(args.source, work)
        image = _build_image(lock)
        stage = work / "asset"
        payload = stage / "payload"
        payload.mkdir(parents=True)
        mutool = _build_mutool(args.source, work, payload, image, lock, args.jobs)
        _write_licenses_and_source(stage, source, args.source, lock)
        _write_metadata(stage, mutool, lock)
        _pack_asset(stage, args.output)
    print(args.output.resolve())


def _verify_source(path: Path, lock: dict[str, Any]) -> None:
    if path.is_symlink():
        raise SystemExit("MuPDF source cannot be a symlink")
    path = path.resolve(strict=True)
    upstream = lock["upstream"]
    if path.stat().st_size != int(upstream["source_size_bytes"]):
        raise SystemExit("MuPDF source size does not match the lock")
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != upstream["source_sha256"]:
        raise SystemExit("MuPDF source SHA-256 does not match the lock")


def _extract_source(archive_path: Path, work: Path) -> Path:
    destination = work / "source"
    destination.mkdir()
    with tarfile.open(archive_path, "r:gz") as archive:
        archive.extractall(destination, filter="data")
    roots = [path for path in destination.iterdir() if path.is_dir()]
    if len(roots) != 1 or roots[0].name != "mupdf-1.27.2-source":
        raise SystemExit("MuPDF source archive layout changed")
    return roots[0]


def _build_image(lock: dict[str, Any]) -> str:
    builder = lock["linux_builder"]
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    for value in (
        builder["oci_image"],
        builder["snapshot"],
        f"build-essential={builder['build_essential_version']}",
        f"pkg-config={builder['pkg_config_version']}",
    ):
        if value not in dockerfile:
            raise SystemExit("Linux MuPDF builder lock and Dockerfile differ")
    tag = f"shejane-mupdf-builder:{hashlib.sha256(DOCKERFILE.read_bytes()).hexdigest()[:16]}"
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
        _run(
            ["docker", "image", "inspect", tag, "--format", "{{json .}}"],
            capture=True,
        ).stdout
    )
    if inspected.get("Os") != "linux" or inspected.get("Architecture") != "arm64":
        raise SystemExit("Linux MuPDF builder architecture changed")
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
for package in gcc-12 make binutils pkg-config; do
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
        builder["pkg_config_version"],
    ]
    if probe != expected:
        raise SystemExit("Linux MuPDF builder toolchain changed")
    return tag


def _build_mutool(
    archive: Path,
    work: Path,
    payload: Path,
    image: str,
    lock: dict[str, Any],
    jobs: int,
) -> Path:
    outputs: list[Path] = []
    policy = " ".join(str(value) for value in lock["make_policy"])
    epoch = int(lock["linux_builder"]["source_date_epoch"])
    script = f"""
mkdir -p /work/source
tar -xzf /input/mupdf.tar.gz -C /work/source --strip-components=1
cd /work/source
export SOURCE_DATE_EPOCH={epoch}
make {policy} \
  XCFLAGS='-ffile-prefix-map=/work/source=. -fdebug-prefix-map=/work/source=.' \
  build/release/mutool -j{jobs} >/dev/null
test "$(build/release/mutool -v 2>&1)" = 'mutool version 1.27.2'
install -m 0500 build/release/mutool /output/mutool
chown -R {os.getuid()}:{os.getgid()} /output
"""
    for build in (1, 2):
        output = work / f"build-{build}"
        output.mkdir()
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
                f"{archive.resolve()}:/input/mupdf.tar.gz:ro",
                "--volume",
                f"{output.resolve()}:/output",
                image,
                "sh",
                "-ceu",
                script,
            ],
            timeout=1200,
        )
        outputs.append(output / "mutool")
    if _file_identity(outputs[0]) != _file_identity(outputs[1]):
        raise SystemExit("MuPDF Linux arm64 build is not reproducible")
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
                f"{outputs[0].resolve()}:/input/mutool:ro",
                image,
                "sh",
                "-ceu",
                "readelf -d /input/mutool | sed -n 's/.*Shared library: \\[\\(.*\\)\\]/\\1/p'",
            ],
            capture=True,
        ).stdout.splitlines()
    )
    if needed != _MUTOOL_NEEDED:
        raise SystemExit(f"MuPDF runtime dependencies changed: {sorted(needed)}")
    destination = payload / "bin" / "mutool"
    destination.parent.mkdir()
    shutil.copyfile(outputs[0], destination)
    destination.chmod(0o500)
    _verify_linux_arm64_elf(destination)
    return destination


def _write_licenses_and_source(
    stage: Path,
    source: Path,
    source_archive: Path,
    lock: dict[str, Any],
) -> None:
    sources = stage / "sources"
    sources.mkdir()
    shutil.copyfile(source_archive, sources / source_archive.name)
    licenses = stage / "licenses"
    for index, component in enumerate(lock["compiled_components"], start=1):
        destination = licenses / f"{index:02d}-{component['name'].lower().replace(' ', '-')}"
        destination.mkdir(parents=True)
        license_source = source / component["license_path"]
        shutil.copyfile(license_source, destination / license_source.name)


def _write_metadata(stage: Path, mutool: Path, lock: dict[str, Any]) -> None:
    metadata = stage / ".shejane-runtime-asset"
    metadata.mkdir()
    upstream = lock["upstream"]
    manifest = {
        "schema_version": 1,
        "id": lock["asset_id"],
        "version": lock["asset_version"],
        "platform": TARGET,
        "license": upstream["license"],
        "source_url": upstream["source_url"],
        "payload": "payload",
        "sbom": ".shejane-runtime-asset/sbom.spdx.json",
        "executables": [mutool.relative_to(stage).as_posix()],
    }
    (metadata / "asset.json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    builder = lock["linux_builder"]
    provenance = {
        "schema_version": 1,
        "target": TARGET,
        "source_sha256": upstream["source_sha256"],
        "make_policy": lock["make_policy"],
        "builder_script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "builder_dockerfile_sha256": hashlib.sha256(DOCKERFILE.read_bytes()).hexdigest(),
        "base_oci_image": builder["oci_image"],
        "debian_snapshot": builder["snapshot"],
        "toolchain_package_manifest_sha256": builder["package_manifest_sha256"],
    }
    (metadata / "build-provenance.json").write_text(
        json.dumps(provenance, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    packages = [
        {
            "name": component["name"],
            "SPDXID": f"SPDXRef-Package-{index}",
            "versionInfo": component["version"],
            "downloadLocation": upstream["source_url"],
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
        "name": "shejane-mupdf-runtime-linux-arm64",
        "documentNamespace": (
            "https://shejane.org/spdx/runtime-assets/mupdf/"
            f"{lock['asset_version']}/linux-arm64/{upstream['source_sha256']}"
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
        json.dumps(sbom, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )


def _verify_linux_arm64_elf(path: Path) -> None:
    with path.open("rb") as stream:
        header = stream.read(20)
    if (
        len(header) != 20
        or header[:4] != b"\x7fELF"
        or header[4:6] != b"\x02\x01"
        or int.from_bytes(header[18:20], "little") != 183
    ):
        raise SystemExit("mutool is not a Linux arm64 ELF executable")


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
                    info = _zip_info(relative, stat.S_IFREG | mode)
                    with archive.open(info, "w") as target, path.open("rb") as source_file:
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


def _file_identity(path: Path) -> tuple[int, str]:
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return path.stat().st_size, digest


def _run(
    command: list[str],
    *,
    capture: bool = False,
    timeout: int = 300,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=True,
        capture_output=capture,
        text=True,
        timeout=timeout,
    )


if __name__ == "__main__":
    main()
