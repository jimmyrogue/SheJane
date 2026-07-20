#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

from verify_source import verify_source


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--signature", type=Path, required=True)
    parser.add_argument("--signing-key", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--codesign-identity", default="-")
    parser.add_argument("--jobs", type=int, default=max(1, os.cpu_count() or 1))
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("build_darwin.py must run on macOS")
    if args.output.suffix != ".shejane-runtime-asset":
        parser.error("--output must end in .shejane-runtime-asset")
    target = "darwin/arm64" if platform.machine().lower() == "arm64" else "darwin/amd64"
    lock = verify_source(args.source, args.signature, args.signing_key)
    toolchain = verify_darwin_toolchain(lock)

    with tempfile.TemporaryDirectory(prefix="shejane-ffmpeg-runtime-") as temporary:
        work = Path(temporary)
        source = extract_source(args.source, work)
        stage = work / "asset"
        payload = stage / "payload"
        payload.mkdir(parents=True)
        build(source, payload, lock, toolchain, work, max(1, args.jobs))
        prepare_macos_binaries(payload, args.codesign_identity)
        verify_built_runtime(payload, lock)
        write_metadata(
            stage,
            payload,
            source,
            args.source,
            args.signature,
            args.signing_key,
            lock,
            toolchain,
            target,
        )
        pack_asset(stage, args.output)
    print(args.output.resolve())


def extract_source(archive_path: Path, work: Path) -> Path:
    destination = work / "source"
    destination.mkdir()
    with tarfile.open(archive_path, "r:xz") as archive:
        archive.extractall(destination, filter="data")
    roots = [path for path in destination.iterdir() if path.is_dir()]
    if len(roots) != 1 or roots[0].name != "ffmpeg-8.1.2":
        raise SystemExit("FFmpeg source archive layout changed")
    return roots[0]


def build(
    source: Path,
    payload: Path,
    lock: dict[str, object],
    toolchain: dict[str, str],
    work: Path,
    jobs: int,
) -> None:
    flags = [str(flag) for flag in lock["configure_policy"]]  # type: ignore[index]
    if any(flag in flags for flag in lock["forbidden_configuration"]):  # type: ignore[index]
        raise SystemExit("locked FFmpeg configuration enables forbidden code")
    env = {
        "HOME": str(work / "home"),
        "PATH": "/usr/bin:/bin",
        "CC": "/usr/bin/clang",
        "CXX": "/usr/bin/clang++",
        "PKG_CONFIG": "/usr/bin/false",
        "LANG": "C",
        "LC_ALL": "C",
        "TZ": "UTC",
        "ZERO_AR_DATE": "1",
        "MACOSX_DEPLOYMENT_TARGET": toolchain["deployment_target"],
        "SDKROOT": toolchain["sdk_path"],
        "AR": "/usr/bin/ar",
        "RANLIB": "/usr/bin/ranlib",
        "STRIP": "/usr/bin/strip",
    }
    Path(env["HOME"]).mkdir()
    run([str(source / "configure"), *flags], cwd=source, env=env)
    run(["/usr/bin/make", f"-j{jobs}"], cwd=source, env=env)
    run(["/usr/bin/make", "install", f"DESTDIR={payload}"], cwd=source, env=env)
    for relative in ("include", "share", "lib/pkgconfig"):
        shutil.rmtree(payload / relative, ignore_errors=True)


def prepare_macos_binaries(payload: Path, identity: str) -> None:
    binaries = [payload / "bin" / "ffmpeg", payload / "bin" / "ffprobe"]
    libraries = sorted(
        path
        for path in (payload / "lib").glob("*.dylib")
        if path.is_file() and not path.is_symlink()
    )
    for binary in binaries:
        run(["/usr/bin/install_name_tool", "-add_rpath", "@executable_path/../lib", str(binary)])
    for path in [*libraries, *binaries]:
        run(["/usr/bin/codesign", "--force", "--sign", identity, str(path)])
    for path in [*libraries, *binaries]:
        run(["/usr/bin/codesign", "--verify", "--strict", str(path)])
    for path in payload.rglob("*"):
        if path.is_file() and not path.is_symlink():
            path.chmod(0o500 if path in binaries else 0o600)


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
    make_version = run(["/usr/bin/make", "--version"], capture=True).stdout.splitlines()[0]
    actual = {
        "xcode_version": xcode_lines[0].removeprefix("Xcode "),
        "xcode_build": xcode_lines[1].removeprefix("Build version "),
        "clang_version": clang,
        "sdk_version": sdk_version,
        "deployment_target": str(expected["deployment_target"]),  # type: ignore[index]
        "make_version": make_version,
    }
    expected_strings = {key: str(value) for key, value in expected.items()}  # type: ignore[union-attr]
    if actual != expected_strings:
        raise SystemExit(
            "Darwin build toolchain does not match the lock\n"
            f"expected: {expected_strings!r}\n"
            f"actual:   {actual!r}"
        )
    return actual | {"sdk_path": sdk_path}


def verify_built_runtime(payload: Path, lock: dict[str, object]) -> None:
    ffmpeg = payload / "bin" / "ffmpeg"
    ffprobe = payload / "bin" / "ffprobe"
    environment = {
        "PATH": "/usr/bin:/bin",
        "LANG": "C",
        "LC_ALL": "C",
        "TZ": "UTC",
        "DYLD_LIBRARY_PATH": str(payload / "lib"),
    }
    version = run([str(ffmpeg), "-version"], env=environment, capture=True).stdout
    probe_version = run([str(ffprobe), "-version"], env=environment, capture=True).stdout
    if not version.startswith("ffmpeg version 8.1.2") or not probe_version.startswith(
        "ffprobe version 8.1.2"
    ):
        raise SystemExit("built FFmpeg version does not match the lock")
    configuration = next(
        (
            line.removeprefix("configuration: ")
            for line in version.splitlines()
            if line.startswith("configuration: ")
        ),
        "",
    )
    expected_flags = [str(flag) for flag in lock["configure_policy"]]  # type: ignore[index]
    if shlex.split(configuration) != expected_flags:
        raise SystemExit(
            "built FFmpeg configuration does not match the lock\n"
            f"expected: {expected_flags!r}\n"
            f"actual:   {configuration!r}"
        )
    if any(
        forbidden in configuration
        for forbidden in lock["forbidden_configuration"]  # type: ignore[union-attr]
    ):
        raise SystemExit("built FFmpeg contains forbidden configuration")
    required = lock["required_capabilities"]  # type: ignore[index]
    for kind, option in (
        ("decoders", "-decoders"),
        ("demuxers", "-demuxers"),
        ("encoders", "-encoders"),
        ("muxers", "-muxers"),
        ("filters", "-filters"),
    ):
        output = run([str(ffmpeg), option], env=environment, capture=True).stdout
        assert_required_components(kind, output, set(required[kind]))  # type: ignore[index]
    protocols = run([str(ffmpeg), "-protocols"], env=environment, capture=True).stdout
    protocol_names = {
        line.strip()
        for line in protocols.splitlines()
        if line.strip() and line.strip() not in {"Supported file protocols:", "Input:", "Output:"}
    }
    expected_protocols = set(required["protocols"])  # type: ignore[arg-type,index]
    if protocol_names != expected_protocols:
        raise SystemExit(f"built FFmpeg protocol surface changed: {sorted(protocol_names)}")
    linked_files = [ffmpeg, ffprobe, *sorted((payload / "lib").glob("*.dylib"))]
    linked_zlib = False
    darwin_build = lock["darwin_build"]  # type: ignore[index]
    for executable in linked_files:
        if executable.is_symlink():
            continue
        dependencies = run(["/usr/bin/otool", "-L", str(executable)], capture=True).stdout
        for line in dependencies.splitlines()[1:]:
            dependency = line.strip().split(" ", 1)[0]
            if not dependency.startswith(("@rpath/", "/usr/lib/", "/System/Library/")):
                raise SystemExit(f"FFmpeg links an undeclared library: {dependency}")
            linked_zlib = linked_zlib or dependency.startswith("/usr/lib/libz.")
        verify_macho_build_version(
            executable,
            deployment_target=str(darwin_build["deployment_target"]),  # type: ignore[index]
            sdk_version=str(darwin_build["sdk_version"]),  # type: ignore[index]
        )
    if not linked_zlib:
        raise SystemExit("built FFmpeg does not link the locked zlib system dependency")


def assert_required_components(kind: str, output: str, required: set[str]) -> None:
    available: set[str] = set()
    for line in output.splitlines():
        match = re.match(r"^\s*[A-Z\.]{1,7}\s+([a-zA-Z0-9_,.-]+)(?:\s|$)", line)
        if match:
            available.update(match.group(1).split(","))
    missing = sorted(required - available)
    if missing:
        raise SystemExit(f"built FFmpeg is missing locked {kind}: {missing}")


def verify_macho_build_version(
    executable: Path, *, deployment_target: str, sdk_version: str
) -> None:
    output = run(["/usr/bin/otool", "-l", str(executable)], capture=True).stdout
    match = re.search(
        r"cmd LC_BUILD_VERSION\s+cmdsize \d+\s+platform \d+\s+minos ([0-9.]+)\s+sdk ([0-9.]+)",
        output,
    )
    if match is None or match.groups() != (deployment_target, sdk_version):
        raise SystemExit(
            f"Mach-O build version changed for {executable.name}: "
            f"{match.groups() if match else 'missing'}"
        )


def write_metadata(
    stage: Path,
    payload: Path,
    source: Path,
    source_archive: Path,
    signature: Path,
    signing_key: Path,
    lock: dict[str, object],
    toolchain: dict[str, str],
    target: str,
) -> None:
    upstream = lock["upstream"]  # type: ignore[index]
    sources = stage / "sources"
    sources.mkdir()
    shutil.copy2(source_archive, sources / source_archive.name)
    shutil.copy2(signature, sources / signature.name)
    shutil.copy2(signing_key, sources / signing_key.name)
    licenses = stage / "licenses" / "ffmpeg"
    licenses.mkdir(parents=True)
    for name in ("LICENSE.md", "COPYING.LGPLv2.1", "COPYING.LGPLv3"):
        shutil.copy2(source / name, licenses / name)
    configure_text = " ".join(str(flag) for flag in lock["configure_policy"])  # type: ignore[index]
    (stage / "build-config.txt").write_text(configure_text + "\n", encoding="utf-8")
    metadata = stage / ".shejane-runtime-asset"
    metadata.mkdir()
    public_toolchain = {key: value for key, value in toolchain.items() if key != "sdk_path"}
    (metadata / "build-provenance.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "target": target,
                "source_sha256": upstream["source_sha256"],
                "configure_policy": lock["configure_policy"],
                "toolchain": public_toolchain,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    sbom = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": f"shejane-ffmpeg-runtime-{target.replace('/', '-')}",
        "documentNamespace": (
            "https://shejane.org/spdx/runtime-assets/ffmpeg/"
            f"{lock['asset_version']}/{target.replace('/', '-')}/{upstream['source_sha256']}"
        ),
        "creationInfo": {
            "created": lock["created_at"],
            "creators": ["Organization: SheJane"],
        },
        "packages": [
            {
                "name": "FFmpeg",
                "SPDXID": "SPDXRef-Package-FFmpeg",
                "versionInfo": upstream["version"],
                "downloadLocation": upstream["source_url"],
                "filesAnalyzed": False,
                "licenseConcluded": upstream["license"],
                "licenseDeclared": upstream["license"],
                "copyrightText": "NOASSERTION",
                "checksums": [{"algorithm": "SHA256", "checksumValue": upstream["source_sha256"]}],
                "comment": f"Built for {target} with {public_toolchain}",
            },
            {
                "name": "zlib system library",
                "SPDXID": "SPDXRef-Package-zlib-system",
                "versionInfo": "NOASSERTION",
                "downloadLocation": "NOASSERTION",
                "filesAnalyzed": False,
                "licenseConcluded": "Zlib",
                "licenseDeclared": "Zlib",
                "copyrightText": "NOASSERTION",
            },
        ],
        "relationships": [
            {
                "spdxElementId": "SPDXRef-DOCUMENT",
                "relationshipType": "DESCRIBES",
                "relatedSpdxElement": "SPDXRef-Package-FFmpeg",
            },
            {
                "spdxElementId": "SPDXRef-Package-FFmpeg",
                "relationshipType": "DEPENDS_ON",
                "relatedSpdxElement": "SPDXRef-Package-zlib-system",
            }
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
        "license": upstream["license"],
        "source_url": upstream["source_url"],
        "payload": "payload",
        "sbom": ".shejane-runtime-asset/sbom.spdx.json",
        "executables": ["payload/bin/ffmpeg", "payload/bin/ffprobe"],
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
                if path.is_symlink():
                    info = zip_info(relative, stat.S_IFLNK | 0o777)
                    archive.writestr(info, os.readlink(path).encode("utf-8"))
                elif path.is_dir():
                    archive.writestr(zip_info(relative + "/", stat.S_IFDIR | 0o700), b"")
                elif path.is_file():
                    mode = 0o500 if path.stat().st_mode & 0o111 else 0o600
                    info = zip_info(relative, stat.S_IFREG | mode)
                    with archive.open(info, "w") as target, path.open("rb") as source_file:
                        shutil.copyfileobj(source_file, target, length=1024 * 1024)
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
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        env=env,
        check=True,
        text=True,
        encoding="utf-8",
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


if __name__ == "__main__":
    main()
