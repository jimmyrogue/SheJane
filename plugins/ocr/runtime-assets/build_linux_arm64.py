#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
BASE_LOCK_PATH = ROOT / "rapidocr-3.9.1.lock.json"
LINUX_LOCK_PATH = ROOT / "rapidocr-3.9.1-linux-arm64.lock.json"
DOCKERFILE = ROOT / "Dockerfile.linux-arm64"
ENGINE_SOURCE = ROOT / "ocr_engine.py"
TARGET = "linux/arm64"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wheelhouse", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.suffix != ".shejane-runtime-asset":
        parser.error("--output must end in .shejane-runtime-asset")
    if args.output.exists() or args.output.is_symlink():
        parser.error("--output must not already exist")

    base_lock = json.loads(BASE_LOCK_PATH.read_text(encoding="utf-8"))
    linux_lock = json.loads(LINUX_LOCK_PATH.read_text(encoding="utf-8"))
    wheelhouse = _verify_set(args.wheelhouse, linux_lock["packages"], "package")
    models = _verify_set(args.model_dir, base_lock["models"], "model")
    image = _build_image(linux_lock)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="shejane-ocr-linux-arm64-", dir=args.output.parent) as temporary:
        work = Path(temporary)
        first = _build_engine(wheelhouse, work / "first", image, linux_lock)
        second = _build_engine(wheelhouse, work / "second", image, linux_lock)
        if _tree_identity(first) != _tree_identity(second):
            raise SystemExit("RapidOCR Linux arm64 engine build is not reproducible")
        stage = work / "asset"
        payload = stage / "payload"
        shutil.copytree(first, payload / "bin")
        model_destination = payload / "models"
        model_destination.mkdir()
        for model in models:
            shutil.copyfile(model, model_destination / model.name)
        _verify_payload(stage, image, base_lock)
        _write_metadata(stage, wheelhouse, base_lock, linux_lock)
        _pack_asset(stage, args.output)
    print(args.output.resolve())


def _verify_set(root: Path, expected: list[dict[str, Any]], kind: str) -> list[Path]:
    root = root.resolve(strict=True)
    if root.is_symlink() or not root.is_dir():
        raise SystemExit(f"locked {kind} directory is invalid")
    expected_names = {str(item["filename"]) for item in expected}
    actual_names = {path.name for path in root.iterdir() if path.is_file()}
    if actual_names != expected_names:
        raise SystemExit(f"{kind} input set does not exactly match the Linux lock")
    result = []
    for item in expected:
        path = root / str(item["filename"])
        if path.is_symlink() or path.stat().st_size != int(item["size_bytes"]):
            raise SystemExit(f"locked {kind} size changed: {path.name}")
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        if digest != item["sha256"]:
            raise SystemExit(f"locked {kind} digest changed: {path.name}")
        result.append(path)
    return result


def _build_image(lock: dict[str, Any]) -> str:
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    for value in (
        lock["python_oci_image"],
        lock["debian_snapshot"],
        f"binutils={lock['binutils_version']}",
    ):
        if value not in dockerfile:
            raise SystemExit("Linux OCR builder lock and Dockerfile differ")
    tag = f"shejane-ocr-builder:{hashlib.sha256(DOCKERFILE.read_bytes()).hexdigest()[:16]}"
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
        raise SystemExit("Linux OCR builder architecture changed")
    return tag


def _build_engine(
    packages: list[Path], output: Path, image: str, lock: dict[str, Any]
) -> Path:
    output.mkdir()
    package_root = packages[0].parent
    epoch = int(lock["source_date_epoch"])
    script = f"""
set -euo pipefail
export HOME=/tmp/home PYTHONHASHSEED=0 SOURCE_DATE_EPOCH={epoch} PIP_NO_INDEX=1
mkdir -p "$HOME" /tmp/antlr /tmp/spec /tmp/work
python -m venv /tmp/venv
/tmp/venv/bin/python -m pip install --disable-pip-version-check --no-cache-dir --no-index --no-deps /wheelhouse/*.whl >/dev/null
tar -xzf /wheelhouse/antlr4-python3-runtime-4.9.3.tar.gz -C /tmp/antlr --strip-components=1
export PYTHONPATH=/tmp/antlr/src
rapidocr_root="$(/tmp/venv/bin/python -c "import pathlib,rapidocr;print(pathlib.Path(rapidocr.__file__).parent)")"
/tmp/venv/bin/python -m PyInstaller --noconfirm --clean --onedir \
  --name ocr-engine \
  --distpath /output \
  --workpath /tmp/work \
  --specpath /tmp/spec \
  --paths /tmp/antlr/src \
  --hidden-import antlr4 \
  --collect-submodules antlr4 \
  --hidden-import rapidocr.inference_engine.onnxruntime \
  --collect-data certifi \
  --add-data "$rapidocr_root/config.yaml:rapidocr" \
  --add-data "$rapidocr_root/default_models.yaml:rapidocr" \
  --exclude-module torch \
  --exclude-module paddle \
  --exclude-module openvino \
  --exclude-module tensorrt \
  --exclude-module MNN \
  /src/ocr_engine.py >/dev/null
find /output/ocr-engine -path '*.dist-info/RECORD' -delete
find /output/ocr-engine -type f -exec touch -d '@{epoch}' {{}} +
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
            "--user",
            f"{os.getuid()}:{os.getgid()}",
            "--volume",
            f"{package_root}:/wheelhouse:ro",
            "--volume",
            f"{ENGINE_SOURCE}:/src/ocr_engine.py:ro",
            "--volume",
            f"{output.resolve()}:/output",
            image,
            "bash",
            "-ceu",
            script,
        ],
        timeout=1800,
    )
    built = output / "ocr-engine"
    if not (built / "ocr-engine").is_file() or not (built / "_internal").is_dir():
        raise SystemExit("PyInstaller did not produce the expected OCR onedir engine")
    forbidden = ("libtesseract", "libleptonica")
    if any(marker in path.name.casefold() for path in built.rglob("*") for marker in forbidden):
        raise SystemExit("OCR engine contains a forbidden optional component")
    return built


def _verify_payload(stage: Path, image: str, base_lock: dict[str, Any]) -> None:
    executable = stage / "payload" / "bin" / "ocr-engine"
    with executable.open("rb") as source:
        header = source.read(20)
    if (
        len(header) != 20
        or header[:4] != b"\x7fELF"
        or header[4:6] != b"\x02\x01"
        or int.from_bytes(header[18:20], "little") != 183
    ):
        raise SystemExit("OCR engine is not a Linux arm64 ELF executable")
    probe = _run(
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
            """
