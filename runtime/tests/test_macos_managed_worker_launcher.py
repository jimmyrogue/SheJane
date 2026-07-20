from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
BUILD_SCRIPT = ROOT / "scripts" / "build-macos-managed-worker-vm.sh"


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS Virtualization launcher")
def test_macos_managed_worker_launcher_builds_and_self_checks(tmp_path: Path) -> None:
    launcher = tmp_path / "shejane-managed-worker-vm"
    subprocess.run(
        ["bash", str(BUILD_SCRIPT), str(launcher)],
        check=True,
        capture_output=True,
        timeout=120,
    )

    checked = subprocess.run(
        [str(launcher), "--self-test"],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    signature = subprocess.run(
        ["codesign", "-d", "--entitlements", "-", str(launcher)],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert checked.stdout == "shejane-managed-worker-vm: self-test ok\n"
    assert "com.apple.security.virtualization" in signature.stdout + signature.stderr

    kernel = tmp_path / "kernel"
    kernel.write_bytes(b"k")
    linked_kernel = tmp_path / "kernel-link"
    linked_kernel.symlink_to(kernel)
    initramfs = tmp_path / "initramfs"
    initramfs.write_bytes(b"i")
    rootfs = tmp_path / "rootfs.ext4"
    with rootfs.open("wb") as stream:
        stream.truncate(16 * 1024 * 1024)
    input_image = tmp_path / "input.ext4"
    input_image.write_bytes(b"i")
    package_image = tmp_path / "package.ext4"
    package_image.write_bytes(b"p")
    scratch_image = tmp_path / "scratch.ext4"
    scratch_image.write_bytes(b"s")
    output_root = tmp_path / "output"
    output_root.mkdir()

    rejected = subprocess.run(
        [
            str(launcher),
            "--entrypoint",
            "payload/worker",
            "--kernel",
            str(linked_kernel),
            "--initramfs",
            str(initramfs),
            "--rootfs",
            str(rootfs),
            "--input",
            str(input_image),
            "--package",
            str(package_image),
            "--scratch",
            str(scratch_image),
            "--memory-bytes",
            str(256 * 1024 * 1024),
            "--output-root",
            str(output_root),
            "--output-bytes",
            str(1024 * 1024),
            "--scratch-bytes",
            str(16 * 1024 * 1024),
            "--wall-time-ms",
            "1000",
            "--worker-memory-bytes",
            str(64 * 1024 * 1024),
        ],
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert rejected.returncode == 1
    assert rejected.stderr == "shejane-managed-worker-vm: path contains a symlink\n"
