"""Host-side image staging for the macOS Virtualization.framework backend."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import (
    AnyUrl,
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from .guest_disk import Ext4ImageTool, build_ext4_disk_image
from .manifest import Digest, PackagePath
from .platforms import current_managed_worker_platform
from .runtime_assets import RuntimeAssetHandle
from .sandbox_contract import SandboxLimits
from .sandbox_runtime import SandboxRuntimeError

_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_MIB = 1024 * 1024
_MIN_DISK_BYTES = 16 * _MIB
_MAX_DISK_BYTES = 8 * 1024 * _MIB
_VM_OVERHEAD_BYTES = 128 * _MIB


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _VMAssetFile(_StrictModel):
    path: PackagePath
    size: int = Field(ge=1, le=8 * 1024 * _MIB)
    sha256: Digest


class _VMAssetFiles(_StrictModel):
    kernel: _VMAssetFile
    initramfs: _VMAssetFile
    rootfs: _VMAssetFile
    mke2fs: _VMAssetFile
    launcher: _VMAssetFile


class _VMAssetPlatform(_StrictModel):
    os: Literal["darwin", "linux"]
    arch: Literal["arm64", "amd64"]


class _VMAssetSource(_StrictModel):
    name: str = Field(min_length=1, max_length=100)
    version: str = Field(min_length=1, max_length=200)
    url: AnyUrl
    sha256: Digest
    signature: str | None = Field(default=None, min_length=1, max_length=500)

    @field_validator("url")
    @classmethod
    def require_https_source(cls, value: AnyUrl) -> AnyUrl:
        if value.scheme != "https":
            raise ValueError("VM asset source URL must use HTTPS")
        return value


class MacOSVMAssetManifest(_StrictModel):
    schema_version: Literal[1]
    asset_set_id: str = Field(pattern=r"^darwin-(?:arm64|amd64)/sha256:[0-9a-f]{64}$")
    host: _VMAssetPlatform
    guest: _VMAssetPlatform
    protocol_version: Literal[1]
    files: _VMAssetFiles
    sources: list[_VMAssetSource] = Field(min_length=1, max_length=32)
    build: dict[str, str] = Field(min_length=1, max_length=64)
    sbom: _VMAssetFile
    licenses: list[_VMAssetFile] = Field(min_length=1, max_length=64)

    @field_validator("build")
    @classmethod
    def require_build_provenance(cls, value: dict[str, str]) -> dict[str, str]:
        if any(
            not key or len(key) > 100 or not item or len(item) > 500 for key, item in value.items()
        ):
            raise ValueError("VM asset build provenance is invalid")
        return value

    @model_validator(mode="after")
    def require_matching_platforms(self) -> MacOSVMAssetManifest:
        if (
            self.host.os != "darwin"
            or self.guest.os != "linux"
            or self.host.arch != self.guest.arch
        ):
            raise ValueError("VM asset host and guest architectures must match")
        return self


@dataclass(frozen=True, slots=True)
class MacOSVMResources:
    launcher: Path
    launcher_digest: str
    kernel: Path
    kernel_digest: str
    initramfs: Path
    initramfs_digest: str
    rootfs: Path
    rootfs_digest: str
    ext4_tool: Ext4ImageTool

    def verify(self) -> None:
        for path, digest, label in (
            (self.launcher, self.launcher_digest, "launcher"),
            (self.kernel, self.kernel_digest, "kernel"),
            (self.initramfs, self.initramfs_digest, "initramfs"),
            (self.rootfs, self.rootfs_digest, "rootfs"),
        ):
            if (
                not path.is_absolute()
                or path.is_symlink()
                or not path.is_file()
                or _DIGEST.fullmatch(digest) is None
                or _sha256(path) != digest
            ):
                raise SandboxRuntimeError(f"managed worker VM {label} identity changed")


def load_macos_vm_resources(
    manifest_path: Path,
    *,
    host_platform: str | None = None,
) -> MacOSVMResources:
    """Load one immutable, architecture-specific VM asset set."""

    if (
        not manifest_path.is_absolute()
        or manifest_path.is_symlink()
        or manifest_path.parent.is_symlink()
        or not manifest_path.is_file()
        or manifest_path.stat().st_size > 256 * 1024
    ):
        raise SandboxRuntimeError("managed worker VM manifest is invalid")
    try:
        raw = json.loads(
            manifest_path.read_text(encoding="utf-8"),
            object_pairs_hook=_unique_json_object,
        )
        manifest = MacOSVMAssetManifest.model_validate(raw)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError, ValidationError) as exc:
        raise SandboxRuntimeError("managed worker VM manifest is invalid") from exc

    platform = host_platform or current_managed_worker_platform()
    expected_platform = f"darwin/{manifest.host.arch}"
    if platform != expected_platform:
        raise SandboxRuntimeError("managed worker VM asset architecture changed")
    canonical = json.dumps(
        manifest.model_dump(mode="json", exclude={"asset_set_id"}, exclude_none=True),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    expected_id = f"darwin-{manifest.host.arch}/sha256:" + hashlib.sha256(canonical).hexdigest()
    if manifest.asset_set_id != expected_id:
        raise SandboxRuntimeError("managed worker VM asset set identity changed")

    root = manifest_path.parent.resolve(strict=True)
    resolved = {
        name: _verified_asset_file(root, value, executable=name in {"launcher", "mke2fs"})
        for name, value in manifest.files
    }
    _verified_asset_file(root, manifest.sbom, executable=False)
    for license_file in manifest.licenses:
        _verified_asset_file(root, license_file, executable=False)
    resources = MacOSVMResources(
        launcher=resolved["launcher"],
        launcher_digest=manifest.files.launcher.sha256,
        kernel=resolved["kernel"],
        kernel_digest=manifest.files.kernel.sha256,
        initramfs=resolved["initramfs"],
        initramfs_digest=manifest.files.initramfs.sha256,
        rootfs=resolved["rootfs"],
        rootfs_digest=manifest.files.rootfs.sha256,
        ext4_tool=Ext4ImageTool(
            executable=resolved["mke2fs"],
            digest=manifest.files.mke2fs.sha256,
        ),
    )
    resources.verify()
    return resources


def prepare_macos_vm_command(
    *,
    resources: MacOSVMResources,
    limits: SandboxLimits,
    package_root: Path,
    entrypoint: Path,
    input_root: Path,
    output_root: Path,
    runtime_assets: tuple[RuntimeAssetHandle, ...],
    temporary_root: Path,
) -> list[str]:
    """Build three invocation-local disks and return the frozen launcher command."""

    resources.verify()
    package_root = package_root.resolve(strict=True)
    input_root = input_root.resolve(strict=True)
    output_root = output_root.resolve(strict=True)
    temporary_root = temporary_root.resolve(strict=True)
    try:
        relative_entrypoint = entrypoint.resolve(strict=True).relative_to(package_root)
    except (OSError, ValueError) as exc:
        raise SandboxRuntimeError("managed worker VM entrypoint is outside package") from exc
    if entrypoint.is_symlink() or not entrypoint.is_file():
        raise SandboxRuntimeError("managed worker VM entrypoint is invalid")
    relative = relative_entrypoint.as_posix()
    if (package_root / ".shejane-host").exists() or (package_root / ".shejane-host").is_symlink():
        raise SandboxRuntimeError("managed worker package uses a reserved path")

    staged_package = temporary_root / "package"
    shutil.copytree(package_root, staged_package, symlinks=True)
    host_metadata = staged_package / ".shejane-host"
    asset_root = host_metadata / "runtime-assets"
    asset_root.mkdir(mode=0o700, parents=True)
    asset_paths: dict[str, str] = {}
    for asset in sorted(runtime_assets, key=lambda item: item.asset_id):
        if asset.asset_id in asset_paths:
            raise SandboxRuntimeError("managed worker runtime asset ids are duplicated")
        destination = asset_root / asset.asset_id
        shutil.copytree(asset.payload, destination, symlinks=True)
        asset_paths[asset.asset_id] = f"/package/.shejane-host/runtime-assets/{asset.asset_id}"
    (host_metadata / "runtime-assets.json").write_text(
        json.dumps(asset_paths, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )

    package_image = temporary_root / "package.ext4"
    input_image = temporary_root / "input.ext4"
    scratch_image = temporary_root / "scratch.ext4"
    build_ext4_disk_image(
        tool=resources.ext4_tool,
        source_root=staged_package,
        output=package_image,
        capacity_bytes=_disk_capacity(staged_package),
        label="SHEJANE_PACKAGE",
    )
    build_ext4_disk_image(
        tool=resources.ext4_tool,
        source_root=input_root,
        output=input_image,
        capacity_bytes=_disk_capacity(input_root),
        label="SHEJANE_INPUT",
    )
    build_ext4_disk_image(
        tool=resources.ext4_tool,
        source_root=None,
        output=scratch_image,
        capacity_bytes=limits.scratch_bytes,
        label="SHEJANE_SCRATCH",
    )
    vm_memory = max(256 * _MIB, limits.memory_bytes + _VM_OVERHEAD_BYTES)
    return [
        str(resources.launcher),
        "--entrypoint",
        relative,
        "--kernel",
        str(resources.kernel),
        "--initramfs",
        str(resources.initramfs),
        "--rootfs",
        str(resources.rootfs),
        "--package",
        str(package_image),
        "--input",
        str(input_image),
        "--scratch",
        str(scratch_image),
        "--memory-bytes",
        str(vm_memory),
        "--output-root",
        str(output_root),
        "--output-bytes",
        str(limits.output_bytes),
        "--scratch-bytes",
        str(limits.scratch_bytes),
        "--wall-time-ms",
        str(limits.wall_time_ms),
        "--worker-memory-bytes",
        str(limits.memory_bytes),
    ]


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key")
        value[key] = item
    return value


def _verified_asset_file(
    root: Path,
    expected: _VMAssetFile,
    *,
    executable: bool,
) -> Path:
    path = root
    for part in expected.path.split("/"):
        path /= part
        if path.is_symlink():
            raise SandboxRuntimeError("managed worker VM asset path contains a symlink")
    try:
        metadata = path.stat(follow_symlinks=False)
        path.resolve(strict=True).relative_to(root)
    except (OSError, ValueError) as exc:
        raise SandboxRuntimeError("managed worker VM asset path is invalid") from exc
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_size != expected.size
        or _sha256(path) != expected.sha256
    ):
        raise SandboxRuntimeError("managed worker VM asset identity changed")
    if executable and not os.access(path, os.X_OK):
        raise SandboxRuntimeError("managed worker VM executable asset is invalid")
    return path


def _disk_capacity(root: Path) -> int:
    total = 0
    entries = 0
    resolved_root = root.resolve(strict=True)
    for directory, directories, files in os.walk(resolved_root, followlinks=False):
        for name in [*directories, *files]:
            path = Path(directory) / name
            metadata = path.lstat()
            entries += 1
            if stat.S_ISREG(metadata.st_mode):
                total += metadata.st_size
            elif stat.S_ISLNK(metadata.st_mode):
                try:
                    path.resolve(strict=True).relative_to(resolved_root)
                except (OSError, ValueError) as exc:
                    raise SandboxRuntimeError(
                        "managed worker VM staging link escapes its root"
                    ) from exc
            elif not stat.S_ISDIR(metadata.st_mode):
                raise SandboxRuntimeError("managed worker VM staging contains a special file")
    capacity = total + max(_MIN_DISK_BYTES, total // 4) + entries * 16 * 1024
    capacity = max(_MIN_DISK_BYTES, (capacity + 4095) & ~4095)
    if capacity > _MAX_DISK_BYTES:
        raise SandboxRuntimeError("managed worker VM disk exceeds the platform limit")
    return capacity


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()
