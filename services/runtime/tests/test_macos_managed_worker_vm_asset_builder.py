from __future__ import annotations

import importlib.util
import struct
from pathlib import Path

import pytest
import zstandard

ROOT = Path(__file__).parents[3]
BUILDER = ROOT / "apps" / "desktop" / "vm-assets" / "build_darwin.py"


def _load_builder():
    spec = importlib.util.spec_from_file_location("managed_worker_vm_asset_builder", BUILDER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_vm_asset_builder_extracts_arm64_zboot_by_header() -> None:
    builder = _load_builder()
    image = bytearray(64)
    struct.pack_into("<Q", image, 16, len(image))
    image[56:60] = b"ARMd"
    compressed = zstandard.ZstdCompressor().compress(bytes(image))
    zboot = bytearray(128 + len(compressed) + 16)
    zboot[:2] = b"MZ"
    zboot[4:8] = b"zimg"
    struct.pack_into("<II", zboot, 8, 128, len(compressed))
    zboot[24:28] = b"zstd"
    zboot[128 : 128 + len(compressed)] = compressed

    assert builder.extract_arm64_zboot(bytes(zboot)) == bytes(image)

    struct.pack_into("<I", zboot, 12, len(compressed) + 17)
    with pytest.raises(SystemExit, match="zboot"):
        builder.extract_arm64_zboot(bytes(zboot))


def test_vm_asset_builder_requires_fedora_signature_ok() -> None:
    builder = _load_builder()
    valid = """package.rpm:
    Header V4 RSA/SHA256 Signature, key ID 6d9f90a6: OK
    Header SHA256 digest: OK
    Payload SHA256 digest: OK
"""
    builder.require_rpm_signature(valid, key_id="6d9f90a6")

    with pytest.raises(SystemExit, match="signature"):
        builder.require_rpm_signature(
            valid.replace("key ID 6d9f90a6: OK", "key ID 6d9f90a6: NOKEY"),
            key_id="6d9f90a6",
        )
