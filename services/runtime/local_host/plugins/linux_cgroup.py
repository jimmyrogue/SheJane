"""Linux cgroup v2 resources for the Managed Worker launcher."""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .sandbox_contract import SandboxLimits
from .sandbox_runtime import SandboxRuntimeError


@dataclass(frozen=True, slots=True)
class LinuxCgroupResources:
    launcher: Path
    delegated_root: Path
    bubblewrap: Path | None = None


_BWRAP_FILES = {
    "COPYING.bubblewrap",
    "copyright.libcap",
    "libcap.so.2",
    "shejane-bwrap",
}
_SHA256 = re.compile(r"[0-9a-f]{64}")


def load_linux_cgroup_resources(
    manifest_path: Path,
    *,
    host_platform: str,
    proc_cgroup: Path = Path("/proc/self/cgroup"),
    cgroup_mount: Path = Path("/sys/fs/cgroup"),
) -> LinuxCgroupResources:
    """Load packaged helpers from a systemd-delegated cgroup v2 service."""

    if not host_platform.startswith("linux/"):
        raise SandboxRuntimeError("Linux Managed Worker assets require Linux")
    if (
        not manifest_path.is_absolute()
        or manifest_path.is_symlink()
        or manifest_path.parent.is_symlink()
        or not manifest_path.is_file()
        or manifest_path.stat().st_size > 64 * 1024
    ):
        raise SandboxRuntimeError("Linux Managed Worker asset manifest is invalid")
    try:
        manifest = json.loads(
            manifest_path.read_text(encoding="utf-8"),
            object_pairs_hook=_unique_json_object,
        )
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise SandboxRuntimeError("Linux Managed Worker asset manifest is invalid") from exc
    if (
        not isinstance(manifest, dict)
        or set(manifest) != {"schema_version", "version", "setuid", "files"}
        or manifest["schema_version"] != 1
        or manifest["version"] != "0.11.2"
        or manifest["setuid"] is not False
        or not isinstance(manifest["files"], dict)
        or set(manifest["files"]) != _BWRAP_FILES
    ):
        raise SandboxRuntimeError("Linux Managed Worker asset manifest is invalid")

    assets = manifest_path.parent.resolve(strict=True)
    for name, identity in manifest["files"].items():
        path = assets / name
        if (
            not isinstance(identity, dict)
            or set(identity) != {"sha256", "size_bytes"}
            or not isinstance(identity["sha256"], str)
            or _SHA256.fullmatch(identity["sha256"]) is None
            or isinstance(identity["size_bytes"], bool)
            or not isinstance(identity["size_bytes"], int)
            or identity["size_bytes"] < 0
            or path.is_symlink()
            or not path.is_file()
        ):
            raise SandboxRuntimeError("Linux Managed Worker asset identity is invalid")
        raw = path.read_bytes()
        if (
            len(raw) != identity["size_bytes"]
            or hashlib.sha256(raw).hexdigest() != identity["sha256"]
        ):
            raise SandboxRuntimeError("Linux Managed Worker asset identity changed")

    launcher = assets.parent / "shejane-managed-worker-linux"
    bubblewrap = assets / "shejane-bwrap"
    if (
        launcher.is_symlink()
        or not launcher.is_file()
        or not os.access(launcher, os.X_OK)
        or not os.access(bubblewrap, os.X_OK)
    ):
        raise SandboxRuntimeError("Linux Managed Worker launcher is unavailable")

    try:
        unified = [
            line.removeprefix("0::")
            for line in proc_cgroup.read_text(encoding="ascii").splitlines()
            if line.startswith("0::")
        ]
        if len(unified) != 1 or not unified[0].startswith("/"):
            raise ValueError
        mount = cgroup_mount.resolve(strict=True)
        current = (mount / unified[0].removeprefix("/")).resolve(strict=True)
        current.relative_to(mount)
    except (OSError, UnicodeError, ValueError) as exc:
        raise SandboxRuntimeError("Linux cgroup v2 membership is unavailable") from exc

    delegated = None
    for candidate in current.parents:
        if candidate == mount:
            break
        try:
            if os.getxattr(candidate, "user.delegate") == b"1":
                delegated = candidate
                break
        except OSError:
            continue
    if delegated is None:
        raise SandboxRuntimeError(
            "Linux Runtime requires a systemd service with Delegate= and DelegateSubgroup="
        )
    try:
        controllers = set((delegated / "cgroup.controllers").read_text(encoding="ascii").split())
        if not {"cpu", "memory", "pids"} <= controllers:
            raise ValueError
        subtree = delegated / "cgroup.subtree_control"
        enabled = set(subtree.read_text(encoding="ascii").split())
        missing = {"cpu", "memory", "pids"} - enabled
        if missing:
            subtree.write_text(" ".join(f"+{name}" for name in sorted(missing)), encoding="ascii")
            if not {"cpu", "memory", "pids"} <= set(subtree.read_text(encoding="ascii").split()):
                raise ValueError
    except (OSError, UnicodeError, ValueError) as exc:
        raise SandboxRuntimeError("Linux delegated cgroup controllers are unavailable") from exc
    return LinuxCgroupResources(
        launcher=launcher,
        delegated_root=delegated,
        bubblewrap=bubblewrap,
    )


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key")
        value[key] = item
    return value


