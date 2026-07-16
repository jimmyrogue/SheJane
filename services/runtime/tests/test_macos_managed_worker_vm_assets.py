from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from local_host.plugins.macos_vm import load_macos_vm_resources
from local_host.plugins.sandbox_runtime import SandboxRuntimeError

ROOT = Path(__file__).parents[3]
SCHEMA = ROOT / "schemas" / "managed-worker-vm-assets-v1.schema.json"


def test_macos_vm_asset_manifest_loads_exact_architecture(tmp_path: Path) -> None:
    manifest = _write_asset_set(tmp_path, arch="arm64")
    Draft202012Validator(json.loads(SCHEMA.read_text())).validate(json.loads(manifest.read_text()))

    resources = load_macos_vm_resources(manifest, host_platform="darwin/arm64")

    assert resources.launcher == tmp_path / "shejane-managed-worker-vm"
    assert resources.kernel == tmp_path / "linux-kernel"
    assert resources.initramfs == tmp_path / "initramfs.cpio"
    assert resources.rootfs == tmp_path / "guest-rootfs.ext4"
    assert resources.ext4_tool.executable == tmp_path / "mke2fs"


def test_macos_vm_asset_manifest_rejects_tamper_and_wrong_architecture(
    tmp_path: Path,
) -> None:
    manifest = _write_asset_set(tmp_path, arch="arm64")
    (tmp_path / "linux-kernel").write_bytes(b"tampered")

    with pytest.raises(SandboxRuntimeError, match="identity changed"):
        load_macos_vm_resources(manifest, host_platform="darwin/arm64")

    manifest = _write_asset_set(tmp_path, arch="arm64")
    with pytest.raises(SandboxRuntimeError, match="architecture"):
        load_macos_vm_resources(manifest, host_platform="darwin/amd64")


def test_macos_vm_asset_manifest_rejects_symlink(tmp_path: Path) -> None:
    manifest = _write_asset_set(tmp_path, arch="arm64")
    launcher = tmp_path / "shejane-managed-worker-vm"
    target = tmp_path / "launcher-target"
    launcher.replace(target)
    launcher.symlink_to(target)

    with pytest.raises(SandboxRuntimeError, match="symlink"):
        load_macos_vm_resources(manifest, host_platform="darwin/arm64")

    asset_root = tmp_path / "assets"
    asset_root.mkdir()
    manifest = _write_asset_set(asset_root, arch="arm64")
    linked_root = tmp_path / "linked-assets"
    linked_root.symlink_to(asset_root, target_is_directory=True)

    with pytest.raises(SandboxRuntimeError, match="manifest is invalid"):
        load_macos_vm_resources(
            linked_root / manifest.name,
            host_platform="darwin/arm64",
        )


def test_macos_vm_asset_manifest_requires_https_sources(tmp_path: Path) -> None:
    manifest = _write_asset_set(tmp_path, arch="arm64")
    payload = json.loads(manifest.read_text())
    payload["sources"][0]["url"] = "http://download.example.invalid/kernel.rpm"
    _write_manifest_identity(manifest, payload)

    with pytest.raises(SandboxRuntimeError, match="manifest is invalid"):
        load_macos_vm_resources(manifest, host_platform="darwin/arm64")


def _write_asset_set(root: Path, *, arch: str) -> Path:
    files = {
        "kernel": "linux-kernel",
        "initramfs": "initramfs.cpio",
        "rootfs": "guest-rootfs.ext4",
        "mke2fs": "mke2fs",
        "launcher": "shejane-managed-worker-vm",
    }
    for name, relative in files.items():
        path = root / relative
        path.write_bytes(name.encode())
        os.chmod(path, 0o755 if name in {"launcher", "mke2fs"} else 0o644)
    licenses = root / "licenses"
    licenses.mkdir(exist_ok=True)
    (licenses / "kernel.txt").write_text("GPL-2.0-only\n", encoding="utf-8")
    (root / "sbom.spdx.json").write_text("{}", encoding="utf-8")
    payload = {
        "schema_version": 1,
        "host": {"os": "darwin", "arch": arch},
        "guest": {"os": "linux", "arch": arch},
        "protocol_version": 1,
        "files": {
            name: {
                "path": relative,
                "size": (root / relative).stat().st_size,
                "sha256": _digest(root / relative),
            }
            for name, relative in files.items()
        },
        "sources": [
            {
                "name": "fedora-kernel",
                "version": "6.19.10-300.fc44",
                "url": "https://download.fedoraproject.org/",
                "sha256": "sha256:" + "a" * 64,
            }
        ],
        "build": {"guestd_commit": "test", "go_version": "go1.26.5"},
        "sbom": _file_record(root, "sbom.spdx.json"),
        "licenses": [_file_record(root, "licenses/kernel.txt")],
    }
    manifest = root / "manifest.json"
    _write_manifest_identity(manifest, payload)
    return manifest


def _write_manifest_identity(manifest: Path, payload: dict[str, object]) -> None:
    payload.pop("asset_set_id", None)
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    arch = payload["host"]["arch"]  # type: ignore[index]
    payload["asset_set_id"] = (
        f"darwin-{arch}/sha256:" + hashlib.sha256(canonical.encode()).hexdigest()
    )
    manifest.write_text(json.dumps(payload), encoding="utf-8")


def _digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _file_record(root: Path, relative: str) -> dict[str, object]:
    path = root / relative
    return {"path": relative, "size": path.stat().st_size, "sha256": _digest(path)}
