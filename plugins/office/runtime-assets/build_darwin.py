#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOCK = ROOT / "libreoffice-25.8.7.lock.json"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--libreoffice-dmg", type=Path, required=True)
    parser.add_argument("--mupdf-source", type=Path, required=True)
    parser.add_argument("--noto-cjk", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--codesign-identity", default="-")
    parser.add_argument("--jobs", type=int, default=max(1, os.cpu_count() or 1))
    args = parser.parse_args()
    target = _target_platform()
    if args.output.suffix != ".shejane-runtime-asset":
        parser.error("--output must end in .shejane-runtime-asset")
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    _verify(args.libreoffice_dmg, lock["libreoffice"]["platforms"][target])
    _verify(
        args.mupdf_source,
        {
            "size_bytes": lock["pdf_renderer"]["source_size_bytes"],
            "sha256": lock["pdf_renderer"]["source_sha256"],
        },
    )
    _verify(args.noto_cjk, lock["font_baseline"])

    with tempfile.TemporaryDirectory(prefix="shejane-office-runtime-") as temporary:
        work = Path(temporary)
        stage = work / "asset"
        payload = stage / "payload"
        payload.mkdir(parents=True)
        app = _copy_libreoffice(args.libreoffice_dmg, work, stage, payload)
        _add_noto(args.noto_cjk, app, stage)
        _run(["/usr/bin/codesign", "--force", "--sign", args.codesign_identity, str(app)])
        _run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)])
        mutool = _build_mupdf(args.mupdf_source, work, stage, payload, args.jobs)
        _write_metadata(stage, payload, app, mutool, lock, target)
        _pack_asset(stage, args.output)
    print(args.output.resolve())


def _target_platform() -> str:
    machine = platform.machine().lower()
    if sys.platform != "darwin" or machine not in {"arm64", "x86_64", "amd64"}:
        raise SystemExit("build_darwin.py must run on the target macOS architecture")
    return "darwin/arm64" if machine == "arm64" else "darwin/amd64"


def _verify(path: Path, expected: dict[str, object]) -> None:
    path = path.resolve(strict=True)
    if not path.is_file() or path.stat().st_size != int(expected["size_bytes"]):
        raise SystemExit(f"locked input size mismatch: {path.name}")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected["sha256"]:
        raise SystemExit(f"locked input digest mismatch: {path.name}")


def _copy_libreoffice(dmg: Path, work: Path, stage: Path, payload: Path) -> Path:
    mount = work / "mount"
    mount.mkdir()
    _run(
        [
            "/usr/bin/hdiutil",
            "attach",
            "-readonly",
            "-nobrowse",
            "-mountpoint",
            str(mount),
            str(dmg.resolve()),
        ]
    )
    try:
        app = mount / "LibreOffice.app"
        if not app.is_dir():
            raise SystemExit("LibreOffice DMG does not contain LibreOffice.app")
        destination = payload / "LibreOffice.app"
        _run(["/usr/bin/ditto", str(app), str(destination)])
        licenses = stage / "licenses" / "libreoffice"
        shutil.copytree(mount / "LICENSEs", licenses / "LICENSEs")
        shutil.copytree(mount / "READMEs", licenses / "READMEs")
        return destination
    finally:
        _run(["/usr/bin/hdiutil", "detach", str(mount)])


def _add_noto(archive_path: Path, app: Path, stage: Path) -> None:
    with zipfile.ZipFile(archive_path) as archive:
        if set(archive.namelist()) != {"LICENSE", "NotoSansCJK.ttc"}:
            raise SystemExit("Noto CJK archive layout changed")
        font_root = app / "Contents" / "Resources" / "fonts"
        font_root.mkdir(parents=True, exist_ok=True)
        (font_root / "NotoSansCJK.ttc").write_bytes(archive.read("NotoSansCJK.ttc"))
        license_root = stage / "licenses" / "noto-cjk"
        license_root.mkdir(parents=True)
        (license_root / "OFL.txt").write_bytes(archive.read("LICENSE"))


