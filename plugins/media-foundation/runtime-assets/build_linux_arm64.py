#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import shutil
import stat
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from verify_source import verify_source

ROOT = Path(__file__).resolve().parent
LOCK_PATH = ROOT / "ffmpeg-8.1.2.lock.json"
DOCKERFILE = ROOT / "Dockerfile.linux-arm64"
TARGET = "linux/arm64"
SYSTEM_NEEDED = {"ld-linux-aarch64.so.1", "libc.so.6", "libm.so.6"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--signature", type=Path, required=True)
    parser.add_argument("--signing-key", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--jobs", type=int, default=max(1, os.cpu_count() or 1))
    args = parser.parse_args()
    if args.output.suffix != ".shejane-runtime-asset":
        parser.error("--output must end in .shejane-runtime-asset")
    if args.output.exists() or args.output.is_symlink():
        parser.error("--output must not already exist")
    if not 1 <= args.jobs <= 64:
        parser.error("--jobs must be between 1 and 64")

    lock = verify_source(args.source, args.signature, args.signing_key)
    image = _build_image(lock)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="shejane-ffmpeg-linux-arm64-", dir=args.output.parent) as temporary:
        work = Path(temporary)
        first = _build(args.source, work / "first", image, lock, args.jobs)
        second = _build(args.source, work / "second", image, lock, args.jobs)
        if _tree_identity(first) != _tree_identity(second):
            raise SystemExit("FFmpeg Linux arm64 build is not reproducible")
        stage = work / "asset"
        payload = stage / "payload"
        shutil.copytree(first, payload)
        source = _extract_source(args.source, work)
        _write_sources_and_licenses(
            stage, source, args.source, args.signature, args.signing_key, first
        )
        _verify_runtime(stage, image, lock)
        _write_metadata(stage, lock)
        _pack_asset(stage, args.output)
    print(args.output.resolve())


def _linux_flags(lock: dict[str, Any]) -> list[str]:
    flags = [str(value) for value in lock["configure_policy"]]
    override = lock["linux_configure_override"]
    removed = [str(value) for value in override["remove"]]
    for value in removed:
        if flags.count(value) != 1:
            raise SystemExit("Linux FFmpeg configure removal does not match the base policy")
        flags.remove(value)
    flags.extend(str(value) for value in override["append"])
    if any(value in flags for value in lock["forbidden_configuration"]):
        raise SystemExit("locked FFmpeg configuration enables forbidden code")
    return flags


def _build_image(lock: dict[str, Any]) -> str:
    builder = lock["linux_builder"]
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    for value in (
        builder["oci_image"],
        builder["snapshot"],
        f"build-essential={builder['build_essential_version']}",
        f"pkg-config={builder['pkg_config_version']}",
        f"zlib1g-dev={builder['zlib_dev_version']}",
    ):
        if value not in dockerfile:
            raise SystemExit("Linux FFmpeg builder lock and Dockerfile differ")
    tag = f"shejane-ffmpeg-builder:{hashlib.sha256(DOCKERFILE.read_bytes()).hexdigest()[:16]}"
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
        raise SystemExit("Linux FFmpeg builder architecture changed")
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
for package in gcc-12 make binutils pkg-config zlib1g-dev; do
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
        builder["zlib_dev_version"],
    ]
    if probe != expected:
        raise SystemExit(f"Linux FFmpeg builder toolchain changed: {probe!r}")
    return tag


def _build(
    archive: Path,
    output: Path,
    image: str,
    lock: dict[str, Any],
    jobs: int,
) -> Path:
    output.mkdir()
    flags = shlex.join(_linux_flags(lock))
    epoch = int(lock["linux_builder"]["source_date_epoch"])
    script = f"""
mkdir -p /work/source /output/stage
tar -xJf /input/ffmpeg.tar.xz -C /work/source --strip-components=1
cd /work/source
export SOURCE_DATE_EPOCH={epoch} TZ=UTC LC_ALL=C LANG=C
./configure {flags}
make -j{jobs} >/dev/null
make install DESTDIR=/output/stage >/dev/null
rm -rf /output/stage/include /output/stage/lib/pkgconfig /output/stage/share
cp -L /usr/lib/aarch64-linux-gnu/libz.so.1 /output/stage/lib/libz.so.1
cp /usr/share/doc/zlib1g-dev/copyright /output/zlib-copyright
find /output/stage -type f -exec touch -d '@{epoch}' {{}} +
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
            f"{archive.resolve(strict=True)}:/input/ffmpeg.tar.xz:ro",
            "--volume",
            f"{output.resolve()}:/output",
            image,
            "sh",
            "-ceu",
            script,
        ],
        timeout=1800,
    )
    stage = output / "stage"
    for path in sorted(stage.rglob("*")):
        if path.is_symlink():
            target = path.resolve(strict=True)
            data = target.read_bytes()
            path.unlink()
            path.write_bytes(data)
        if path.is_file():
            path.chmod(0o500 if path.parent.name == "bin" else 0o600)
    return stage


def _extract_source(archive_path: Path, work: Path) -> Path:
    destination = work / "source-metadata"
    destination.mkdir()
    with tarfile.open(archive_path, "r:xz") as archive:
        archive.extractall(destination, filter="data")
    roots = [path for path in destination.iterdir() if path.is_dir()]
    if len(roots) != 1 or roots[0].name != "ffmpeg-8.1.2":
        raise SystemExit("FFmpeg source archive layout changed")
    return roots[0]


def _write_sources_and_licenses(
    stage: Path,
    source: Path,
    source_archive: Path,
    signature: Path,
    signing_key: Path,
    built: Path,
) -> None:
    sources = stage / "sources"
    sources.mkdir()
    shutil.copyfile(source_archive, sources / source_archive.name)
    shutil.copyfile(signature, sources / signature.name)
    shutil.copyfile(signing_key, sources / signing_key.name)
    licenses = stage / "licenses"
    (licenses / "ffmpeg").mkdir(parents=True)
    for name in ("COPYING.LGPLv2.1", "LICENSE.md"):
        shutil.copyfile(source / name, licenses / "ffmpeg" / name)
    (licenses / "zlib").mkdir()
    # Debian's exact zlib copyright accompanies the packaged libz bytes.
    shutil.copyfile(built.parent / "zlib-copyright", licenses / "zlib" / "copyright")


def _verify_runtime(stage: Path, image: str, lock: dict[str, Any]) -> None:
    flags = _linux_flags(lock)
    script = r"""
