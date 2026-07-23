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
from typing import Any

ROOT = Path(__file__).resolve().parent
BASE_LOCK_PATH = ROOT / "rapidocr-3.9.1.lock.json"
WINDOWS_LOCK_PATH = ROOT / "rapidocr-3.9.1-windows-amd64.lock.json"
ENGINE_SOURCE = ROOT / "ocr_engine.py"
TARGET = "windows/amd64"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_amd64_pe(executable: Path) -> None:
    try:
        with executable.open("rb") as source:
            if source.read(2) != b"MZ":
                raise ValueError
            source.seek(0x3C)
            pe_offset = int.from_bytes(source.read(4), "little")
            if pe_offset < 64 or pe_offset > executable.stat().st_size - 6:
                raise ValueError
            source.seek(pe_offset)
            if source.read(4) != b"PE\0\0":
                raise ValueError
            if int.from_bytes(source.read(2), "little") != 0x8664:
                raise ValueError
    except (OSError, ValueError) as exc:
        raise SystemExit("OCR engine is not a Windows AMD64 PE executable") from exc


def verify_set(
    root: Path, expected: list[dict[str, Any]], kind: str
) -> list[Path]:
    try:
        root = root.resolve(strict=True)
    except OSError as exc:
        raise SystemExit(f"locked {kind} directory is unavailable") from exc
    if root.is_symlink() or not root.is_dir():
        raise SystemExit(f"locked {kind} directory is invalid")
    expected_names = {str(item["filename"]) for item in expected}
    actual_names = {path.name for path in root.iterdir() if path.is_file()}
    if actual_names != expected_names:
        raise SystemExit(f"{kind} input set does not exactly match the Windows lock")
    result = []
    for item in expected:
        path = root / str(item["filename"])
        if path.is_symlink() or not path.is_file():
            raise SystemExit(f"locked {kind} is not a regular file: {path.name}")
        if path.stat().st_size != int(item["size_bytes"]):
            raise SystemExit(f"locked {kind} size changed: {path.name}")
        if sha256_file(path) != item["sha256"]:
            raise SystemExit(f"locked {kind} SHA-256 changed: {path.name}")
        result.append(path)
    return result


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
        stderr=subprocess.STDOUT if capture else None,
    )


def extract_antlr(archive_path: Path, destination: Path) -> Path:
    destination.mkdir()
    with tarfile.open(archive_path, "r:gz") as archive:
        archive.extractall(destination, filter="data")
    roots = [path for path in destination.iterdir() if path.is_dir()]
    if len(roots) != 1 or roots[0].name != "antlr4-python3-runtime-4.9.3":
        raise SystemExit("ANTLR source archive layout changed")
    source = roots[0] / "src"
    if not (source / "antlr4" / "__init__.py").is_file():
        raise SystemExit("ANTLR source package is unavailable")
    return source


def offline_environment(home: Path, temporary: Path) -> dict[str, str]:
    home.mkdir()
    temporary.mkdir()
    environment = os.environ.copy()
    environment.update(
        {
            "HOME": str(home),
            "USERPROFILE": str(home),
            "TEMP": str(temporary),
            "TMP": str(temporary),
            "PYTHONHASHSEED": "0",
            "SOURCE_DATE_EPOCH": "1784160000",
            "PIP_NO_INDEX": "1",
            "PIP_DISABLE_PIP_VERSION_CHECK": "1",
            "PIP_NO_CACHE_DIR": "1",
            "http_proxy": "",
            "https_proxy": "",
            "HTTP_PROXY": "",
            "HTTPS_PROXY": "",
            "NO_PROXY": "*",
        }
    )
    return environment