set +e
/asset/payload/bin/ocr-engine >/tmp/stdout 2>/tmp/stderr
status=$?
set -e
test "$status" -eq 2
test ! -s /tmp/stdout
test ! -s /tmp/stderr
""",
        ],
        capture=True,
    )
    if probe.stdout:
        raise SystemExit("OCR engine startup probe emitted unexpected output")
    expected_models = {str(item["filename"]) for item in base_lock["models"]}
    actual_models = {path.name for path in (stage / "payload" / "models").iterdir()}
    if actual_models != expected_models:
        raise SystemExit("OCR model payload changed")


def _write_metadata(
    stage: Path,
    packages: list[Path],
    base_lock: dict[str, Any],
    linux_lock: dict[str, Any],
) -> None:
    metadata = stage / ".shejane-runtime-asset"
    metadata.mkdir()
    shutil.copyfile(BASE_LOCK_PATH, metadata / BASE_LOCK_PATH.name)
    shutil.copyfile(LINUX_LOCK_PATH, metadata / LINUX_LOCK_PATH.name)
    sources = stage / "sources"
    sources.mkdir()
    shutil.copyfile(ENGINE_SOURCE, sources / ENGINE_SOURCE.name)
    antlr = next(path for path in packages if path.name.endswith(".tar.gz"))
    shutil.copyfile(antlr, sources / antlr.name)
    licenses = stage / "licenses"
    for archive_path in packages:
        if archive_path.suffix != ".whl":
            continue
        with zipfile.ZipFile(archive_path) as archive:
            for name in archive.namelist():
                if ".dist-info/licenses/" not in name or name.endswith("/"):
                    continue
                destination = licenses / archive_path.stem / Path(name).name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(archive.read(name))
    manifest = {
        "schema_version": 1,
        "id": base_lock["asset_id"],
        "version": base_lock["asset_version"],
        "platform": TARGET,
        "license": "Apache-2.0",
        "source_url": "https://github.com/RapidAI/RapidOCR",
        "payload": "payload",
        "sbom": ".shejane-runtime-asset/sbom.spdx.json",
        "executables": ["payload/bin/ocr-engine"],
    }
    (metadata / "asset.json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")), encoding="utf-8"
    )
    provenance = {
        "schema_version": 1,
        "target": TARGET,
        "base_lock_sha256": hashlib.sha256(BASE_LOCK_PATH.read_bytes()).hexdigest(),
        "platform_lock_sha256": hashlib.sha256(LINUX_LOCK_PATH.read_bytes()).hexdigest(),
        "builder_script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "builder_dockerfile_sha256": hashlib.sha256(DOCKERFILE.read_bytes()).hexdigest(),
        "base_oci_image": linux_lock["python_oci_image"],
        "network_during_build": "disabled",
        "provider": "CPUExecutionProvider",
        "thread_policy": {"intra_op": 1, "inter_op": 1},
    }
    (metadata / "build-provenance.json").write_text(
        json.dumps(provenance, sort_keys=True, separators=(",", ":")), encoding="utf-8"
    )
    sbom_packages = [
        {
            "name": Path(item["filename"]).name,
            "SPDXID": f"SPDXRef-Package-{index}",
            "versionInfo": "locked",
            "downloadLocation": "https://pypi.org/",
            "filesAnalyzed": False,
            "licenseConcluded": "NOASSERTION",
            "licenseDeclared": "NOASSERTION",
            "copyrightText": "NOASSERTION",
        }
        for index, item in enumerate(linux_lock["packages"], start=1)
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
        "name": "shejane-rapidocr-runtime-linux-arm64",
        "documentNamespace": (
            "https://shejane.org/spdx/runtime-assets/rapidocr/"
            f"{base_lock['asset_version']}/linux-arm64/{hashlib.sha256(LINUX_LOCK_PATH.read_bytes()).hexdigest()}"
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
    command: list[str], *, capture: bool = False, timeout: int = 120
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