export LD_LIBRARY_PATH=/asset/payload/lib LC_ALL=C LANG=C TZ=UTC
/asset/payload/bin/ffmpeg -version > /tmp/ffmpeg-version
/asset/payload/bin/ffprobe -version > /tmp/ffprobe-version
head -1 /tmp/ffmpeg-version
head -1 /tmp/ffprobe-version
sed -n 's/^configuration: //p' /tmp/ffmpeg-version
for file in /asset/payload/bin/ffmpeg /asset/payload/bin/ffprobe /asset/payload/lib/*.so*; do
  test -L "$file" && exit 91
  readelf -h "$file" | grep -Fq 'Machine:                           AArch64'
  readelf -d "$file" | sed -n 's/.*Shared library: \[\(.*\)\]/NEEDED \1/p'
done
"""
    output = _run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--platform",
            TARGET,
            "--volume",
            f"{stage.resolve()}:/asset:ro",
            image,
            "sh",
            "-ceu",
            script,
        ],
        capture=True,
    ).stdout.splitlines()
    if len(output) < 3 or not output[0].startswith("ffmpeg version 8.1.2") or not output[
        1
    ].startswith("ffprobe version 8.1.2"):
        raise SystemExit("built FFmpeg version changed")
    if shlex.split(output[2]) != flags:
        raise SystemExit("built FFmpeg configuration changed")
    needed = {line.removeprefix("NEEDED ") for line in output[3:] if line.startswith("NEEDED ")}
    packaged = {path.name for path in (stage / "payload" / "lib").iterdir()}
    if not needed - packaged <= SYSTEM_NEEDED:
        raise SystemExit(f"FFmpeg runtime dependency closure changed: {sorted(needed - packaged)}")


def _write_metadata(stage: Path, lock: dict[str, Any]) -> None:
    metadata = stage / ".shejane-runtime-asset"
    metadata.mkdir()
    upstream = lock["upstream"]
    executables = ["payload/bin/ffmpeg", "payload/bin/ffprobe"]
    manifest = {
        "schema_version": 1,
        "id": lock["asset_id"],
        "version": lock["asset_version"],
        "platform": TARGET,
        "license": upstream["license"],
        "source_url": upstream["source_url"],
        "payload": "payload",
        "sbom": ".shejane-runtime-asset/sbom.spdx.json",
        "executables": executables,
    }
    (metadata / "asset.json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")), encoding="utf-8"
    )
    builder = lock["linux_builder"]
    provenance = {
        "schema_version": 1,
        "target": TARGET,
        "source_sha256": upstream["source_sha256"],
        "source_authentication": "verified_upstream_openpgp_signature",
        "configure_policy": _linux_flags(lock),
        "builder_script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "builder_dockerfile_sha256": hashlib.sha256(DOCKERFILE.read_bytes()).hexdigest(),
        "base_oci_image": builder["oci_image"],
        "debian_snapshot": builder["snapshot"],
        "toolchain_package_manifest_sha256": builder["package_manifest_sha256"],
    }
    (metadata / "build-provenance.json").write_text(
        json.dumps(provenance, sort_keys=True, separators=(",", ":")), encoding="utf-8"
    )
    packages = [
        {
            "name": "FFmpeg",
            "SPDXID": "SPDXRef-Package-FFmpeg",
            "versionInfo": upstream["version"],
            "downloadLocation": upstream["source_url"],
            "filesAnalyzed": False,
            "licenseConcluded": upstream["license"],
            "licenseDeclared": upstream["license"],
            "copyrightText": "NOASSERTION",
        },
        {
            "name": "zlib",
            "SPDXID": "SPDXRef-Package-zlib",
            "versionInfo": "1.2.13",
            "downloadLocation": "https://zlib.net/",
            "filesAnalyzed": False,
            "licenseConcluded": "Zlib",
            "licenseDeclared": "Zlib",
            "copyrightText": "NOASSERTION",
        },
    ]
    sbom = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": "shejane-ffmpeg-runtime-linux-arm64",
        "documentNamespace": (
            "https://shejane.org/spdx/runtime-assets/ffmpeg/"
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
        json.dumps(sbom, sort_keys=True, separators=(",", ":")), encoding="utf-8"
    )


def _tree_identity(root: Path) -> list[tuple[str, int, str]]:
    result = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        result.append((path.relative_to(root).as_posix(), path.stat().st_size, digest))
    return result


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
    command: list[str],
    *,
    capture: bool = False,
    timeout: int = 120,
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
