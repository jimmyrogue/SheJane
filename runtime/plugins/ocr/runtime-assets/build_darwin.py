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
LOCK_PATH = ROOT / "rapidocr-3.9.1.lock.json"


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
    if resolved.stat().st_size != expected["size_bytes"]:
        raise SystemExit(f"locked {kind} size changed: {path.name}")
    if sha256_file(resolved) != expected["sha256"]:
        raise SystemExit(f"locked {kind} SHA-256 changed: {path.name}")
    return resolved


def verify_inputs(
    wheelhouse: Path, model_dir: Path, lock: dict[str, Any]
) -> tuple[list[Path], list[Path]]:
    wheelhouse = wheelhouse.resolve(strict=True)
    model_dir = model_dir.resolve(strict=True)
    package_names = {item["filename"] for item in lock["packages"]}
    actual_package_names = {path.name for path in wheelhouse.iterdir() if path.is_file()}
    if actual_package_names != package_names:
        raise SystemExit("package input set does not exactly match the RapidOCR lock")
    model_names = {item["filename"] for item in lock["models"]}
    actual_model_names = {path.name for path in model_dir.iterdir() if path.is_file()}
    if actual_model_names != model_names:
        raise SystemExit("model input set does not exactly match the RapidOCR lock")
    packages = [
        verify_file(wheelhouse / item["filename"], item, "package")
        for item in lock["packages"]
    ]
    models = [
        verify_file(model_dir / item["filename"], item, "model") for item in lock["models"]
    ]
    return packages, models


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


def safe_extract_antlr(archive_path: Path, destination: Path) -> Path:
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


