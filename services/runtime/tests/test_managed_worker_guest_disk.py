from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pytest

from local_host.plugins.guest_disk import Ext4ImageTool, build_ext4_disk_image
from local_host.plugins.sandbox_runtime import SandboxRuntimeError


def test_ext4_disk_image_is_deterministic_and_normalizes_input(tmp_path: Path) -> None:
    tool = _fake_mke2fs(tmp_path)
    source = tmp_path / "source"
    source.mkdir()
    nested = source / "nested"
    nested.mkdir()
    document = nested / "document.txt"
    document.write_text("authorized input", encoding="utf-8")
    document.chmod(0o600)
    os.utime(document, (1_700_000_000, 1_700_000_000))

    first = tmp_path / "first.ext4"
    second = tmp_path / "second.ext4"
    first_digest = build_ext4_disk_image(
        tool=tool,
        source_root=source,
        output=first,
        capacity_bytes=16 * 1024 * 1024,
        label="SHEJANE_INPUT",
    )
    os.utime(document, (1_800_000_000, 1_800_000_000))
    document.chmod(0o644)
    second_digest = build_ext4_disk_image(
        tool=tool,
        source_root=source,
        output=second,
        capacity_bytes=16 * 1024 * 1024,
        label="SHEJANE_INPUT",
    )

    assert first_digest == second_digest
    assert first.read_bytes() == second.read_bytes()
    assert b"nested/document.txt:authorized input:292:0" in first.read_bytes()
    with pytest.raises(SandboxRuntimeError, match="destination overlaps input"):
        build_ext4_disk_image(
            tool=tool,
            source_root=source,
            output=source / "disk.ext4",
            capacity_bytes=16 * 1024 * 1024,
            label="SHEJANE_INPUT",
        )


def test_ext4_disk_image_rejects_untrusted_helper_and_input(tmp_path: Path) -> None:
    tool = _fake_mke2fs(tmp_path)
    source = tmp_path / "source"
    source.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    (source / "escape").symlink_to(outside)

    with pytest.raises(SandboxRuntimeError, match="input tree contains a symlink"):
        build_ext4_disk_image(
            tool=tool,
            source_root=source,
            output=tmp_path / "input.ext4",
            capacity_bytes=16 * 1024 * 1024,
            label="SHEJANE_INPUT",
        )

    invalid_tool = Ext4ImageTool(
        executable=tool.executable,
        digest="sha256:" + "0" * 64,
    )
    with pytest.raises(SandboxRuntimeError, match="helper digest changed"):
        build_ext4_disk_image(
            tool=invalid_tool,
            source_root=None,
            output=tmp_path / "scratch.ext4",
            capacity_bytes=16 * 1024 * 1024,
            label="SHEJANE_SCRATCH",
        )


def test_package_disk_preserves_only_executable_bits_and_internal_links(
    tmp_path: Path,
) -> None:
    tool = _fake_mke2fs(tmp_path)
    source = tmp_path / "package"
    payload = source / "payload"
    payload.mkdir(parents=True)
    worker = payload / "worker"
    worker.write_bytes(b"worker")
    worker.chmod(0o700)
    library = payload / "library.bin"
    library.write_bytes(b"library")
    library.chmod(0o666)
    (payload / "library-link").symlink_to("library.bin")

    package = tmp_path / "package.ext4"
    build_ext4_disk_image(
        tool=tool,
        source_root=source,
        output=package,
        capacity_bytes=16 * 1024 * 1024,
        label="SHEJANE_PACKAGE",
    )

    assert b"payload/worker:worker:365:0" in package.read_bytes()
    assert b"payload/library.bin:library:292:0" in package.read_bytes()
    assert b"payload/library-link:link:library.bin" in package.read_bytes()

    outside = tmp_path / "outside"
    outside.write_bytes(b"secret")
    (payload / "escape").symlink_to(outside)
    with pytest.raises(SandboxRuntimeError, match="package link escapes"):
        build_ext4_disk_image(
            tool=tool,
            source_root=source,
            output=tmp_path / "invalid-package.ext4",
            capacity_bytes=16 * 1024 * 1024,
            label="SHEJANE_PACKAGE",
        )


def _fake_mke2fs(tmp_path: Path) -> Ext4ImageTool:
    executable = tmp_path / "mke2fs"
    executable.write_text(
        """#!/usr/bin/env python3
import pathlib
import sys

if "-V" in sys.argv:
    print("mke2fs 1.47.2 (1-Jan-2025)")
    raise SystemExit(0)
root = pathlib.Path(sys.argv[sys.argv.index("-d") + 1]) if "-d" in sys.argv else None
output = pathlib.Path(sys.argv[-2])
capacity = int(sys.argv[-1]) * 4096
rows = [f"capacity:{capacity}"]
if root:
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            rows.append(f"{relative}:link:{path.readlink()}")
        elif path.is_file():
            rows.append(
                f"{relative}:{path.read_text()}:{path.stat().st_mode & 0o777}:{int(path.stat().st_mtime)}"
            )
with output.open("wb") as stream:
    stream.write("\\n".join(rows).encode())
    stream.truncate(capacity)
""",
        encoding="utf-8",
    )
    executable.chmod(0o755)
    digest = "sha256:" + hashlib.sha256(executable.read_bytes()).hexdigest()
    return Ext4ImageTool(executable=executable, digest=digest)