def build_engine(
    work: Path,
    packages: list[Path],
    env: dict[str, str],
    epoch: int,
) -> tuple[Path, Path]:
    environment = work / "venv"
    run([sys.executable, "-m", "venv", str(environment)], env=env)
    python = environment / "Scripts" / "python.exe"
    wheels = [path for path in packages if path.suffix == ".whl"]
    run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--no-index",
            "--no-deps",
            *[str(path) for path in wheels],
        ],
        env=env,
    )
    antlr_archive = next(path for path in packages if path.name.endswith(".tar.gz"))
    antlr_source = extract_antlr(antlr_archive, work / "antlr")
    build_env = {
        **env,
        "PYTHONPATH": str(antlr_source),
    }
    rapidocr_root = Path(
        run(
            [
                str(python),
                "-c",
                "import pathlib,rapidocr;print(pathlib.Path(rapidocr.__file__).parent)",
            ],
            env=build_env,
            capture=True,
        ).stdout.strip()
    ).resolve(strict=True)
    dist = work / "dist"
    run(
        [
            str(python),
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--onedir",
            "--name",
            "ocr-engine",
            "--distpath",
            str(dist),
            "--workpath",
            str(work / "pyinstaller-work"),
            "--specpath",
            str(work / "spec"),
            "--paths",
            str(antlr_source),
            "--hidden-import",
            "antlr4",
            "--collect-submodules",
            "antlr4",
            "--hidden-import",
            "rapidocr.inference_engine.onnxruntime",
            "--collect-all",
            "onnxruntime",
            "--collect-data",
            "certifi",
            "--add-data",
            f"{rapidocr_root / 'config.yaml'}{os.pathsep}rapidocr",
            "--add-data",
            f"{rapidocr_root / 'default_models.yaml'}{os.pathsep}rapidocr",
            "--exclude-module",
            "torch",
            "--exclude-module",
            "paddle",
            "--exclude-module",
            "openvino",
            "--exclude-module",
            "tensorrt",
            "--exclude-module",
            "MNN",
            str(ENGINE_SOURCE),
        ],
        env=build_env,
    )
    built = dist / "ocr-engine"
    executable = built / "ocr-engine.exe"
    if not executable.is_file() or not (built / "_internal").is_dir():
        raise SystemExit("PyInstaller did not produce the expected OCR onedir engine")
    for record in built.rglob("RECORD"):
        if ".dist-info" in record.as_posix():
            record.unlink()
    for path in sorted(built.rglob("*"), reverse=True):
        if path.is_file():
            os.utime(path, (epoch, epoch))
    forbidden = ("libtesseract", "libleptonica")
    if any(marker in path.name.casefold() for path in built.rglob("*") for marker in forbidden):
        raise SystemExit("OCR engine contains a forbidden optional component")
    verify_amd64_pe(executable)
    return built, python


def verify_payload(stage: Path, base_lock: dict[str, Any]) -> None:
    executable = stage / "payload" / "bin" / "ocr-engine.exe"
    verify_amd64_pe(executable)
    probe_environment = {
        "PATH": os.defpath,
        "PYTHONUTF8": "1",
    }
    for name in ("SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"):
        if value := os.environ.get(name):
            probe_environment[name] = value
    probe = subprocess.run(
        [str(executable)],
        check=False,
        text=True,
        encoding="utf-8",
        capture_output=True,
        env=probe_environment,
    )
    if probe.returncode != 2 or probe.stdout or probe.stderr:
        raise SystemExit("OCR engine startup probe changed")
    expected_models = {str(item["filename"]) for item in base_lock["models"]}
    actual_models = {path.name for path in (stage / "payload" / "models").iterdir()}
    if actual_models != expected_models:
        raise SystemExit("OCR model payload changed")


def copy_licenses(packages: list[Path], destination: Path) -> None:
    for archive_path in packages:
        if archive_path.suffix != ".whl":
            continue
        with zipfile.ZipFile(archive_path) as archive:
            for name in archive.namelist():
                normalized = name.casefold()
                if ".dist-info/licenses/" not in normalized or name.endswith("/"):
                    continue
                target = destination / archive_path.stem / Path(name).name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(name))