def offline_environment(home: Path) -> dict[str, str]:
    home.mkdir()
    return {
        "HOME": str(home),
        "PATH": "/usr/bin:/bin",
        "LANG": "C",
        "LC_ALL": "C",
        "TZ": "UTC",
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


def build_engine(
    work: Path,
    packages: list[Path],
    engine_source: Path,
    env: dict[str, str],
    uv: Path,
) -> Path:
    environment = work / "venv"
    run(
        [
            str(uv),
            "--offline",
            "venv",
            "--python",
            sys.executable,
            str(environment),
        ],
        env=env,
    )
    python = environment / "bin" / "python"
    wheels = [path for path in packages if path.suffix == ".whl"]
    run(
        [
            str(uv),
            "--offline",
            "pip",
            "install",
            "--python",
            str(python),
            "--no-index",
            "--no-deps",
            *[str(path) for path in wheels],
        ],
        env=env,
    )
    antlr_archive = next(path for path in packages if path.name.endswith(".tar.gz"))
    antlr_source = safe_extract_antlr(antlr_archive, work / "antlr")
    rapidocr_root = Path(
        run(
            [
                str(python),
                "-c",
                "import pathlib,sysconfig;print(pathlib.Path(sysconfig.get_paths()['purelib'])/'rapidocr')",
            ],
            env=env,
            capture=True,
        ).stdout.strip()
    )
    command = [
        str(python),
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--name",
        "ocr-engine",
        "--target-arch",
        "arm64",
        "--distpath",
        str(work / "dist"),
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
        "--collect-data",
        "certifi",
        "--add-data",
        f"{rapidocr_root / 'config.yaml'}:rapidocr",
        "--add-data",
        f"{rapidocr_root / 'default_models.yaml'}:rapidocr",
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
        str(engine_source),
    ]
    run(command, env=env)
    built = work / "dist" / "ocr-engine"
    if not (built / "ocr-engine").is_file() or not (built / "_internal").is_dir():
        raise SystemExit("PyInstaller did not produce the expected onedir engine")
    # uv-generated console scripts contain the random temporary venv path. PyInstaller
    # does not bundle those scripts, but two wheel RECORD files retain their hashes.
    # RECORD is not used at runtime, so remove it from every collected distribution.
    for record in built.rglob("*.dist-info/RECORD"):
        record.unlink()
    return built


def is_macho(path: Path) -> bool:
    if not path.is_file() or path.is_symlink():
        return False
    output = run(["/usr/bin/file", "-b", str(path)], capture=True).stdout
    return "Mach-O" in output


def codesign_target(path: Path, root: Path) -> Path:
    for parent in path.parents:
        if parent == root:
            break
        if parent.suffix != ".framework" or path.name != parent.stem:
            continue
        relative = path.relative_to(parent)
        if path.parent == parent:
            return parent
        if len(relative.parts) == 3 and relative.parts[0] == "Versions":
            return parent / "Versions" / relative.parts[1]
    return path


def sign_and_verify_tree(root: Path, identity: str, lock: dict[str, Any]) -> None:
    machos = [path for path in root.rglob("*") if is_macho(path)]
    if not machos:
        raise SystemExit("OCR engine contains no Mach-O executable")
    forbidden = tuple(lock["dependency_policy"]["forbidden_binary_markers"])
    for path in root.rglob("*"):
        if any(marker in path.name.casefold() for marker in forbidden):
            raise SystemExit(f"OCR engine includes a forbidden optional component: {path.name}")
    targets = {codesign_target(path, root) for path in machos}
    for path in sorted(targets, key=lambda value: len(value.parts), reverse=True):
        run(["/usr/bin/codesign", "--force", "--sign", identity, str(path)])
        run(["/usr/bin/codesign", "--verify", "--strict", str(path)])
    executable = root / "ocr-engine"
    executable.chmod(0o500)
    for path in machos:
        dependencies = run(["/usr/bin/otool", "-L", str(path)], capture=True).stdout
        for line in dependencies.splitlines()[1:]:
            dependency = line.strip().split(" ", 1)[0]
            if dependency.startswith(("@", "/usr/lib/", "/System/Library/")):
                continue
            raise SystemExit(f"OCR engine links an undeclared library: {dependency}")


def package_metadata(python: Path, env: dict[str, str]) -> list[dict[str, str]]:
    code = (
        "import importlib.metadata as m,json;"
        "print(json.dumps(sorted([{'name':d.metadata.get('Name') or '',"
        "'version':d.version,'license':d.metadata.get('License-Expression') or "
        "d.metadata.get('License') or 'NOASSERTION'} for d in m.distributions()],"
        "key=lambda x:x['name'].lower())))"
    )
    return json.loads(run([str(python), "-c", code], env=env, capture=True).stdout)


def copy_wheel_licenses(packages: list[Path], destination: Path) -> None:
    destination.mkdir()
    for archive_path in packages:
        if archive_path.suffix != ".whl":
            continue
        with zipfile.ZipFile(archive_path) as archive:
            names = [
                name
                for name in archive.namelist()
                if ".dist-info/licenses/" in name and not name.endswith("/")
            ]
            for name in names:
                target = destination / archive_path.stem / Path(name).name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(name))


