from __future__ import annotations

import hashlib
import os
from pathlib import Path

import pycdlib
import pytest

from local_host.plugins.guest_iso import build_read_only_iso_image
from local_host.plugins.sandbox_runtime import SandboxRuntimeError


def test_read_only_iso_is_reproducible_and_preserves_rock_ridge_tree(tmp_path: Path) -> None:
    source = tmp_path / "source"
    nested = source / "目录"
    nested.mkdir(parents=True)
    (nested / "文档.txt").write_bytes(b"stable input")
    (source / "empty").mkdir()
    os.symlink("目录/文档.txt", source / "current")

    first = tmp_path / "first.iso"
    second = tmp_path / "second.iso"
    first_digest = build_read_only_iso_image(
        source_root=source,
        output=first,
        label="SHEJANE_PACKAGE",
    )
    second_digest = build_read_only_iso_image(
        source_root=source,
        output=second,
        label="SHEJANE_PACKAGE",
    )

    assert first.read_bytes() == second.read_bytes()
    assert (
        first_digest == second_digest == "sha256:" + hashlib.sha256(first.read_bytes()).hexdigest()
    )
    image = pycdlib.PyCdlib()
    image.open(str(first))
    try:
        with image.open_file_from_iso(rr_path="/目录/文档.txt") as stream:
            assert stream.read() == b"stable input"
        assert image.get_record(rr_path="/empty").is_dir()
        assert image.get_record(rr_path="/current").is_symlink()
    finally:
        image.close()


def test_input_iso_rejects_links_and_special_files(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    os.symlink("missing", source / "link")

    with pytest.raises(SandboxRuntimeError, match="symlink"):
        build_read_only_iso_image(
            source_root=source,
            output=tmp_path / "input.iso",
            label="SHEJANE_INPUT",
        )
