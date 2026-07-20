#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PLATFORMS = (
    "linux/arm64",
    "linux/amd64",
    "windows/arm64",
    "windows/amd64",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=("local", "cloud"), required=True)
    parser.add_argument("--platform", choices=PLATFORMS, required=True)
    parser.add_argument("--version", default="0.1.0")
    parser.add_argument("--worker", type=Path, required=True)
    parser.add_argument("--runtime-asset-version")
    parser.add_argument("--runtime-asset-digest")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(
        r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?",
        args.version,
    ):
        parser.error("--version must be semantic version text")
    if args.backend == "local":
        if not args.runtime_asset_version or not re.fullmatch(
            r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?",
            args.runtime_asset_version,
        ):
            parser.error("local backend requires semantic --runtime-asset-version")
        if not args.runtime_asset_digest or not re.fullmatch(
            r"sha256:[0-9a-f]{64}", args.runtime_asset_digest
        ):
            parser.error("local backend requires canonical --runtime-asset-digest")
    elif args.runtime_asset_version or args.runtime_asset_digest:
        parser.error("cloud backend does not accept Runtime Asset arguments")
    if args.worker.is_symlink():
        parser.error("--worker must be a regular onedir bundle")
    worker = args.worker.resolve(strict=True)
    if not worker.is_dir():
        parser.error("--worker must be a regular onedir bundle")
    if args.output.suffix != ".shejane-plugin":
        parser.error("--output must end in .shejane-plugin")

    entrypoint = (
        "payload/vision-worker.exe"
        if args.platform.startswith("windows/")
        else "payload/vision-worker"
    )
    worker_entrypoint = worker / Path(entrypoint).name
    if worker_entrypoint.is_symlink() or not worker_entrypoint.is_file():
        parser.error("--worker entrypoint is unavailable")
    for path in worker.rglob("*"):
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            try:
                target = path.resolve(strict=True)
                target.relative_to(worker)
            except (FileNotFoundError, OSError, ValueError):
                parser.error("--worker contains an unsafe entry")
            if not target.is_file():
                parser.error("--worker contains an unsafe entry")
            continue
        if not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)):
            parser.error("--worker contains an unsafe entry")
    with tempfile.TemporaryDirectory(prefix="vision-plugin-package-") as temporary:
        stage = Path(temporary)
        (stage / ".shejane-plugin").mkdir()
        (stage / "actions").mkdir()
        shutil.copyfile(
            ROOT / "actions" / f"vision.analyze_images.{args.backend}.input.json",
            stage / "actions" / f"vision.analyze_images.{args.backend}.input.json",
        )
        shutil.copyfile(
            ROOT / "actions" / "vision.analyze_images.output.json",
            stage / "actions" / "vision.analyze_images.output.json",
        )
        shutil.copytree(ROOT / "commands", stage / "commands")
        shutil.copytree(worker, stage / "payload")
        manifest = (ROOT / ".shejane-plugin" / f"plugin.{args.backend}.template.json").read_text(
            encoding="utf-8"
        )
        manifest = (
            manifest.replace("__PLUGIN_VERSION__", args.version)
            .replace("__ENTRYPOINT__", entrypoint)
            .replace("__PLATFORM__", args.platform)
        )
        if args.backend == "local":
            manifest = manifest.replace(
                "__RUNTIME_ASSET_VERSION__", args.runtime_asset_version
            ).replace("__RUNTIME_ASSET_DIGEST__", args.runtime_asset_digest)
        if "__" in manifest:
            raise RuntimeError("plugin manifest template contains an unresolved placeholder")
        (stage / ".shejane-plugin" / "plugin.json").write_text(manifest, encoding="utf-8")
        pack(stage, args.output, entrypoint)


def pack(source: Path, output: Path, entrypoint: str) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(item for item in source.rglob("*") if item.is_file()):
                relative = path.relative_to(source).as_posix()
                info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = (0o500 if relative == entrypoint else 0o600) << 16
                archive.writestr(info, path.read_bytes())
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