def write_metadata(
    stage: Path,
    lock: dict[str, Any],
    packages: list[Path],
    engine_source: Path,
    python: Path,
    env: dict[str, str],
) -> None:
    metadata = stage / ".shejane-runtime-asset"
    metadata.mkdir()
    shutil.copy2(LOCK_PATH, metadata / LOCK_PATH.name)
    sources = stage / "sources"
    sources.mkdir()
    shutil.copy2(engine_source, sources / engine_source.name)
    antlr = next(path for path in packages if path.name.endswith(".tar.gz"))
    shutil.copy2(antlr, sources / antlr.name)
    copy_wheel_licenses(packages, stage / "licenses")

    installed = package_metadata(python, env)
    spdx_packages = []
    for index, package in enumerate(installed, start=1):
        license_text = " ".join(str(package["license"]).split())[:500]
        spdx_packages.append(
            {
                "name": package["name"],
                "SPDXID": f"SPDXRef-Package-{index}",
                "versionInfo": package["version"],
                "downloadLocation": "https://pypi.org/",
                "filesAnalyzed": False,
                "licenseConcluded": "NOASSERTION",
                "licenseDeclared": license_text or "NOASSERTION",
                "copyrightText": "NOASSERTION",
            }
        )
    for model_index, model in enumerate(lock["models"], start=len(spdx_packages) + 1):
        spdx_packages.append(
            {
                "name": model["filename"],
                "SPDXID": f"SPDXRef-Package-{model_index}",
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
        "name": "shejane-rapidocr-runtime-darwin-arm64",
        "documentNamespace": (
            "https://shejane.org/spdx/runtime-assets/rapidocr/"
            f"{lock['asset_version']}/darwin-arm64/{sha256_file(LOCK_PATH)}"
        ),
        "creationInfo": {
            "created": lock["created_at"],
            "creators": ["Organization: SheJane"],
        },
        "packages": spdx_packages,
        "relationships": [
            {
                "spdxElementId": "SPDXRef-DOCUMENT",
                "relationshipType": "DESCRIBES",
                "relatedSpdxElement": package["SPDXID"],
            }
            for package in spdx_packages
        ],
    }
    (metadata / "sbom.spdx.json").write_text(
        json.dumps(sbom, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    provenance = {
        "schema_version": 1,
        "target": lock["platform"],
        "lock_sha256": sha256_file(LOCK_PATH),
        "engine_source_sha256": sha256_file(engine_source),
        "python": run([str(python), "--version"], env=env, capture=True).stdout.strip(),
        "pyinstaller": "6.21.0",
        "execution_provider": "CPUExecutionProvider",
        "network_during_freeze": "disabled_by_build_environment",
    }
    (metadata / "build-provenance.json").write_text(
        json.dumps(provenance, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    manifest = {
        "schema_version": 1,
        "id": lock["asset_id"],
        "version": lock["asset_version"],
        "platform": lock["platform"],
        "license": "Apache-2.0",
        "source_url": "https://github.com/RapidAI/RapidOCR",
        "payload": "payload",
        "sbom": ".shejane-runtime-asset/sbom.spdx.json",
        "executables": ["payload/bin/ocr-engine"],
    }
    (metadata / "asset.json").write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
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
                if path.is_symlink():
                    archive.writestr(
                        zip_info(relative, stat.S_IFLNK | 0o777),
                        os.readlink(path),
                    )
                elif path.is_dir():
                    archive.writestr(zip_info(relative + "/", stat.S_IFDIR | 0o700), b"")
                elif path.is_file():
                    mode = 0o500 if path.stat().st_mode & 0o111 else 0o600
                    with archive.open(zip_info(relative, stat.S_IFREG | mode), "w") as target:
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
    parser.add_argument("--codesign-identity", default="-")
    args = parser.parse_args()
    if sys.platform != "darwin" or platform.machine().lower() != "arm64":
        parser.error("this reference builder requires macOS arm64")
    if sys.version_info[:2] != (3, 12):
        parser.error("this reference builder requires CPython 3.12")
    if args.output.suffix != ".shejane-runtime-asset":
        parser.error("--output must end in .shejane-runtime-asset")
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    uv_path_text = shutil.which("uv")
    if uv_path_text is None:
        parser.error("the locked uv build tool is unavailable")
    uv_path = Path(uv_path_text).resolve(strict=True)
    uv_version = run([str(uv_path), "--version"], capture=True).stdout.split()[1]
    if uv_version != lock["build_tools"]["uv"]:
        parser.error(f"uv version must be {lock['build_tools']['uv']}")
    python_version = ".".join(str(value) for value in sys.version_info[:3])
    if python_version != lock["build_tools"]["python"]:
        parser.error(f"Python version must be {lock['build_tools']['python']}")
    packages, models = verify_inputs(args.wheelhouse, args.model_dir, lock)
    with tempfile.TemporaryDirectory(prefix="shejane-rapidocr-runtime-") as temporary:
        work = Path(temporary)
        env = offline_environment(work / "home")
        built = build_engine(work, packages, ROOT / "ocr_engine.py", env, uv_path)
        stage = work / "asset"
        payload = stage / "payload"
        shutil.copytree(built, payload / "bin", symlinks=True)
        model_destination = payload / "models"
        model_destination.mkdir()
        for model in models:
            shutil.copy2(model, model_destination / model.name)
        sign_and_verify_tree(payload / "bin", args.codesign_identity, lock)
        python = work / "venv" / "bin" / "python"
        write_metadata(stage, lock, packages, ROOT / "ocr_engine.py", python, env)
        pack_asset(stage, args.output)
    print(args.output.resolve())


if __name__ == "__main__":
    main()
