#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import time
import urllib.request
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_download(path: Path, item: dict[str, Any]) -> None:
    if path.is_symlink() or not path.is_file():
        raise SystemExit(f"locked input is not a regular file: {path.name}")
    if path.stat().st_size != int(item["size_bytes"]):
        raise SystemExit(f"locked input size changed: {path.name}")
    if sha256_file(path) != item["sha256"]:
        raise SystemExit(f"locked input SHA-256 changed: {path.name}")


def request_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"User-Agent": "SheJane release builder"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                value = json.load(response)
            if not isinstance(value, dict):
                raise ValueError("metadata is not an object")
            return value
        except (OSError, ValueError):
            if attempt == 3:
                raise
            time.sleep(2**attempt)
    raise AssertionError("unreachable")


def download(url: str, destination: Path, item: dict[str, Any]) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "SheJane release builder"})
    temporary = destination.with_suffix(destination.suffix + ".part")
    try:
        for attempt in range(4):
            try:
                with (
                    urllib.request.urlopen(request, timeout=120) as response,
                    temporary.open("wb") as target,
                ):
                    while chunk := response.read(1024 * 1024):
                        target.write(chunk)
                verify_download(temporary, item)
                temporary.replace(destination)
                return
            except OSError:
                temporary.unlink(missing_ok=True)
                if attempt == 3:
                    raise
                time.sleep(2**attempt)
    finally:
        temporary.unlink(missing_ok=True)


def pypi_project(filename: str) -> str:
    if filename.startswith("antlr4-python3-runtime-"):
        return "antlr4-python3-runtime"
    prefix = filename.split("-", 1)[0].replace("_", "-").casefold()
    return prefix


def pypi_version(filename: str) -> str:
    if filename.startswith("antlr4-python3-runtime-") and filename.endswith(".tar.gz"):
        return filename.removeprefix("antlr4-python3-runtime-").removesuffix(".tar.gz")
    parts = filename.split("-", 2)
    if len(parts) != 3 or not parts[1]:
        raise SystemExit(f"locked PyPI filename is invalid: {filename}")
    return parts[1]


def fetch_packages(lock: dict[str, Any], destination: Path) -> None:
    destination.mkdir(parents=True)
    if any(destination.iterdir()):
        raise SystemExit("package destination must be empty")
    for item in lock["packages"]:
        filename = str(item["filename"])
        project = pypi_project(filename)
        version = pypi_version(filename)
        metadata = request_json(f"https://pypi.org/pypi/{project}/{version}/json")
        candidates = [
            file
            for file in metadata.get("urls", [])
            if file.get("filename") == filename
        ]
        if len(candidates) != 1 or not isinstance(candidates[0].get("url"), str):
            raise SystemExit(f"locked PyPI file is unavailable: {filename}")
        download(str(candidates[0]["url"]), destination / filename, item)


def fetch_models(lock: dict[str, Any], destination: Path) -> None:
    destination.mkdir(parents=True)
    if any(destination.iterdir()):
        raise SystemExit("model destination must be empty")
    for item in lock["models"]:
        url = item.get("source_url")
        if not isinstance(url, str) or not url.startswith("https://"):
            raise SystemExit("locked model source URL is invalid")
        download(url, destination / str(item["filename"]), item)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-lock", type=Path, required=True)
    parser.add_argument("--model-lock", type=Path, required=True)
    parser.add_argument("--wheelhouse", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    args = parser.parse_args()
    package_lock = json.loads(args.package_lock.read_text(encoding="utf-8"))
    model_lock = json.loads(args.model_lock.read_text(encoding="utf-8"))
    fetch_packages(package_lock, args.wheelhouse)
    fetch_models(model_lock, args.model_dir)


if __name__ == "__main__":
    main()
