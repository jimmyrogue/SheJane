"""Canonical plugin package digest and detached Ed25519 verification."""

from __future__ import annotations

import base64
import hashlib
import os
import shutil
import stat
import struct
import tempfile
import unicodedata
import zipfile
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

SIGNATURE_PATH = ".shejane-plugin/signature.json"
_DIGEST_DOMAIN = b"shejane-plugin-package-v1\0"
_SIGNATURE_DOMAIN = b"shejane-plugin-signature-v1\0"
_MAX_FILES = 10_000
_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
_MAX_TOTAL_BYTES = 1024 * 1024 * 1024


class InvalidPluginPackage(ValueError):
    """Package bytes cannot be represented by the v1 canonical format."""


class InvalidPluginSignature(ValueError):
    """Detached signature does not bind this package to the supplied key."""


def extract_plugin_archive(source: Path, destination: Path) -> None:
    """Safely expand one plugin ZIP into a private, empty staging directory."""

    extract_canonical_archive(
        source,
        destination,
        required_manifest=".shejane-plugin/plugin.json",
        max_archive_bytes=_MAX_ARCHIVE_BYTES,
        max_total_bytes=_MAX_TOTAL_BYTES,
        archive_label="plugin",
    )


def extract_canonical_archive(
    source: Path,
    destination: Path,
    *,
    required_manifest: str,
    max_archive_bytes: int,
    max_total_bytes: int,
    archive_label: str,
    allow_internal_symlinks: bool = False,
    max_files: int = _MAX_FILES,
) -> None:
    """Safely expand a bounded canonical ZIP without trusting ZIP attributes."""

    if not source.is_file() or source.stat().st_size > max_archive_bytes:
        limit_mib = max_archive_bytes // (1024 * 1024)
        raise InvalidPluginPackage(f"{archive_label} archive is missing or exceeds {limit_mib} MiB")
    if destination.exists():
        raise InvalidPluginPackage("plugin staging destination already exists")

    try:
        archive = zipfile.ZipFile(source)
    except (OSError, zipfile.BadZipFile) as exc:
        raise InvalidPluginPackage("plugin archive is not a readable ZIP") from exc

    with archive:
        infos = archive.infolist()
        if len(infos) > max_files:
            raise InvalidPluginPackage("plugin package file limit exceeded")
        files: list[tuple[zipfile.ZipInfo, tuple[str, ...]]] = []
        links: list[tuple[zipfile.ZipInfo, tuple[str, ...], str]] = []
        directories: list[tuple[str, ...]] = []
        folded_paths: set[str] = set()
        total_bytes = 0
        for info in infos:
            raw = info.filename.rstrip("/")
            parts = tuple(raw.split("/"))
            if (
                not raw
                or raw != unicodedata.normalize("NFC", raw)
                or raw.startswith("/")
                or "\\" in raw
                or any(ord(character) < 32 for character in raw)
                or any(part in {"", ".", ".."} for part in parts)
            ):
                raise InvalidPluginPackage("plugin archive path is not canonical")
            folded = raw.casefold()
            if folded in folded_paths:
                raise InvalidPluginPackage("plugin archive paths collide when case-folded")
            folded_paths.add(folded)
            mode = (info.external_attr >> 16) & 0xFFFF
            file_type = stat.S_IFMT(mode)
            allowed_types = {0, stat.S_IFREG, stat.S_IFDIR}
            if allow_internal_symlinks:
                allowed_types.add(stat.S_IFLNK)
            if file_type not in allowed_types:
                raise InvalidPluginPackage("plugin archives cannot contain links or special files")
            if info.flag_bits & 1:
                raise InvalidPluginPackage("encrypted plugin archives are unsupported")
            if info.is_dir():
                directories.append(parts)
                continue
            total_bytes += info.file_size
            if total_bytes > max_total_bytes:
                raise InvalidPluginPackage(f"{archive_label} expanded size limit exceeded")
            if file_type == stat.S_IFLNK:
                try:
                    target = archive.read(info).decode("utf-8")
                except (OSError, UnicodeError) as exc:
                    raise InvalidPluginPackage("runtime asset link target is invalid") from exc
                if not target or os.path.isabs(target) or "\\" in target or "\x00" in target:
                    raise InvalidPluginPackage("runtime asset link target is invalid")
                links.append((info, parts, target))
            else:
                files.append((info, parts))

        if not any("/".join(parts) == required_manifest for _, parts in files):
            raise InvalidPluginPackage(f"{archive_label} manifest is missing")

        destination.mkdir(parents=True)
        try:
            for parts in sorted(directories, key=len):
                destination.joinpath(*parts).mkdir(parents=True, exist_ok=True)
            for info, parts in files:
                target = destination.joinpath(*parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                written = 0
                with archive.open(info) as source_stream, target.open("xb") as target_stream:
                    while chunk := source_stream.read(1024 * 1024):
                        written += len(chunk)
                        if written > info.file_size:
                            raise InvalidPluginPackage(
                                "plugin archive entry exceeded declared size"
                            )
                        target_stream.write(chunk)
                if written != info.file_size:
                    raise InvalidPluginPackage("plugin archive entry size changed while reading")
            for _info, parts, link_target in links:
                target = destination.joinpath(*parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(link_target)
            resolved_root = destination.resolve(strict=True)
            for _info, parts, _link_target in links:
                try:
                    destination.joinpath(*parts).resolve(strict=True).relative_to(resolved_root)
                except (OSError, RuntimeError, ValueError) as exc:
                    raise InvalidPluginPackage("runtime asset link escapes the asset") from exc
        except BaseException:
            shutil.rmtree(destination, ignore_errors=True)
            raise


def canonical_package_digest(root: Path) -> str:
    """Hash normalized paths and file bytes, excluding the detached signature."""

    return canonical_tree_digest(
        root,
        domain=_DIGEST_DOMAIN,
        required_manifest=".shejane-plugin/plugin.json",
        excluded_paths=frozenset({SIGNATURE_PATH}),
        max_total_bytes=_MAX_TOTAL_BYTES,
        package_label="plugin package",
    )


def pack_plugin_archive(source: Path, destination: Path) -> str:
    """Validate and atomically write one reproducible plugin archive."""

    source = source.resolve(strict=True)
    destination = destination.expanduser().absolute()
    if destination.suffix != ".shejane-plugin":
        raise InvalidPluginPackage("plugin archive must end in .shejane-plugin")
    if destination.exists():
        raise InvalidPluginPackage("plugin archive destination already exists")
    digest = canonical_package_digest(source)
    files = sorted(path for path in source.rglob("*") if path.is_file())
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination = destination.parent.resolve(strict=True) / destination.name
    try:
        destination.relative_to(source)
    except ValueError:
        pass
    else:
        raise InvalidPluginPackage("plugin archive destination must be outside the package")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in files:
                relative = path.relative_to(source).as_posix()
                info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o600 << 16
                archive.writestr(info, path.read_bytes())
        if canonical_package_digest(source) != digest:
            raise InvalidPluginPackage("plugin package changed while packing")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return digest


def canonical_tree_digest(
    root: Path,
    *,
    domain: bytes,
    required_manifest: str,
    excluded_paths: frozenset[str],
    max_total_bytes: int,
    package_label: str,
    allow_internal_symlinks: bool = False,
    max_files: int = _MAX_FILES,
) -> str:
    """Hash normalized regular files for one content-addressed package kind."""

    if root.is_symlink() or not root.is_dir():
        raise InvalidPluginPackage(f"{package_label} root must be a real directory")
    root = root.resolve(strict=True)
    entries: list[tuple[str, bytes, Path]] = []
    folded_paths: set[str] = set()
    total_bytes = 0

    for path in root.rglob("*"):
        if path.is_symlink():
            if not allow_internal_symlinks:
                raise InvalidPluginPackage(f"{package_label} cannot contain links")
            try:
                target = os.readlink(path)
                path.resolve(strict=True).relative_to(root)
            except (OSError, RuntimeError, ValueError) as exc:
                raise InvalidPluginPackage(f"{package_label} link escapes the package") from exc
            if not target or os.path.isabs(target) or "\\" in target or "\x00" in target:
                raise InvalidPluginPackage(f"{package_label} link target is invalid")
            entry_kind = b"L"
        else:
            entry_kind = b"F"
        if not path.is_symlink() and path.is_dir():
            if allow_internal_symlinks:
                relative = path.relative_to(root).as_posix()
                if (
                    relative != unicodedata.normalize("NFC", relative)
                    or "\\" in relative
                    or any(ord(character) < 32 for character in relative)
                    or any(part in {"", ".", ".."} for part in relative.split("/"))
                ):
                    raise InvalidPluginPackage("plugin package path is not canonical")
                folded = relative.casefold()
                if folded in folded_paths:
                    raise InvalidPluginPackage(f"{package_label} paths collide when case-folded")
                folded_paths.add(folded)
                entries.append((relative, b"D", path))
            continue
        if not path.is_symlink():
            try:
                mode = path.stat(follow_symlinks=False).st_mode
            except OSError as exc:
                raise InvalidPluginPackage("plugin package entry cannot be inspected") from exc
            if not stat.S_ISREG(mode):
                raise InvalidPluginPackage(f"{package_label} can contain only regular files")
        relative = path.relative_to(root).as_posix()
        if (
            relative != unicodedata.normalize("NFC", relative)
            or "\\" in relative
            or any(ord(character) < 32 for character in relative)
            or any(part in {"", ".", ".."} for part in relative.split("/"))
        ):
            raise InvalidPluginPackage("plugin package path is not canonical")
        folded = relative.casefold()
        if folded in folded_paths:
            raise InvalidPluginPackage(f"{package_label} paths collide when case-folded")
        folded_paths.add(folded)
        if relative not in excluded_paths:
            entries.append((relative, entry_kind, path))

    if len(entries) > max_files:
        raise InvalidPluginPackage("plugin package file limit exceeded")
    if not any(relative == required_manifest for relative, _kind, _path in entries):
        raise InvalidPluginPackage(f"{package_label} manifest is missing")

    digest = hashlib.sha256(domain)
    for relative, entry_kind, path in sorted(entries):
        try:
            data = (
                os.readlink(path).encode("utf-8")
                if entry_kind == b"L"
                else b""
                if entry_kind == b"D"
                else path.read_bytes()
            )
        except OSError as exc:
            raise InvalidPluginPackage("plugin package entry cannot be read") from exc
        total_bytes += len(data)
        if total_bytes > max_total_bytes:
            raise InvalidPluginPackage(f"{package_label} expanded size limit exceeded")
        path_bytes = relative.encode("utf-8")
        digest.update(struct.pack(">Q", len(path_bytes)))
        digest.update(path_bytes)
        if allow_internal_symlinks:
            digest.update(entry_kind)
        digest.update(struct.pack(">Q", len(data)))
        digest.update(data)
    return "sha256:" + digest.hexdigest()


def verify_package_signature(
    root: Path,
    envelope: dict[str, Any],
    public_key_bytes: bytes,
) -> str:
    """Return the verified key id; caller remains responsible for trusting it."""

    if set(envelope) != {
        "schema_version",
        "algorithm",
        "key_id",
        "package_digest",
        "signature",
    }:
        raise InvalidPluginSignature("signature envelope fields are invalid")
    if envelope["schema_version"] != 1 or envelope["algorithm"] != "ed25519":
        raise InvalidPluginSignature("signature envelope version or algorithm is unsupported")
    digest = canonical_package_digest(root)
    if envelope["package_digest"] != digest:
        raise InvalidPluginSignature("signature package digest does not match")
    key_id = "ed25519:sha256:" + hashlib.sha256(public_key_bytes).hexdigest()
    if envelope["key_id"] != key_id:
        raise InvalidPluginSignature("signature key id does not match the supplied key")
    try:
        signature = base64.b64decode(str(envelope["signature"]), validate=True)
        Ed25519PublicKey.from_public_bytes(public_key_bytes).verify(
            signature,
            _SIGNATURE_DOMAIN + digest.encode("ascii"),
        )
    except (InvalidSignature, ValueError, TypeError) as exc:
        raise InvalidPluginSignature("plugin package signature is invalid") from exc
    return key_id
