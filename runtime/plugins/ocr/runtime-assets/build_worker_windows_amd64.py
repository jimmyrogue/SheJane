#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

from build_windows_amd64 import (
    offline_environment,
    run,
    sha256_file,
    verify_amd64_pe,
)

ROOT = Path(__file__).resolve().parent
LOCK_PATH = ROOT / "rapidocr-3.9.1-windows-amd64.lock.json"
WORKER_SOURCE = ROOT.parent / "worker" / "ocr_worker.py"
REQUIRED_PACKAGES = {
    "altgraph-0.17.5-py2.py3-none-any.whl",
    "packaging-26.2-py3-none-any.whl",
    "pefile-2024.8.26-py3-none-any.whl",
    "pyinstaller-6.21.0-py3-none-win_amd64.whl",
    "pyinstaller_hooks_contrib-2026.6-py3-none-any.whl",
    "pywin32_ctypes-0.2.3-py3-none-any.whl",
    "setuptools-83.0.0-py3-none-any.whl",
}


def verify_packages(
    wheelhouse: Path, lock: dict[str, Any]
) -> list[Path]:
    try:
        wheelhouse = wheelhouse.resolve(strict=True)
    except OSError as exc:
        raise SystemExit("locked package directory is unavailable") from exc
    locked = {str(item["filename"]): item for item in lock["packages"]}
    if not REQUIRED_PACKAGES <= locked.keys():
        raise SystemExit("Windows OCR Worker build dependencies changed")
    packages = []
    for filename in sorted(REQUIRED_PACKAGES):
        path = wheelhouse / filename
        item = locked[filename]
        if path.is_symlink() or not path.is_file():
            raise SystemExit(f"locked package is unavailable: {filename}")
        if path.stat().st_size != int(item["size_bytes"]):
            raise SystemExit(f"locked package size changed: {filename}")
        if sha256_file(path) != item["sha256"]:
            raise SystemExit(f"locked package SHA-256 changed: {filename}")
        packages.append(path)
    return packages


def tree_identity(root: Path) -> list[tuple[str, str]]:
    return [
        (path.relative_to(root).as_posix(), sha256_file(path))
        for path in sorted(root.rglob("*"))
        if path.is_file()
    ]


def build_once(
    work: Path,
    packages: list[Path],
    epoch: int,
) -> Path:
    work.mkdir()
    env = offline_environment(work / "home", work / "tmp")
    environment = work / "venv"
    run([sys.executable, "-m", "venv", str(environment)], env=env)
    python = environment / "Scripts" / "python.exe"
    run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--no-index",
            "--no-deps",
            *[str(path) for path in packages],
        ],
        env=env,
    )
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
            "ocr-worker",
            "--distpath",
            str(dist),
            "--workpath",
            str(work / "pyinstaller-work"),
            "--specpath",
            str(work / "spec"),
            str(WORKER_SOURCE),
        ],
        env=env,
    )
    built = dist / "ocr-worker"
    executable = built / "ocr-worker.exe"
    if not executable.is_file() or not (built / "_internal").is_dir():
        raise SystemExit("PyInstaller did not produce the expected OCR Worker")
    for path in sorted(built.rglob("*"), reverse=True):
        if path.is_file():
            os.utime(path, (epoch, epoch))
    verify_amd64_pe(executable)
    return built


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wheelhouse", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "win32" or platform.machine().lower() not in {"amd64", "x86_64"}:
        parser.error("this builder requires Windows AMD64")
    if sys.version_info[:3] != (3, 12, 10):
        parser.error("this builder requires CPython 3.12.10")
    if args.output.exists() or args.output.is_symlink():
        parser.error("--output must not already exist")
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    if lock["platform"] != "windows/amd64":
        parser.error("Windows OCR Worker lock target changed")
    packages = verify_packages(args.wheelhouse, lock)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="shejane-ocr-worker-windows-amd64-",
        dir=args.output.parent,
    ) as temporary:
        work = Path(temporary)
        first = build_once(work / "first", packages, int(lock["source_date_epoch"]))
        second = build_once(work / "second", packages, int(lock["source_date_epoch"]))
        if tree_identity(first) != tree_identity(second):
            raise SystemExit("Windows OCR Worker build is not reproducible")
        shutil.copytree(first, args.output)
    print(args.output.resolve())


if __name__ == "__main__":
    main()