def _build_mupdf(
    archive_path: Path,
    work: Path,
    stage: Path,
    payload: Path,
    jobs: int,
) -> Path:
    sources = work / "mupdf"
    sources.mkdir()
    with tarfile.open(archive_path, "r:gz") as archive:
        archive.extractall(sources, filter="data")
    roots = [path for path in sources.iterdir() if path.is_dir()]
    if len(roots) != 1:
        raise SystemExit("MuPDF source archive layout changed")
    source = roots[0]
    env = {
        "HOME": str(work / "home"),
        "PATH": "/usr/bin:/bin",
        "CC": "/usr/bin/clang",
        "CXX": "/usr/bin/clang++",
        "PKG_CONFIG": "/usr/bin/false",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }
    (work / "home").mkdir()
    _run(
        [
            "/usr/bin/make",
            "build=release",
            "HAVE_LIBCRYPTO=no",
            "HAVE_X11=no",
            "HAVE_GLUT=no",
            "HAVE_GLFW=no",
            "tools",
            f"-j{max(1, jobs)}",
        ],
        cwd=source,
        env=env,
    )
    built = source / "build" / "release" / "mutool"
    version = _run([str(built), "-v"], capture=True).stdout.strip()
    if version != "mutool version 1.27.2":
        raise SystemExit("built MuPDF version changed")
    dependencies = _run(["/usr/bin/otool", "-L", str(built)], capture=True).stdout.splitlines()[1:]
    if any(not line.strip().startswith(("/usr/lib/", "/System/Library/")) for line in dependencies):
        raise SystemExit("mutool links a non-system dynamic library")
    destination = payload / "bin" / "mutool"
    destination.parent.mkdir()
    shutil.copy2(built, destination)
    license_root = stage / "licenses" / "mupdf"
    license_root.mkdir(parents=True)
    shutil.copy2(source / "COPYING", license_root / "COPYING")
    return destination


def _write_metadata(
    stage: Path,
    payload: Path,
    app: Path,
    mutool: Path,
    lock: dict[str, object],
    target: str,
) -> None:
    (payload / "office-runtime.json").write_text(
        json.dumps(
            {
                "soffice": "LibreOffice.app/Contents/MacOS/soffice",
                "mutool": "bin/mutool",
            },
            sort_keys=True,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    metadata = stage / ".shejane-runtime-asset"
    metadata.mkdir()
    sbom = _sbom(lock, target)
    (metadata / "sbom.spdx.json").write_text(
        json.dumps(sbom, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    executables = sorted(
        path.relative_to(stage).as_posix()
        for path in stage.rglob("*")
        if not path.is_symlink() and path.is_file() and path.stat().st_mode & 0o111
    )
    if app / "Contents" / "MacOS" / "soffice" not in [stage / path for path in executables]:
        raise SystemExit("LibreOffice entrypoint is not executable")
    if mutool.relative_to(stage).as_posix() not in executables:
        raise SystemExit("MuPDF entrypoint is not executable")
    manifest = {
        "schema_version": 1,
        "id": lock["asset_id"],
        "version": lock["asset_version"],
        "platform": target,
        "license": "MPL-2.0 AND AGPL-3.0-only AND OFL-1.1",
        "source_url": lock["libreoffice"]["platforms"][target]["url"],  # type: ignore[index]
        "payload": "payload",
        "sbom": ".shejane-runtime-asset/sbom.spdx.json",
        "executables": executables,
    }
    (metadata / "asset.json").write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )


def _sbom(lock: dict[str, object], target: str) -> dict[str, object]:
    office = lock["libreoffice"]
    renderer = lock["pdf_renderer"]
    font = lock["font_baseline"]
    return {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": f"shejane-office-runtime-{target.replace('/', '-')}",
        "documentNamespace": (
            "https://shejane.org/spdx/runtime-assets/"
            f"{lock['asset_version']}/{target.replace('/', '-')}/"
            f"{office['platforms'][target]['sha256']}"  # type: ignore[index]
        ),
        "creationInfo": {
            "created": "2026-07-16T00:00:00Z",
            "creators": ["Organization: SheJane"],
        },
        "packages": [
            _spdx_package(
                "LibreOffice", office["version"], office["license"], office["platforms"][target]
            ),  # type: ignore[index]
            _spdx_package(
                "MuPDF",
                renderer["version"],
                renderer["license"],
                {"url": renderer["source_url"], "sha256": renderer["source_sha256"]},
            ),  # type: ignore[index]
            _spdx_package("Noto Sans CJK", font["version"], font["license"], font),  # type: ignore[arg-type,index]
        ],
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
    source: dict[str, object],
) -> dict[str, object]:
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


def _pack_asset(source: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(source.rglob("*")):
                relative = path.relative_to(source).as_posix()
                if path.is_symlink():
                    info = _zip_info(relative, stat.S_IFLNK | 0o777)
                    archive.writestr(info, os.readlink(path).encode("utf-8"))
                elif path.is_dir():
                    info = _zip_info(relative + "/", stat.S_IFDIR | 0o700)
                    archive.writestr(info, b"")
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


def _run(
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
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
    )


if __name__ == "__main__":
    main()
