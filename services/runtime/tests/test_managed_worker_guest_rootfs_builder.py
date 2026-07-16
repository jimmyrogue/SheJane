from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[3]
BUILDER = ROOT / "apps" / "desktop" / "vm-assets" / "build_guest_rootfs.py"


def _load_builder():
    spec = importlib.util.spec_from_file_location("managed_worker_guest_rootfs_builder", BUILDER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_guest_rootfs_builder_verifies_exact_runtime_package_set(tmp_path: Path) -> None:
    builder = _load_builder()
    package = tmp_path / "runtime.deb"
    package.write_bytes(b"locked package")
    expected = [
        {
            "filename": package.name,
            "size": package.stat().st_size,
            "sha256": hashlib.sha256(package.read_bytes()).hexdigest(),
        }
    ]

    assert builder.verify_runtime_packages(tmp_path, expected) == [package]

    package.write_bytes(b"tampered package")
    with pytest.raises(SystemExit, match="identity changed"):
        builder.verify_runtime_packages(tmp_path, expected)

    package.write_bytes(b"locked package")
    (tmp_path / "unexpected.deb").write_bytes(b"unexpected")
    with pytest.raises(SystemExit, match="set changed"):
        builder.verify_runtime_packages(tmp_path, expected)
