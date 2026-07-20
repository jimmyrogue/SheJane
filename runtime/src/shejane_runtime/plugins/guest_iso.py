"""Deterministic read-only media for Windows Managed Worker VMs."""

from __future__ import annotations

import hashlib
import os
import shutil
import stat
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pycdlib
from pycdlib import headervd
from pycdlib import pycdlib as pycdlib_core

from .sandbox_runtime import SandboxRuntimeError

_FIXED_TIME = 315_532_800.0  # 1980-01-01 UTC, valid in ISO9660 directory records.
_PYCDLIB_LOCK = threading.Lock()
_LABELS = {"SHEJANE_INPUT": 0o444, "SHEJANE_PACKAGE": 0o555}


@dataclass(frozen=True)
class _Entry:
    relative: tuple[str, ...]
    kind: str
    staged: Path | None = None
    link: str | None = None


def build_read_only_iso_image(
    *,
    source_root: Path,
    output: Path,
    label: str,
) -> str:
    """Snapshot one authorized tree into an atomic Rock Ridge ISO image."""

    file_mode = _LABELS.get(label)
    if file_mode is None:
        raise SandboxRuntimeError("managed worker ISO label is invalid")
    if source_root.is_symlink() or not source_root.is_dir():
        raise SandboxRuntimeError("managed worker ISO source root is invalid")
    source_root = source_root.resolve(strict=True)
    if not output.is_absolute() or output.exists() or output.is_symlink():
        raise SandboxRuntimeError("managed worker ISO output is invalid")
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        output.parent.resolve(strict=True).relative_to(source_root)
    except ValueError:
        pass
    else:
        raise SandboxRuntimeError("managed worker ISO output overlaps its source")

    with tempfile.TemporaryDirectory(prefix="shejane-iso-", dir=output.parent) as temporary:
        temporary_root = Path(temporary)
        entries = _snapshot_tree(
            source_root,
            temporary_root / "snapshot",
            allow_links=label == "SHEJANE_PACKAGE",
        )
        image_path = temporary_root / "media.iso"
        _write_iso(entries, image_path, label=label, file_mode=file_mode)
        if not image_path.is_file() or image_path.stat().st_size == 0:
            raise SandboxRuntimeError("managed worker ISO build failed")
        os.chmod(image_path, 0o600)
        digest = _sha256(image_path)
        os.replace(image_path, output)
    return digest


def _snapshot_tree(source_root: Path, target_root: Path, *, allow_links: bool) -> list[_Entry]:
    target_root.mkdir(mode=0o700)
    entries: list[_Entry] = []

    def visit(source: Path, target: Path, relative: tuple[str, ...]) -> None:
        with os.scandir(source) as scanned:
            children = sorted(scanned, key=lambda item: os.fsencode(item.name))
        for child in children:
            _validate_name(child.name)
            child_relative = (*relative, child.name)
            metadata = child.stat(follow_symlinks=False)
            destination = target / child.name
            if stat.S_ISLNK(metadata.st_mode):
                if not allow_links:
                    raise SandboxRuntimeError("managed worker input tree contains a symlink")
                link = os.readlink(child.path)
                if os.path.isabs(link):
                    raise SandboxRuntimeError("managed worker package contains an absolute symlink")
                try:
                    (Path(child.path).parent / link).resolve(strict=True).relative_to(source_root)
                except (OSError, ValueError) as exc:
                    raise SandboxRuntimeError(
                        "managed worker package link escapes its root"
                    ) from exc
                entries.append(_Entry(child_relative, "link", link=link))
                continue
            if stat.S_ISDIR(metadata.st_mode):
                destination.mkdir(mode=0o700)
                entries.append(_Entry(child_relative, "directory"))
                visit(Path(child.path), destination, child_relative)
                continue
            if not stat.S_ISREG(metadata.st_mode):
                raise SandboxRuntimeError("managed worker ISO source contains a special file")
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            try:
                descriptor = os.open(child.path, flags)
            except OSError as exc:
                raise SandboxRuntimeError("managed worker ISO source changed") from exc
            try:
                opened = os.fstat(descriptor)
                if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (
                    metadata.st_dev,
                    metadata.st_ino,
                ):
                    raise SandboxRuntimeError("managed worker ISO source changed")
                with os.fdopen(descriptor, "rb", closefd=False) as source_stream:
                    with destination.open("xb") as target_stream:
                        shutil.copyfileobj(source_stream, target_stream, length=1024 * 1024)
            finally:
                os.close(descriptor)
            os.chmod(destination, 0o400)
            os.utime(destination, (0, 0), follow_symlinks=False)
            entries.append(_Entry(child_relative, "file", staged=destination))

    visit(source_root, target_root, ())
    return entries


def _write_iso(entries: list[_Entry], output: Path, *, label: str, file_mode: int) -> None:
    image = pycdlib.PyCdlib()
    aliases: dict[tuple[str, ...], str] = {(): ""}
    with _fixed_pycdlib_clock():
        try:
            image.new(
                interchange_level=3,
                rock_ridge="1.09",
                sys_ident="SHEJANE",
                vol_ident=label,
                app_ident_str="SHEJANE_RUNTIME",
            )
            for index, entry in enumerate(entries, start=1):
                parent = aliases[entry.relative[:-1]]
                stem = f"{entry.kind[0].upper()}{index:07d}"
                alias = f"{parent}/{stem}" if entry.kind == "directory" else f"{parent}/{stem}.;1"
                name = entry.relative[-1]
                if entry.kind == "directory":
                    image.add_directory(
                        alias,
                        rr_name=name,
                        file_mode=stat.S_IFDIR | 0o555,
                        creation_time=_FIXED_TIME,
                    )
                    aliases[entry.relative] = alias
                elif entry.kind == "file":
                    assert entry.staged is not None
                    image.add_file(
                        str(entry.staged),
                        iso_path=alias,
                        rr_name=name,
                        file_mode=stat.S_IFREG | file_mode,
                        creation_time=_FIXED_TIME,
                    )
                else:
                    assert entry.link is not None
                    image.add_symlink(
                        symlink_path=alias,
                        rr_symlink_name=name,
                        rr_path=entry.link,
                        creation_time=_FIXED_TIME,
                    )
            image.write(str(output))
        except (OSError, pycdlib.pycdlibexception.PyCdlibException) as exc:
            raise SandboxRuntimeError("managed worker ISO build failed") from exc
        finally:
            image.close()


@contextmanager
def _fixed_pycdlib_clock() -> Iterator[None]:
    clock = SimpleNamespace(time=lambda: _FIXED_TIME)
    with _PYCDLIB_LOCK:
        original_core_time = pycdlib_core.time
        original_header_time = headervd.time
        vars(pycdlib_core)["time"] = clock
        vars(headervd)["time"] = clock
        try:
            yield
        finally:
            vars(pycdlib_core)["time"] = original_core_time
            vars(headervd)["time"] = original_header_time


def _validate_name(name: str) -> None:
    if name in {"", ".", ".."} or "/" in name or "\x00" in name:
        raise SandboxRuntimeError("managed worker ISO source name is invalid")
    try:
        name.encode("utf-8", errors="strict")
    except UnicodeEncodeError as exc:
        raise SandboxRuntimeError("managed worker ISO source name is invalid") from exc


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()