def prepare_linux_cgroup_command(
    *,
    resources: LinuxCgroupResources,
    limits: SandboxLimits,
    command: list[str],
    package_root: Path | None = None,
    input_root: Path | None = None,
    output_root: Path | None = None,
    runtime_asset_roots: dict[str, Path] | None = None,
) -> list[str]:
    if not command:
        raise SandboxRuntimeError("Linux cgroup worker command is empty")
    launcher = resources.launcher
    root = resources.delegated_root
    if (
        not launcher.is_absolute()
        or launcher.is_symlink()
        or not launcher.is_file()
        or not os.access(launcher, os.X_OK)
    ):
        raise SandboxRuntimeError("Linux cgroup launcher is unavailable")
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise SandboxRuntimeError("Linux cgroup delegated root is unavailable")
    try:
        controllers = set((root / "cgroup.controllers").read_text(encoding="ascii").split())
    except (OSError, UnicodeError) as exc:
        raise SandboxRuntimeError("Linux cgroup v2 controllers are unavailable") from exc
    if not {"cpu", "memory", "pids"} <= controllers:
        raise SandboxRuntimeError("Linux cgroup v2 controllers are incomplete")
    wrapped = [
        str(launcher),
        "--cgroup-root",
        str(root),
        "--memory-bytes",
        str(limits.memory_bytes),
        "--pids-max",
        str(limits.process_count),
        "--cpu-max",
        "100000 100000",
    ]
    if resources.bubblewrap is not None:
        bubblewrap = resources.bubblewrap
        if (
            not bubblewrap.is_absolute()
            or bubblewrap.is_symlink()
            or not bubblewrap.is_file()
            or not os.access(bubblewrap, os.X_OK)
        ):
            raise SandboxRuntimeError("Linux bubblewrap launcher is unavailable")
        if package_root is None or input_root is None or output_root is None:
            raise SandboxRuntimeError("Linux sandbox roots are unavailable")
        if limits.output_bytes >= limits.memory_bytes:
            raise SandboxRuntimeError("Linux output limit exhausts aggregate memory")
        scratch_bytes = max(
            limits.output_bytes,
            min(limits.scratch_bytes, limits.memory_bytes // 2),
        )
        wrapped.extend(
            [
                "--bubblewrap",
                str(bubblewrap),
                "--package-root",
                str(package_root),
                "--input-root",
                str(input_root),
                "--output-root",
                str(output_root),
                "--scratch-bytes",
                str(scratch_bytes),
                "--output-bytes",
                str(limits.output_bytes),
                "--max-frame-bytes",
                str(limits.protocol_frame_bytes),
            ]
        )
        for asset_id, path in sorted((runtime_asset_roots or {}).items()):
            wrapped.extend(["--runtime-asset", f"{asset_id}={path}"])
    return [*wrapped, "--", *command]
