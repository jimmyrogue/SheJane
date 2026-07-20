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
LOCK_PATH = ROOT / "libreoffice-25.8.7.lock.json"
SIGNING_KEY = ROOT / "libreoffice-build-team.asc"
DOCKERFILE = ROOT / "Dockerfile.linux-arm64"
TARGET = "linux/arm64"
_LIBREOFFICE_DEB_COUNT = 42
_MUTOOL_NEEDED = {"libc.so.6", "libm.so.6"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--libreoffice-archive", type=Path, required=True)
    parser.add_argument("--libreoffice-signature", type=Path, required=True)
    parser.add_argument("--mupdf-source", type=Path, required=True)
    parser.add_argument("--noto-cjk", type=Path, required=True)
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
    platform = lock["libreoffice"]["platforms"][TARGET]
    _verify_locked_file(args.libreoffice_archive, platform)
    _verify_locked_file(args.libreoffice_signature, platform["signature"])
    _verify_locked_file(SIGNING_KEY, platform["signing_key"])
    _verify_locked_file(
        args.mupdf_source,
        {
            "size_bytes": lock["pdf_renderer"]["source_size_bytes"],
            "sha256": lock["pdf_renderer"]["source_sha256"],
        },
    )
    _verify_locked_file(args.noto_cjk, lock["font_baseline"])

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="shejane-office-linux-arm64-", dir=args.output.parent
    ) as temporary:
        work = Path(temporary)
        _verify_libreoffice_signature(
            args.libreoffice_archive,
            args.libreoffice_signature,
            SIGNING_KEY,
            platform["signature"]["signing_fingerprint"],
            work,
        )
        image = _build_image(lock)
        stage = work / "asset"
        payload = stage / "payload"
        payload.mkdir(parents=True)
        libreoffice = _extract_libreoffice(
            args.libreoffice_archive, payload, lock["linux_builder"]["oci_image"]
        )
        _add_noto(args.noto_cjk, libreoffice, stage)
        _build_mupdf(
            args.mupdf_source,
            work,
            payload,
            image,
            args.jobs,
            int(lock["linux_builder"]["source_date_epoch"]),
        )
        _copy_licenses(args.mupdf_source, libreoffice, stage)
        _write_metadata(stage, lock)
        _pack_asset(stage, args.output)
    print(args.output.resolve())


def _verify_locked_file(path: Path, expected: dict[str, Any]) -> None:
    if path.is_symlink():
        raise SystemExit(f"locked input cannot be a symlink: {path.name}")
    path = path.resolve(strict=True)
    if not path.is_file() or path.stat().st_size != int(expected["size_bytes"]):
        raise SystemExit(f"locked input size mismatch: {path.name}")
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != expected["sha256"]:
        raise SystemExit(f"locked input digest mismatch: {path.name}")


def _verify_libreoffice_signature(
    archive: Path,
    signature: Path,
    signing_key: Path,
    fingerprint: str,
    work: Path,
) -> None:
    home = work / "gpg"
    home.mkdir(mode=0o700)
    _run(["gpg", "--homedir", str(home), "--batch", "--import", str(signing_key.resolve())])
    fingerprints = _run(
        ["gpg", "--homedir", str(home), "--batch", "--with-colons", "--fingerprint"],
        capture=True,
    ).stdout.splitlines()
    if fingerprint not in {line.split(":")[9] for line in fingerprints if line.startswith("fpr:")}:
        raise SystemExit("LibreOffice signing key fingerprint changed")
    verification = _run(
        [
            "gpg",
            "--homedir",
            str(home),
            "--batch",
            "--status-fd",
            "1",
            "--verify",
            str(signature.resolve()),
            str(archive.resolve()),
        ],
        capture=True,
    ).stdout
    if f"[GNUPG:] VALIDSIG {fingerprint} " not in verification:
        raise SystemExit("LibreOffice archive signature is invalid")


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
            raise SystemExit("Linux Office builder lock and Dockerfile differ")
    tag = f"shejane-office-builder:{hashlib.sha256(DOCKERFILE.read_bytes()).hexdigest()[:16]}"
    _run(
        [
            "docker",
            "build",
            "--platform",
            "linux/arm64",
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
        raise SystemExit("Linux Office builder architecture changed")
    probe = _run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--platform",
            "linux/arm64",
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
        raise SystemExit("Linux Office builder toolchain changed")
    return tag


def _extract_libreoffice(archive: Path, payload: Path, image: str) -> Path:
    _run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--platform",
            "linux/arm64",
            "--volume",
            f"{archive.resolve()}:/input/libreoffice.tar.gz:ro",
            "--volume",
            f"{payload.resolve()}:/output",
            image,
            "sh",
            "-ceu",
            f"""
mkdir /source /extract
tar -xzf /input/libreoffice.tar.gz -C /source
set -- /source/*
test "$#" -eq 1
test -d "$1/DEBS"
set -- "$1"/DEBS/*.deb
test "$#" -eq {_LIBREOFFICE_DEB_COUNT}
for package do dpkg-deb -x "$package" /extract; done
test -x /extract/opt/libreoffice25.8/program/soffice
test -x /extract/opt/libreoffice25.8/program/soffice.bin
cp -a /extract/opt/libreoffice25.8 /output/libreoffice
chown -R {os.getuid()}:{os.getgid()} /output
""",
        ],
        timeout=600,
    )
    libreoffice = payload / "libreoffice"
    _verify_linux_arm64_elf(libreoffice / "program" / "soffice.bin")
    _verify_internal_symlinks(libreoffice)
    return libreoffice


