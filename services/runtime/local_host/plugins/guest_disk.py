"""Deterministic ext4 block images for the macOS Managed Worker VM."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import stat
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .sandbox_runtime import SandboxRuntimeError

_BLOCK_BYTES = 4096
_MIN_IMAGE_BYTES = 16 * 1024 * 1024
_MAX_IMAGE_BYTES = 8 * 1024 * 1024 * 1024
_MKE2FS_VERSION = "mke2fs 1.47.2"
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_LABELS = {
    "SHEJANE_INPUT": "00000000-0000-4000-8000-000000000001",
    "SHEJANE_SCRATCH": "00000000-0000-4000-8000-000000000002",
    "SHEJANE_PACKAGE": "00000000-0000-4000-8000-000000000003",
}


@dataclass(frozen=True)
class Ext4ImageTool:
    """One packaged mke2fs executable pinned by content digest."""

    executable: Path
    digest: str

    def __post_init__(self) -> None:
        if not self.executable.is_absolute() or _DIGEST.fullmatch(self.digest) is None:
            raise SandboxRuntimeError("ext4 image helper identity is invalid")


def build_ext4_disk_image(
    *,
    tool: Ext4ImageTool,
    source_root: Path | None,
    output: Path,
    capacity_bytes: int,
    label: str,
) -> str:
    """Create one fixed-capacity image without mounting untrusted contents on Host."""

    _validate_capacity(capacity_bytes)
    filesystem_uuid = _LABELS.get(label)
    if filesystem_uuid is None:
        raise SandboxRuntimeError("managed worker disk label is invalid")
    executable = _validate_tool(tool)
    if source_root is None and label != "SHEJANE_SCRATCH":
        raise SandboxRuntimeError("managed worker read-only disk requires a source tree")
    if source_root is not None and label not in {"SHEJANE_INPUT", "SHEJANE_PACKAGE"}:
        raise SandboxRuntimeError("managed worker scratch disk must start empty")

    output.parent.mkdir(parents=True, exist_ok=True)
    if source_root is not None:
        if source_root.is_symlink() or not source_root.is_dir():
            raise SandboxRuntimeError("managed worker input root is invalid")
        source_root = source_root.resolve(strict=True)
        output_parent = output.parent.resolve(strict=True)
        if output_parent == source_root or source_root in output_parent.parents:
            raise SandboxRuntimeError("managed worker disk destination overlaps input")
    with tempfile.TemporaryDirectory(prefix="shejane-ext4-", dir=output.parent) as temporary:
        temporary_root = Path(temporary)
        normalized_root: Path | None = None
        if source_root is not None:
            normalized_root = temporary_root / "input"
            _copy_normalized_tree(
                source_root,
                normalized_root,
                executable=label == "SHEJANE_PACKAGE",
                internal_links=label == "SHEJANE_PACKAGE",
            )
        image = temporary_root / "disk.ext4"
        command = [
            str(executable),
            "-q",
            "-F",
            "-t",
            "ext4",
            "-b",
            str(_BLOCK_BYTES),
            "-I",
            "256",
            "-i",
            "16384",
            "-U",
            filesystem_uuid,
            "-L",
            label,
            "-m",
            "0",
            "-O",
            "extents,64bit,flex_bg,metadata_csum,dir_nlink,extra_isize,"
            "^metadata_csum_seed,^orphan_file",
            "-E",
            f"lazy_itable_init=0,lazy_journal_init=0,root_owner=0:0,hash_seed={filesystem_uuid}",
        ]
        if normalized_root is not None:
            command.extend(("-d", str(normalized_root)))
        command.extend((str(image), str(capacity_bytes // _BLOCK_BYTES)))
        environment = {
            "E2FSPROGS_FAKE_TIME": "0",
            "HOME": str(temporary_root),
            "MKE2FS_CONFIG": os.devnull,
            "PATH": os.defpath,
            "SOURCE_DATE_EPOCH": "0",
            "TMPDIR": str(temporary_root),
        }
        try:
            subprocess.run(
                command,
                check=True,
                capture_output=True,
                env=environment,
                timeout=120,
            )
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise SandboxRuntimeError("managed worker ext4 image build failed") from exc
        if not image.is_file() or image.stat().st_size != capacity_bytes:
            raise SandboxRuntimeError("managed worker ext4 image size is invalid")
        os.chmod(image, 0o600)
        digest = _sha256(image)
        os.replace(image, output)
    return digest


def _validate_capacity(capacity_bytes: int) -> None:
    if (
        isinstance(capacity_bytes, bool)
        or not isinstance(capacity_bytes, int)
        or not _MIN_IMAGE_BYTES <= capacity_bytes <= _MAX_IMAGE_BYTES
        or capacity_bytes % _BLOCK_BYTES
    ):
        raise SandboxRuntimeError("managed worker disk capacity is invalid")


def _validate_tool(tool: Ext4ImageTool) -> Path:
    executable = tool.executable
    if executable.is_symlink() or not executable.is_file():
        raise SandboxRuntimeError("managed worker ext4 image helper is unavailable")
    if _sha256(executable) != tool.digest:
        raise SandboxRuntimeError("managed worker ext4 image helper digest changed")
    try:
        version = subprocess.run(
            [str(executable), "-V"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise SandboxRuntimeError("managed worker ext4 image helper is unavailable") from exc
    if _MKE2FS_VERSION not in version.stdout + version.stderr:
        raise SandboxRuntimeError("managed worker ext4 image helper version changed")
    return executable


def _copy_normalized_tree(
    source_root: Path,
    target_root: Path,
    *,
    executable: bool,
    internal_links: bool,
) -> None:
    if source_root.is_symlink() or not source_root.is_dir():
        raise SandboxRuntimeError("managed worker input root is invalid")
    target_root.mkdir(mode=0o755)
    _copy_normalized_directory(
        source_root,
        target_root,
        source_root=source_root,
        executable=executable,
        internal_links=internal_links,
    )


def _copy_normalized_directory(
    source: Path,
    target: Path,
    *,
    source_root: Path,
    executable: bool,
    internal_links: bool,
) -> None:
    with os.scandir(source) as entries:
        ordered = sorted(entries, key=lambda entry: os.fsencode(entry.name))
    for entry in ordered:
        destination = target / entry.name
        metadata = entry.stat(follow_symlinks=False)
        if stat.S_ISLNK(metadata.st_mode):
            if not internal_links:
                raise SandboxRuntimeError("managed worker input tree contains a symlink")
            link = os.readlink(entry.path)
            try:
                (Path(entry.path).parent / link).resolve(strict=True).relative_to(source_root)
            except (OSError, ValueError) as exc:
                raise SandboxRuntimeError("managed worker package link escapes its root") from exc
            os.symlink(link, destination)
            os.utime(destination, (0, 0), follow_symlinks=False)
            continue
        if stat.S_ISDIR(metadata.st_mode):
            destination.mkdir(mode=0o755)
            _copy_normalized_directory(
                Path(entry.path),
                destination,
                source_root=source_root,
                executable=executable,
                internal_links=internal_links,
            )
            continue
        if not stat.S_ISREG(metadata.st_mode):
            raise SandboxRuntimeError("managed worker input tree contains a special file")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(entry.path, flags)
        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode) or (
                opened.st_dev,
                opened.st_ino,
            ) != (metadata.st_dev, metadata.st_ino):
                raise SandboxRuntimeError("managed worker input tree changed during staging")
            with os.fdopen(descriptor, "rb", closefd=False) as input_stream:
                with destination.open("xb") as output_stream:
                    shutil.copyfileobj(input_stream, output_stream, length=1024 * 1024)
        finally:
            os.close(descriptor)
        os.chmod(destination, 0o555 if executable and metadata.st_mode & 0o111 else 0o444)
        os.utime(destination, (0, 0), follow_symlinks=False)
    os.chmod(target, 0o555)
    os.utime(target, (0, 0), follow_symlinks=False)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()
