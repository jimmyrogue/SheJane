from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from local_host.plugins.executor import ManagedWorkerActionExecutor
from local_host.plugins.guest_disk import Ext4ImageTool
from local_host.plugins.guest_image import build_linux_initramfs
from local_host.plugins.macos_vm import MacOSVMResources, load_macos_vm_resources
from local_host.plugins.managed_worker import (
    WorkerProtocolError,
    _reap_stale_vm_staging,
    invoke_managed_worker,
)
from local_host.plugins.runtime_assets import RuntimeAssetStore

ROOT = Path(__file__).parents[3]
GUESTD = ROOT / "services/runtime/local_host/plugins/guestd/main.go"
WORKER = ROOT / "services/runtime/tests/fixtures/managed_worker_linux/main.go"
NODE_WORKER = ROOT / "services/runtime/tests/fixtures/managed_worker_node"
RUNTIME_CRASH_DRIVER = ROOT / "services/runtime/tests/fixtures/macos_vm_runtime_crash.py"
BUILD_LAUNCHER = ROOT / "scripts/build-macos-managed-worker-vm.sh"
MODULE_NAMES = (
    "vsock.ko",
    "vmw_vsock_virtio_transport_common.ko",
    "vmw_vsock_virtio_transport.ko",
)


async def _vm_resources(tmp_path: Path) -> tuple[MacOSVMResources, str | None]:
    asset_manifest = os.environ.get("SHEJANE_TEST_MACOS_VM_ASSETS")
    if asset_manifest:
        return load_macos_vm_resources(Path(asset_manifest)), asset_manifest
    kernel = _required_path("SHEJANE_TEST_MACOS_VM_KERNEL")
    modules = _required_path("SHEJANE_TEST_MACOS_VM_MODULES")
    mke2fs = _required_path("SHEJANE_TEST_MKE2FS")
    rootfs = _required_path("SHEJANE_TEST_GUEST_ROOTFS")
    module_paths = tuple(modules / name for name in MODULE_NAMES)
    if any(not path.is_file() or path.is_symlink() for path in module_paths):
        pytest.skip("exact macOS VM VSOCK modules are unavailable")

    launcher = tmp_path / "shejane-managed-worker-vm"
    await asyncio.to_thread(
        subprocess.run,
        ["bash", str(BUILD_LAUNCHER), str(launcher)],
        check=True,
        capture_output=True,
        timeout=120,
    )
    initramfs = tmp_path / "guest.cpio"
    build_linux_initramfs(
        GUESTD,
        initramfs,
        architecture="arm64",
        module_paths=module_paths,
    )
    return (
        MacOSVMResources(
            launcher=launcher,
            launcher_digest=_digest(launcher),
            kernel=kernel,
            kernel_digest=_digest(kernel),
            initramfs=initramfs,
            initramfs_digest=_digest(initramfs),
            rootfs=rootfs,
            rootfs_digest=_digest(rootfs),
            ext4_tool=Ext4ImageTool(
                executable=mke2fs,
                digest=_digest(mke2fs),
            ),
        ),
        None,
    )


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS Virtualization gate")
@pytest.mark.parametrize(
    "mode",
    [
        "success",
        "artifact_symlink",
        "cancel",
        "invalid_json",
        "failed",
        "scratch_enospc",
        "temporary_mount",
        "artifact_oversized",
        "memory_oom",
        "pids_limit",
        "escape_probe",
        "crash",
        "runtime_crash",
        "launcher_crash",
    ],
)
@pytest.mark.asyncio
async def test_macos_vm_runs_nonprivileged_worker_action_protocol(
    tmp_path: Path,
    mode: str,
) -> None:
    resources, asset_manifest = await _vm_resources(tmp_path)
    if mode in {"runtime_crash", "launcher_crash"} and not asset_manifest:
        pytest.skip("hard-crash recovery gate requires the packaged asset manifest")

    package = tmp_path / "package"
    entrypoint = package / "payload" / "worker"
    entrypoint.parent.mkdir(parents=True)
    go = shutil.which("go")
    if go is None:
        pytest.skip("Go toolchain is unavailable")
    await asyncio.to_thread(
        subprocess.run,
        [
            go,
            "build",
            "-trimpath",
            "-buildvcs=false",
            "-ldflags=-s -w -buildid=",
            "-o",
            str(entrypoint),
            str(WORKER),
        ],
        check=True,
        capture_output=True,
        env={
            "CGO_ENABLED": "0",
            "GOARCH": "arm64",
            "GOENV": "off",
            "GOOS": "linux",
            "GOPROXY": "off",
            "GOSUMDB": "off",
            "GOTELEMETRY": "off",
            "GOTOOLCHAIN": "local",
            "GOCACHE": str(tmp_path / "go-cache"),
            "HOME": str(tmp_path),
            "PATH": os.environ.get("PATH", ""),
            "TMPDIR": str(tmp_path),
        },
        timeout=120,
    )
    input_root = tmp_path / "input"
    input_root.mkdir()
    input_bytes = b"authorized input\n"
    (input_root / "probe.txt").write_bytes(input_bytes)
    extracted = tmp_path / "extracted"
    extracted.mkdir()
    invocation = {
        "schema_version": 1,
        "invocation_id": "inv_vm_gate",
        "operation_id": "op_vm_gate",
        "action": {
            "plugin_id": "dev.shejane.fixture.vm",
            "plugin_version": "0.1.0",
            "plugin_digest": "sha256:" + "c" * 64,
            "action_id": "probe.run",
        },
        "arguments": {},
        "inputs": [
            {
                "id": "probe",
                "path": "/input/probe.txt",
                "media_type": "text/plain",
                "size_bytes": len(input_bytes),
                "sha256": hashlib.sha256(input_bytes).hexdigest(),
            }
        ],
        "grants": {"capabilities": ["input.read", "artifact.write"]},
        "limits": {"timeout_ms": 90_000, "memory_mb": 64, "output_mb": 1},
        "environment": {"locale": "en-US", "timezone": "UTC"},
        "mode": mode,
    }
    if mode in {"scratch_enospc", "memory_oom"}:
        invocation["limits"]["memory_mb"] = 16
    host_sockets: list[socket.socket] = []
    host_unix_path: Path | None = None
    if mode == "escape_probe":
        host_secret = tmp_path / "host-secret.txt"
        host_credential = tmp_path / "host-credential.txt"
        host_secret.write_text("host-only-secret", encoding="utf-8")
        host_credential.write_text("host-only-credential", encoding="utf-8")
        host_unix_path = Path("/tmp") / f"shejane-host-ipc-{os.getpid()}-{time.time_ns()}.sock"
        unix_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        unix_socket.bind(str(host_unix_path))
        unix_socket.listen(1)
        tcp_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        tcp_socket.bind(("127.0.0.1", 0))
        tcp_socket.listen(1)
        host_sockets.extend((unix_socket, tcp_socket))
        invocation["host_probes"] = {
            "secret_path": str(host_secret),
            "credential_path": str(host_credential),
            "unix_socket_path": str(host_unix_path),
            "tcp_address": f"127.0.0.1:{tcp_socket.getsockname()[1]}",
            "host_pid": os.getpid(),
        }
    executor = ManagedWorkerActionExecutor(
        (str(entrypoint),),
        package_root=package,
        vm_resources=resources,
    )

    if mode in {"runtime_crash", "launcher_crash"}:
        invocation["mode"] = "cancel"
        invocation["limits"]["timeout_ms"] = 5_000
        invocation_file = tmp_path / "runtime-crash-invocation.json"
        invocation_file.write_text(json.dumps(invocation), encoding="utf-8")
        progress_marker = tmp_path / "runtime-crash-progress"
        runtime = await asyncio.create_subprocess_exec(
            sys.executable,
            str(RUNTIME_CRASH_DRIVER),
            str(Path(asset_manifest or "")),
            str(entrypoint),
            str(package),
            str(input_root),
            str(extracted),
            str(invocation_file),
            str(progress_marker),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            deadline = time.monotonic() + 30
            while not progress_marker.exists() and runtime.returncode is None:
                if time.monotonic() >= deadline:
                    pytest.fail("runtime crash driver did not reach the active VM")
                await asyncio.sleep(0.05)
            if runtime.returncode is not None:
                stdout, stderr = await runtime.communicate()
                pytest.fail(
                    "runtime crash driver exited early: "
                    f"{stdout.decode(errors='replace')}\n{stderr.decode(errors='replace')}"
                )
            assert list(tmp_path.glob("vm-invocation-*"))
            if mode == "runtime_crash":
                runtime.kill()
                await asyncio.wait_for(runtime.wait(), timeout=5)
            else:
                process_result = await asyncio.to_thread(
                    subprocess.run,
                    ["ps", "-axo", "pid=,ppid=,command="],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                processes = process_result.stdout.splitlines()
                launcher_pids = [
                    int(parts[0])
                    for line in processes
                    if len(parts := line.strip().split(maxsplit=2)) == 3
                    and int(parts[1]) == runtime.pid
                    and "shejane-managed-worker-vm" in parts[2]
                ]
                assert len(launcher_pids) == 1
                os.kill(launcher_pids[0], signal.SIGKILL)
                assert await asyncio.wait_for(runtime.wait(), timeout=10) != 0
            deadline = time.monotonic() + 10
            while list(tmp_path.glob("vm-invocation-*")):
                _reap_stale_vm_staging(tmp_path)
                if time.monotonic() >= deadline:
                    pytest.fail("orphaned VM staging lease was not recovered")
                await asyncio.sleep(0.05)
            assert not (extracted / "result.txt").exists()
        finally:
            if runtime.returncode is None:
                runtime.kill()
                await asyncio.wait_for(runtime.wait(), timeout=5)
        return

    if mode == "cancel":
        progress = asyncio.Event()
        task = asyncio.create_task(
            invoke_managed_worker(
                command=[str(entrypoint)],
                invocation=invocation,
                input_root=input_root,
                output_root=extracted,
                package_root=package,
                vm_resources=executor.vm_resources,
                on_progress=lambda _frame: progress.set(),
                cancel_grace_seconds=1,
            )
        )
        await asyncio.wait_for(progress.wait(), timeout=30)
        started = time.monotonic()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert time.monotonic() - started < 0.75
        assert not (extracted / "result.txt").exists()
        assert list(tmp_path.glob("vm-*")) == []
        return

    if mode in {"artifact_symlink", "artifact_oversized"}:
        with pytest.raises(WorkerProtocolError):
            await executor.invoke(
                invocation,
                input_root=input_root,
                output_root=extracted,
            )
        assert not (extracted / "result.txt").exists()
        assert list(tmp_path.glob("vm-*")) == []
        return

    if mode in {"invalid_json", "crash"}:
        with pytest.raises(WorkerProtocolError):
            await executor.invoke(
                invocation,
                input_root=input_root,
                output_root=extracted,
            )
        assert not (extracted / "result.txt").exists()
        assert list(tmp_path.glob("vm-*")) == []
        return

    if mode == "memory_oom":
        with pytest.raises(WorkerProtocolError, match="resource_exhausted"):
            await executor.invoke(
                invocation,
                input_root=input_root,
                output_root=extracted,
            )
        assert list(tmp_path.glob("vm-*")) == []
        return

    try:
        result = await executor.invoke(
            invocation,
            input_root=input_root,
            output_root=extracted,
        )
    finally:
        for host_socket in host_sockets:
            host_socket.close()
        if host_unix_path is not None:
            host_unix_path.unlink(missing_ok=True)
    if mode == "failed":
        assert result == {
            "invocation_id": "inv_vm_gate",
            "operation_id": "op_vm_gate",
            "status": "failed",
            "artifacts": [],
            "error": {"code": "fixture_failed"},
        }
        assert not (extracted / "result.txt").exists()
        assert list(tmp_path.glob("vm-*")) == []
        return
    if mode == "scratch_enospc":
        assert result["status"] == "succeeded"
        assert result["output"] == {"enospc": True}
        assert result["artifacts"] == []
        assert not (extracted / "fill.bin").exists()
        assert list(tmp_path.glob("vm-*")) == []
        return
    if mode == "temporary_mount":
        assert result["status"] == "succeeded"
        assert result["output"] == {
            "private": True,
            "rootfs_read_only": True,
            "scratch_backed": True,
            "temporary_noexec": True,
            "temporary_writable": True,
        }
        replay = await executor.invoke(
            invocation,
            input_root=input_root,
            output_root=extracted,
        )
        assert replay["output"] == result["output"]
        assert result["artifacts"] == []
        assert list(tmp_path.glob("vm-*")) == []
        return
    if mode == "pids_limit":
        assert result["status"] == "succeeded"
        assert result["output"] == {"pids_limited": True}
        assert result["artifacts"] == []
        assert list(tmp_path.glob("vm-*")) == []
        return
    if mode == "escape_probe":
        assert result["status"] == "succeeded"
        assert result["output"] == {
            "descendant_isolated": True,
            "external_network_isolated": True,
            "host_credentials_isolated": True,
            "host_files_isolated": True,
            "host_processes_isolated": True,
            "host_tcp_isolated": True,
            "host_unix_socket_isolated": True,
        }
        assert result["artifacts"] == []
        assert list(tmp_path.glob("vm-*")) == []
        return
    assert result == {
        "invocation_id": "inv_vm_gate",
        "operation_id": "op_vm_gate",
        "status": "succeeded",
        "output": {"text": "processed:authorized input\n"},
        "artifacts": [
            {
                "path": "/output/result.txt",
                "media_type": "text/plain",
                "name": "result.txt",
            }
        ],
    }
    assert (extracted / "result.txt").read_text(encoding="utf-8") == (
        "processed:authorized input\n"
    )
    assert list(tmp_path.glob("vm-*")) == []


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS Virtualization gate")
@pytest.mark.asyncio
async def test_macos_vm_runs_linux_arm64_python_worker(tmp_path: Path) -> None:
    frozen = _required_path("SHEJANE_TEST_LINUX_DOCUMENTS_WORKER")
    if not frozen.is_dir() or not (frozen / "documents-worker").is_file():
        pytest.skip("Linux Documents Worker must use the PyInstaller onedir layout")
    resources, _asset_manifest = await _vm_resources(tmp_path)
    package = tmp_path / "dynamic-package"
    payload = package / "payload"
    shutil.copytree(frozen, payload)
    entrypoint = payload / "documents-worker"
    input_root = tmp_path / "dynamic-input"
    output_root = tmp_path / "dynamic-output"
    input_root.mkdir()
    output_root.mkdir()
    invocation = {
        "schema_version": 1,
        "invocation_id": "inv_dynamic_python",
        "operation_id": "op_dynamic_python",
        "action": {
            "plugin_id": "org.shejane.documents",
            "plugin_digest": "sha256:" + "d" * 64,
            "action_id": "document.create",
        },
        "arguments": {
            "filename": "probe.docx",
            "blocks": [{"type": "paragraph", "text": "Dynamic Python worker"}],
        },
        "inputs": [],
        "grants": {"capabilities": []},
        "limits": {"timeout_ms": 30_000, "memory_mb": 512, "output_mb": 32},
    }

    result = await ManagedWorkerActionExecutor(
        (str(entrypoint),),
        package_root=package,
        vm_resources=resources,
    ).invoke(invocation, input_root=input_root, output_root=output_root)

    document = output_root / "probe.docx"
    assert result["status"] == "succeeded"
    assert result["artifacts"] == [
        {
            "path": "/output/probe.docx",
            "media_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "name": "probe.docx",
        }
    ]
    assert document.read_bytes().startswith(b"PK")
    assert list(tmp_path.glob("vm-*")) == []


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS Virtualization gate")
@pytest.mark.asyncio
async def test_macos_vm_runs_linux_arm64_node_worker(tmp_path: Path) -> None:
    source = _required_path("SHEJANE_TEST_NODE_RUNTIME_ASSET")
    runtime = RuntimeAssetStore(tmp_path / "runtime-data").install(source)
    resources, _asset_manifest = await _vm_resources(tmp_path)
    package = tmp_path / "node-package"
    package.mkdir()
    entrypoint = package / "node-worker"
    shutil.copy2(NODE_WORKER / "node-worker", entrypoint)
    shutil.copy2(NODE_WORKER / "worker.js", package / "worker.js")
    entrypoint.chmod(0o500)
    input_root = tmp_path / "node-input"
    output_root = tmp_path / "node-output"
    input_root.mkdir()
    output_root.mkdir()
    invocation = {
        "schema_version": 1,
        "invocation_id": "inv_dynamic_node",
        "operation_id": "op_dynamic_node",
        "action": {
            "plugin_id": "org.shejane.node-gate",
            "plugin_digest": "sha256:" + "e" * 64,
            "action_id": "node.probe",
        },
        "arguments": {},
        "inputs": [],
        "grants": {"capabilities": []},
        "limits": {"timeout_ms": 30_000, "memory_mb": 256, "output_mb": 16},
    }

    result = await ManagedWorkerActionExecutor(
        (str(entrypoint),),
        package_root=package,
        runtime_assets=(runtime,),
        vm_resources=resources,
    ).invoke(invocation, input_root=input_root, output_root=output_root)

    assert result == {
        "schema_version": 1,
        "invocation_id": "inv_dynamic_node",
        "operation_id": "op_dynamic_node",
        "status": "succeeded",
        "output": {
            "node_version": "v24.18.0",
            "runtime_asset_read_only": True,
            "uid": 65534,
        },
        "artifacts": [],
    }
    assert list(tmp_path.glob("vm-*")) == []


def _required_path(name: str) -> Path:
    value = os.environ.get(name)
    if not value:
        pytest.skip(f"{name} is not configured")
    try:
        path = Path(value).resolve(strict=True)
    except OSError:
        pytest.skip(f"{name} is unavailable")
    if not path.is_file() and not path.is_dir():
        pytest.skip(f"{name} is unavailable")
    return path


def _digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