def _add_noto(archive_path: Path, libreoffice: Path, stage: Path) -> None:
    with zipfile.ZipFile(archive_path) as archive:
        if set(archive.namelist()) != {"LICENSE", "NotoSansCJK.ttc"}:
            raise SystemExit("Noto CJK archive layout changed")
        (libreoffice / "share" / "fonts" / "truetype" / "NotoSansCJK.ttc").write_bytes(
            archive.read("NotoSansCJK.ttc")
        )
        license_root = stage / "licenses" / "noto-cjk"
        license_root.mkdir(parents=True)
        (license_root / "OFL.txt").write_bytes(archive.read("LICENSE"))


def _build_mupdf(
    archive: Path,
    work: Path,
    payload: Path,
    image: str,
    jobs: int,
    source_date_epoch: int,
) -> Path:
    outputs = []
    script = f"""
mkdir -p /work/source
tar -xzf /input/mupdf.tar.gz -C /work/source --strip-components=1
cd /work/source
export SOURCE_DATE_EPOCH={source_date_epoch}
make build=release HAVE_LIBCRYPTO=no HAVE_X11=no HAVE_GLUT=no HAVE_GLFW=no \
  XCFLAGS='-ffile-prefix-map=/work/source=. -fdebug-prefix-map=/work/source=.' \
  tools -j{jobs} >/dev/null
test "$(build/release/mutool -v 2>&1)" = 'mutool version 1.27.2'
install -m 0500 build/release/mutool /output/mutool
chown -R {os.getuid()}:{os.getgid()} /output
"""
    for build in (1, 2):
        output = work / f"mupdf-output-{build}"
        output.mkdir()
        _run(
            [
                "docker",
                "run",
                "--rm",
                "--network",
                "none",
                "--platform",
                "linux/arm64",
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
                "linux/arm64",
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


def _copy_licenses(mupdf_archive: Path, libreoffice: Path, stage: Path) -> None:
    libreoffice_licenses = stage / "licenses" / "libreoffice"
    libreoffice_licenses.mkdir(parents=True)
    for name in ("CREDITS.fodt", "LICENSE", "LICENSE.html", "NOTICE"):
        shutil.copyfile(libreoffice / name, libreoffice_licenses / name)
    mupdf_licenses = stage / "licenses" / "mupdf"
    mupdf_licenses.mkdir(parents=True)
    with tarfile.open(mupdf_archive, "r:gz") as archive:
        member = archive.getmember("mupdf-1.27.2-source/COPYING")
        source = archive.extractfile(member)
        if not member.isfile() or source is None or member.size > 1024 * 1024:
            raise SystemExit("MuPDF license source changed")
        with source, (mupdf_licenses / "COPYING").open("wb") as destination:
            shutil.copyfileobj(source, destination)


def _write_metadata(stage: Path, lock: dict[str, Any]) -> None:
    (stage / "payload" / "office-runtime.json").write_text(
        json.dumps(
            {"soffice": "libreoffice/program/oosplash", "mutool": "bin/mutool"},
            sort_keys=True,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    metadata = stage / ".shejane-runtime-asset"
    metadata.mkdir()
    platform = lock["libreoffice"]["platforms"][TARGET]
    executables = _asset_executables(stage)
    required = {
        "payload/bin/mutool",
        "payload/libreoffice/program/oosplash",
        "payload/libreoffice/program/soffice",
        "payload/libreoffice/program/soffice.bin",
    }
    if not required.issubset(executables) or len(executables) > 256:
        raise SystemExit("Office Runtime Asset executable set changed")
    manifest = {
        "schema_version": 1,
        "id": lock["asset_id"],
        "version": lock["asset_version"],
        "platform": TARGET,
        "license": "MPL-2.0 AND AGPL-3.0-only AND OFL-1.1",
        "source_url": platform["url"],
        "payload": "payload",
        "sbom": ".shejane-runtime-asset/sbom.spdx.json",
        "executables": executables,
    }
    (metadata / "asset.json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    build = {
        "schema_version": 1,
        "builder_script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "builder_dockerfile_sha256": hashlib.sha256(DOCKERFILE.read_bytes()).hexdigest(),
        "base_oci_image": lock["linux_builder"]["oci_image"],
        "debian_snapshot": lock["linux_builder"]["snapshot"],
        "toolchain_package_manifest_sha256": lock["linux_builder"]["package_manifest_sha256"],
        "libreoffice_signing_fingerprint": platform["signature"]["signing_fingerprint"],
    }
    (metadata / "build.json").write_text(
        json.dumps(build, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    sbom = _sbom(lock)
    (metadata / "sbom.spdx.json").write_text(
        json.dumps(sbom, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )


def _asset_executables(stage: Path) -> list[str]:
    payload = stage / "payload"
    return sorted(
        path.relative_to(stage).as_posix()
        for path in payload.rglob("*")
        if not path.is_symlink()
        and path.is_file()
        and path.stat().st_mode & 0o111
        and ".so" not in path.name
    )


def _sbom(lock: dict[str, Any]) -> dict[str, Any]:
    office = lock["libreoffice"]
    renderer = lock["pdf_renderer"]
    font = lock["font_baseline"]
    platform = office["platforms"][TARGET]
    packages = [
        _spdx_package("LibreOffice", office["version"], office["license"], platform),
        _spdx_package(
            "MuPDF",
            renderer["version"],
            renderer["license"],
            {"url": renderer["source_url"], "sha256": renderer["source_sha256"]},
        ),
        _spdx_package("Noto Sans CJK", font["version"], font["license"], font),
    ]
    packages[0]["comment"] = (
        "OpenPGP signature verified with " + platform["signature"]["signing_fingerprint"]
    )
    return {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": "shejane-office-runtime-linux-arm64",
        "documentNamespace": (
            "https://shejane.org/spdx/runtime-assets/"
            f"{lock['asset_version']}/linux-arm64/{platform['sha256']}"
        ),
        "creationInfo": {
            "created": "2026-07-16T00:00:00Z",
            "creators": ["Organization: SheJane"],
        },
        "packages": packages,
        "relationships": [
            {
                "spdxElementId": "SPDXRef-DOCUMENT",
                "relationshipType": "DESCRIBES",
                "relatedSpdxElement": f"SPDXRef-Package-{name}",
            }
            for name in ("LibreOffice", "MuPDF", "Noto-Sans-CJK")
        ],
    }


def _spdx_package(
    name: str,
    version: str,
    license_id: str,
    source: dict[str, Any],
) -> dict[str, Any]:
    return {
        "name": name,
        "SPDXID": f"SPDXRef-Package-{name.replace(' ', '-')}",
        "versionInfo": version,
        "downloadLocation": source["url"],
        "filesAnalyzed": False,
        "licenseConcluded": license_id,
        "licenseDeclared": license_id,
        "copyrightText": "NOASSERTION",
        "checksums": [{"algorithm": "SHA256", "checksumValue": source["sha256"]}],
    }


def _verify_linux_arm64_elf(path: Path) -> None:
    with path.open("rb") as stream:
        header = stream.read(20)
    if (
        len(header) != 20
        or header[:4] != b"\x7fELF"
        or header[4:6] != b"\x02\x01"
        or int.from_bytes(header[18:20], "little") != 183
    ):
        raise SystemExit(f"Linux Office executable is not arm64 ELF: {path.name}")


def _verify_internal_symlinks(root: Path) -> None:
    resolved_root = root.resolve(strict=True)
    for path in root.rglob("*"):
        if not path.is_symlink():
            continue
        target = os.readlink(path)
        if os.path.isabs(target):
            raise SystemExit("LibreOffice contains an absolute symlink")
        try:
            path.resolve(strict=True).relative_to(resolved_root)
        except (OSError, RuntimeError, ValueError) as exc:
            raise SystemExit("LibreOffice symlink escapes its runtime tree") from exc


def _pack_asset(source: Path, output: Path) -> None:
    temporary = output.with_suffix(output.suffix + ".tmp")
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(source.rglob("*")):
                relative = path.relative_to(source).as_posix()
                if path.is_symlink():
                    archive.writestr(
                        _zip_info(relative, stat.S_IFLNK | 0o777),
                        os.readlink(path).encode("utf-8"),
                    )
                elif path.is_dir():
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
