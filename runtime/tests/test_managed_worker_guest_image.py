from __future__ import annotations

import struct
from pathlib import Path

import pytest

from shejane_runtime.plugins.guest_image import build_linux_initramfs

GUESTD_SOURCE = (
    Path(__file__).parents[1] / "src" / "shejane_runtime" / "plugins" / "guestd" / "main.go"
)


def test_guest_initramfs_is_static_arm64_and_deterministic(tmp_path: Path) -> None:
    first = tmp_path / "first.cpio"
    second = tmp_path / "second.cpio"

    first_digest = build_linux_initramfs(GUESTD_SOURCE, first, architecture="arm64")
    second_digest = build_linux_initramfs(GUESTD_SOURCE, second, architecture="arm64")

    assert first_digest == second_digest
    assert first.read_bytes() == second.read_bytes()
    guestd = _newc_files(first.read_bytes())["init"]
    assert guestd[:4] == b"\x7fELF"
    assert guestd[4:6] == b"\x02\x01"
    assert struct.unpack_from("<H", guestd, 18)[0] == 183


def test_guest_initramfs_is_static_amd64_and_deterministic(tmp_path: Path) -> None:
    first = tmp_path / "first.cpio"
    second = tmp_path / "second.cpio"

    first_digest = build_linux_initramfs(GUESTD_SOURCE, first, architecture="amd64")
    second_digest = build_linux_initramfs(GUESTD_SOURCE, second, architecture="amd64")

    assert first_digest == second_digest
    assert first.read_bytes() == second.read_bytes()
    guestd = _newc_files(first.read_bytes())["init"]
    assert struct.unpack_from("<H", guestd, 18)[0] == 62

    filesystem_modules = (
        "virtio_blk.ko",
        "crc16.ko",
        "mbcache.ko",
        "jbd2.ko",
        "ext4.ko",
        "cdrom.ko",
        "isofs.ko",
    )
    module_paths = []
    for name in filesystem_modules:
        module = tmp_path / name
        module.write_bytes(_module_fixture(machine=62))
        module_paths.append(module)
    with_module = tmp_path / "with-module.cpio"
    build_linux_initramfs(
        GUESTD_SOURCE,
        with_module,
        architecture="amd64",
        module_paths=tuple(module_paths),
    )
    assert list(_newc_files(with_module.read_bytes())) == [
        "modules",
        *(f"modules/{name}" for name in filesystem_modules),
        "init",
    ]


def test_guest_initramfs_embeds_only_the_exact_vsock_modules(tmp_path: Path) -> None:
    module_names = (
        "vsock.ko",
        "vmw_vsock_virtio_transport_common.ko",
        "vmw_vsock_virtio_transport.ko",
    )
    module_paths = []
    for name in module_names:
        path = tmp_path / name
        path.write_bytes(_arm64_module_fixture())
        module_paths.append(path)

    output = tmp_path / "guest.cpio"
    build_linux_initramfs(
        GUESTD_SOURCE,
        output,
        architecture="arm64",
        module_paths=tuple(module_paths),
    )

    assert list(_newc_files(output.read_bytes())) == [
        "modules",
        *(f"modules/{name}" for name in module_names),
        "init",
    ]
    with pytest.raises(ValueError, match="exact supported module set"):
        build_linux_initramfs(
            GUESTD_SOURCE,
            tmp_path / "invalid.cpio",
            architecture="arm64",
            module_paths=tuple(module_paths[:2]),
        )


def _arm64_module_fixture() -> bytes:
    return _module_fixture(machine=183)


def _module_fixture(*, machine: int) -> bytes:
    binary = bytearray(64)
    binary[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<H", binary, 16, 1)
    struct.pack_into("<H", binary, 18, machine)
    return bytes(binary)


def _newc_files(archive: bytes) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    offset = 0
    while archive[offset : offset + 6] == b"070701":
        fields = [
            int(archive[offset + field : offset + field + 8], 16) for field in range(6, 110, 8)
        ]
        file_size = fields[6]
        name_size = fields[11]
        name_end = offset + 110 + name_size
        name = archive[offset + 110 : name_end - 1].decode()
        data_start = (name_end + 3) & ~3
        if name == "TRAILER!!!":
            break
        files[name] = archive[data_start : data_start + file_size]
        offset = (data_start + file_size + 3) & ~3
    return files