def write_metadata(
    stage: Path,
    windows_lock: dict[str, Any],
    base_lock: dict[str, Any],
    packages: list[Path],
) -> None:
    metadata = stage / ".shejane-runtime-asset"
    metadata.mkdir()
    shutil.copyfile(BASE_LOCK_PATH, metadata / BASE_LOCK_PATH.name)
    shutil.copyfile(WINDOWS_LOCK_PATH, metadata / WINDOWS_LOCK_PATH.name)
    sources = stage / "sources"
    sources.mkdir()
    shutil.copyfile(ENGINE_SOURCE, sources / ENGINE_SOURCE.name)
    antlr = next(path for path in packages if path.name.endswith(".tar.gz"))
    shutil.copyfile(antlr, sources / antlr.name)
    copy_licenses(packages, stage / "licenses")
    manifest = {
        "schema_version": 1,
        "id": windows_lock["asset_id"],
        "version": windows_lock["asset_version"],
        "platform": TARGET,
        "license": "Apache-2.0",
        "source_url": "https://github.com/RapidAI/RapidOCR",
        "payload": "payload",
        "sbom": ".shejane-runtime-asset/sbom.spdx.json",
        "executables": ["payload/bin/ocr-engine.exe"],
    }
    (metadata / "asset.json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    provenance = {
        "schema_version": 1,
        "target": TARGET,
        "base_lock_sha256": sha256_file(BASE_LOCK_PATH),
        "platform_lock_sha256": sha256_file(WINDOWS_LOCK_PATH),
        "builder_script_sha256": sha256_file(Path(__file__)),
        "engine_source_sha256": sha256_file(ENGINE_SOURCE),
        "python": windows_lock["build_tools"]["python"],
        "pyinstaller": windows_lock["build_tools"]["pyinstaller"],
        "execution_provider": "CPUExecutionProvider",
        "package_install": "offline_no_index",
    }
    (metadata / "build-provenance.json").write_text(
        json.dumps(provenance, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    sbom_packages = [
        {
            "name": item["filename"],
            "SPDXID": f"SPDXRef-Package-{index}",
            "versionInfo": "locked",
            "downloadLocation": "https://pypi.org/",
            "filesAnalyzed": False,
            "licenseConcluded": "NOASSERTION",
            "licenseDeclared": "NOASSERTION",
            "copyrightText": "NOASSERTION",
        }
        for index, item in enumerate(windows_lock["packages"], start=1)
    ]
    for index, model in enumerate(base_lock["models"], start=len(sbom_packages) + 1):
        sbom_packages.append(
            {
                "name": model["filename"],
                "SPDXID": f"SPDXRef-Package-{index}",
                "versionInfo": "RapidOCR-3.9.1",
                "downloadLocation": model["source_url"],
                "filesAnalyzed": False,
                "licenseConcluded": "Apache-2.0",
                "licenseDeclared": "Apache-2.0",
                "copyrightText": "NOASSERTION",
            }
        )
    sbom = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": "shejane-rapidocr-runtime-windows-amd64",
        "documentNamespace": (
            "https://shejane.org/spdx/runtime-assets/rapidocr/"
            f"{windows_lock['asset_version']}/windows-amd64/{sha256_file(WINDOWS_LOCK_PATH)}"
        ),
        "creationInfo": {
            "created": base_lock["created_at"],
            "creators": ["Organization: SheJane"],
        },
        "packages": sbom_packages,
        "relationships": [
            {
                "spdxElementId": "SPDXRef-DOCUMENT",
                "relationshipType": "DESCRIBES",
                "relatedSpdxElement": package["SPDXID"],
            }
            for package in sbom_packages
        ],
    }
    (metadata / "sbom.spdx.json").write_text(
        json.dumps(sbom, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )


def zip_info(name: str, mode: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = mode << 16
    return info


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
                    mode = 0o500 if path.name == "ocr-engine.exe" else 0o600
                    with archive.open(
                        zip_info(relative, stat.S_IFREG | mode), "w"
                    ) as target:
                        with path.open("rb") as source_file:
                            shutil.copyfileobj(source_file, target, length=1024 * 1024)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wheelhouse", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "win32" or platform.machine().lower() not in {"amd64", "x86_64"}:
        parser.error("this builder requires Windows AMD64")
    if sys.version_info[:3] != (3, 12, 10):
        parser.error("this builder requires CPython 3.12.10")
    if args.output.suffix != ".shejane-runtime-asset":
        parser.error("--output must end in .shejane-runtime-asset")
    if args.output.exists() or args.output.is_symlink():
        parser.error("--output must not already exist")
    windows_lock = json.loads(WINDOWS_LOCK_PATH.read_text(encoding="utf-8"))
    base_lock = json.loads(BASE_LOCK_PATH.read_text(encoding="utf-8"))
    if (
        windows_lock["platform"] != TARGET
        or windows_lock["asset_id"] != base_lock["asset_id"]
        or windows_lock["asset_version"] != base_lock["asset_version"]
    ):
        parser.error("Windows and base RapidOCR locks disagree")
    packages = verify_set(args.wheelhouse, windows_lock["packages"], "package")
    models = verify_set(args.model_dir, base_lock["models"], "model")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="shejane-ocr-windows-amd64-", dir=args.output.parent
    ) as temporary:
        work = Path(temporary)
        env = offline_environment(work / "home", work / "tmp")
        built, _python = build_engine(
            work,
            packages,
            env,
            int(windows_lock["source_date_epoch"]),
        )
        stage = work / "asset"
        payload = stage / "payload"
        shutil.copytree(built, payload / "bin")
        model_destination = payload / "models"
        model_destination.mkdir()
        for model in models:
            shutil.copyfile(model, model_destination / model.name)
        verify_payload(stage, base_lock)
        write_metadata(stage, windows_lock, base_lock, packages)
        pack_asset(stage, args.output)
    print(args.output.resolve())


if __name__ == "__main__":
    main()
