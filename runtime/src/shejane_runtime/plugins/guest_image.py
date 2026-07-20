"""Deterministic minimal Linux initramfs for local VM backends."""

from __future__ import annotations

import hashlib
import os
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path

_GO_VERSION = "go1.26.5"
_ELF_MACHINES = {"amd64": 62, "arm64": 183}
_ELF_TYPE_RELOCATABLE = 1
_PT_INTERP = 3
_VSOCK_MODULE_NAMES = (
    "vsock.ko",
    "vmw_vsock_virtio_transport_common.ko",
    "vmw_vsock_virtio_transport.ko",
)
_FILESYSTEM_MODULE_NAMES = (
    "virtio_blk.ko",
    "crc16.ko",
    "mbcache.ko",
    "jbd2.ko",
    "ext4.ko",
    "cdrom.ko",
    "isofs.ko",
)
_MODULE_SETS = (
    _VSOCK_MODULE_NAMES,
    _FILESYSTEM_MODULE_NAMES,
    (*_VSOCK_MODULE_NAMES, *_FILESYSTEM_MODULE_NAMES),
)


def build_linux_initramfs(
    source: Path,
    output: Path,
    *,
    architecture: str,
    module_paths: tuple[Path, ...] = (),
) -> str:
    """Cross-compile guestd without network access and atomically write newc."""

    source = source.resolve(strict=True)
    if source.suffix != ".go" or source.is_symlink():
        raise ValueError("guestd source must be a regular Go file")
    machine = _ELF_MACHINES.get(architecture)
    if machine is None:
        raise ValueError("guest architecture is unsupported")
    modules = _read_modules(module_paths, machine=machine)
    go = shutil.which("go")
    if go is None:
        raise RuntimeError("Go toolchain is unavailable")
    version = subprocess.run(
        [go, "version"], check=True, capture_output=True, text=True, timeout=10
    ).stdout.split()
    if len(version) < 3 or version[2] != _GO_VERSION:
        raise RuntimeError(f"guestd requires {_GO_VERSION}")

    with tempfile.TemporaryDirectory(prefix="shejane-guestd-") as temporary:
        root = Path(temporary)
        binary_path = root / "init"
        environment = {
            "CGO_ENABLED": "0",
            "GOARCH": architecture,
            "GOENV": "off",
            "GOOS": "linux",
            "GOPROXY": "off",
            "GOSUMDB": "off",
            "GOTELEMETRY": "off",
            "GOTOOLCHAIN": "local",
            "GOCACHE": str(root / "go-cache"),
            "HOME": str(root),
            "PATH": os.environ.get("PATH", ""),
            "TMPDIR": str(root),
        }
        subprocess.run(
            [
                go,
                "build",
                "-trimpath",
                "-buildvcs=false",
                "-ldflags=-s -w -buildid=",
                "-o",
                str(binary_path),
                str(source),
            ],
            check=True,
            capture_output=True,
            env=environment,
            timeout=120,
        )
        binary = binary_path.read_bytes()

    _validate_static_elf(binary, machine=machine)
    archive = bytearray()
    inode = 1
    if modules:
        _append_newc(archive, "modules", b"", mode=0o040755, inode=inode)
        inode += 1
        for name, module in modules:
            _append_newc(archive, f"modules/{name}", module, mode=0o100444, inode=inode)
            inode += 1
    _append_newc(archive, "init", binary, mode=0o100755, inode=inode)
    _append_newc(archive, "TRAILER!!!", b"", mode=0, inode=inode + 1)
    archive.extend(b"\0" * (-len(archive) % 512))

    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(archive)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, output)
    except BaseException:
        Path(temporary_name).unlink(missing_ok=True)
        raise
    return "sha256:" + hashlib.sha256(archive).hexdigest()


def _validate_static_elf(binary: bytes, *, machine: int) -> None:
    _validate_elf(binary, "guestd", machine=machine)
    program_offset = struct.unpack_from("<Q", binary, 32)[0]
    entry_size, entry_count = struct.unpack_from("<HH", binary, 54)
    if entry_size < 4 or program_offset + entry_size * entry_count > len(binary):
        raise RuntimeError("guestd has an invalid ELF program table")
    if any(
        struct.unpack_from("<I", binary, program_offset + index * entry_size)[0] == _PT_INTERP
        for index in range(entry_count)
    ):
        raise RuntimeError("guestd must be statically linked")


def _read_modules(module_paths: tuple[Path, ...], *, machine: int) -> tuple[tuple[str, bytes], ...]:
    if not module_paths:
        return ()
    if tuple(path.name for path in module_paths) not in _MODULE_SETS:
        raise ValueError("guest initramfs requires an exact supported module set")
    modules = []
    for path in module_paths:
        if path.is_symlink():
            raise ValueError("guest VSOCK modules must be regular files")
        module = path.resolve(strict=True).read_bytes()
        _validate_elf(module, path.name, machine=machine)
        if struct.unpack_from("<H", module, 16)[0] != _ELF_TYPE_RELOCATABLE:
            raise ValueError(f"guest VSOCK module {path.name} is not relocatable")
        modules.append((path.name, module))
    return tuple(modules)


def _validate_elf(binary: bytes, label: str, *, machine: int) -> None:
    if len(binary) < 64 or binary[:6] != b"\x7fELF\x02\x01":
        raise ValueError(f"{label} is not a 64-bit little-endian ELF")
    if struct.unpack_from("<H", binary, 18)[0] != machine:
        raise ValueError(f"{label} has the wrong Linux architecture")


def _append_newc(archive: bytearray, name: str, data: bytes, *, mode: int, inode: int) -> None:
    encoded_name = name.encode("ascii") + b"\0"
    fields = (
        inode,
        mode,
        0,
        0,
        1,
        0,
        len(data),
        0,
        0,
        0,
        0,
        len(encoded_name),
        0,
    )
    archive.extend(b"070701" + b"".join(f"{field:08x}".encode() for field in fields))
    archive.extend(encoded_name)
    archive.extend(b"\0" * (-len(archive) % 4))
    archive.extend(data)
    archive.extend(b"\0" * (-len(archive) % 4))
