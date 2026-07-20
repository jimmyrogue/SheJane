from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import shutil
import socket
import sys
from pathlib import Path

import pytest

from shejane_runtime.plugins.executor import ManagedWorkerActionExecutor
from shejane_runtime.plugins.linux_cgroup import (
    LinuxCgroupResources,
    load_linux_cgroup_resources,
)
from shejane_runtime.plugins.managed_worker import WorkerProtocolError
from shejane_runtime.plugins.platforms import current_managed_worker_platform


def _linux_resources(*, bubblewrap: bool) -> LinuxCgroupResources | None:
    manifest = os.environ.get("SHEJANE_TEST_LINUX_ASSET_MANIFEST")
    if manifest:
        resources = load_linux_cgroup_resources(
            Path(manifest),
            host_platform=current_managed_worker_platform() or "unsupported",
        )
        if bubblewrap:
            return resources
        return LinuxCgroupResources(
            launcher=resources.launcher,
            delegated_root=resources.delegated_root,
        )
    launcher = os.environ.get("SHEJANE_TEST_LINUX_CGROUP_LAUNCHER")
    cgroup_root = os.environ.get("SHEJANE_TEST_LINUX_CGROUP_ROOT")
    bwrap = os.environ.get("SHEJANE_TEST_LINUX_BUBBLEWRAP")
    if not launcher or not cgroup_root or (bubblewrap and not bwrap):
        return None
    return LinuxCgroupResources(
        launcher=Path(launcher),
        delegated_root=Path(cgroup_root),
        bubblewrap=Path(bwrap) if bubblewrap and bwrap else None,
    )


def test_linux_assets_bind_to_a_systemd_delegated_parent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime_root = tmp_path / "runtime" / "_internal"
    assets = runtime_root / "managed-worker-linux"
    assets.mkdir(parents=True)
    launcher = runtime_root / "shejane-managed-worker-linux"
    bubblewrap = assets / "shejane-bwrap"
    launcher.write_bytes(b"launcher")
    bubblewrap.write_bytes(b"bubblewrap")
    launcher.chmod(0o700)
    bubblewrap.chmod(0o700)
    files = {}
    for name, content in {
        "shejane-bwrap": b"bubblewrap",
        "libcap.so.2": b"libcap",
        "COPYING.bubblewrap": b"copying",
        "copyright.libcap": b"copyright",
    }.items():
        path = assets / name
        path.write_bytes(content)
        files[name] = {
            "sha256": hashlib.sha256(content).hexdigest(),
            "size_bytes": len(content),
        }
    manifest = assets / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "version": "0.11.2",
                "setuid": False,
                "files": files,
            }
        )
    )

    cgroup_mount = tmp_path / "cgroup"
    delegated = cgroup_mount / "shejane.service"
    supervisor = delegated / "supervisor"
    supervisor.mkdir(parents=True)
    (delegated / "cgroup.controllers").write_text("cpu memory pids\n")
    subtree_control = delegated / "cgroup.subtree_control"
    subtree_control.write_text("cpu memory pids\n")
    proc_cgroup = tmp_path / "proc-self-cgroup"
    proc_cgroup.write_text("0::/shejane.service/supervisor\n")

    def delegated_xattr(path: Path | str, name: str) -> bytes:
        if Path(path) == delegated and name == "user.delegate":
            return b"1"
        raise OSError

    monkeypatch.setattr(os, "getxattr", delegated_xattr, raising=False)
    resources = load_linux_cgroup_resources(
        manifest,
        host_platform="linux/arm64",
        proc_cgroup=proc_cgroup,
        cgroup_mount=cgroup_mount,
    )

    assert resources == LinuxCgroupResources(
        launcher=launcher,
        delegated_root=delegated,
        bubblewrap=bubblewrap,
    )
    assert subtree_control.read_text() == "cpu memory pids\n"


@pytest.mark.asyncio
@pytest.mark.skipif(sys.platform != "linux", reason="Linux native sandbox conformance")
async def test_linux_native_sandbox_isolates_access_and_bounded_scratch(
    tmp_path: Path,
) -> None:
    resources = _linux_resources(bubblewrap=True)
    fixture = os.environ.get("SHEJANE_TEST_LINUX_SANDBOX_WORKER")
    if resources is None or not fixture:
        pytest.skip("packaged Linux sandbox launcher, bubblewrap, or fixture unavailable")

    package_root = tmp_path / "package"
    input_root = tmp_path / "input"
    output_root = tmp_path / "output"
    package_root.mkdir()
    input_root.mkdir()
    output_root.mkdir()
    worker = package_root / "worker"
    shutil.copy2(fixture, worker)
    worker.chmod(0o700)
    (input_root / "probe.txt").write_text("authorized input\n")
    secret = tmp_path / "host-secret.txt"
    secret.write_text("must stay private")
    credential = Path.home() / ".ssh" / "id_ed25519"
    unix_path = tmp_path / "host.sock"

    with (
        socket.socket(socket.AF_INET, socket.SOCK_STREAM) as tcp_server,
        socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as unix_server,
    ):
        tcp_server.bind(("127.0.0.1", 0))
        tcp_server.listen()
        unix_server.bind(str(unix_path))
        unix_server.listen()
        result = await ManagedWorkerActionExecutor(
            (str(worker),),
            package_root=package_root,
            linux_cgroup=resources,
        ).invoke(
            {
                "schema_version": 1,
                "invocation_id": "923e4567-e89b-42d3-a456-426614174008",
                "operation_id": "run_01:linux.sandbox:001",
                "action": {
                    "plugin_id": "dev.shejane.fixture.linux-sandbox",
                    "plugin_version": "0.1.0",
                    "plugin_digest": "sha256:" + "d" * 64,
                    "action_id": "linux.sandbox",
                },
                "arguments": {},
                "grants": {"capabilities": ["input.read", "artifact.write"]},
                "limits": {"timeout_ms": 10_000, "memory_mb": 64, "output_mb": 1},
                "inputs": [],
                "host_probes": {
                    "secret_path": str(secret),
                    "credential_path": str(credential),
                    "unix_socket_path": str(unix_path),
                    "tcp_address": f"127.0.0.1:{tcp_server.getsockname()[1]}",
                    "host_pid": os.getpid(),
                    "host_process_cmdline": base64.b64encode(
                        Path(f"/proc/{os.getpid()}/cmdline").read_bytes()
                    ).decode("ascii"),
                },
                "mode": "linux_native_gate",
            },
            input_root=input_root,
            output_root=output_root,
        )

    assert result["output"] == {
        "access_isolated": True,
        "scratch_enospc": True,
    }
    assert (output_root / "result.txt").read_text() == "processed:authorized input\n"
    assert not (output_root / "fill.bin").exists()


@pytest.mark.asyncio
@pytest.mark.skipif(sys.platform != "linux", reason="Linux cgroup v2 conformance")
async def test_linux_cgroup_kills_memory_exhaustion_and_reaps_leaf(tmp_path: Path) -> None:
    resources = _linux_resources(bubblewrap=False)
    if resources is None:
        pytest.skip("packaged Linux cgroup launcher or delegated root unavailable")

    package_root = tmp_path / "package"
    input_root = tmp_path / "input"
    output_root = tmp_path / "output"
    package_root.mkdir()
    input_root.mkdir()
    output_root.mkdir()
    worker = package_root / "worker.py"
    worker.write_text(
        """
import json
import sys

json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","id":1,"result":{"protocol_version":1,"process_isolated":True,"access_isolated":False,"resource_isolated":False,"sandboxed":False}}), flush=True)
json.loads(sys.stdin.readline())
memory = bytearray(256 * 1024 * 1024)
print(len(memory), flush=True)
""".strip()
    )

    executor = ManagedWorkerActionExecutor(
        (sys.executable, str(worker)),
        package_root=package_root,
        linux_cgroup=resources,
    )
    with pytest.raises(WorkerProtocolError, match="closed stdout before responding"):
        await executor.invoke(
            {
                "invocation_id": "723e4567-e89b-42d3-a456-426614174006",
                "operation_id": "run_01:linux.memory:001",
                "action": {
                    "plugin_id": "dev.shejane.fixture.linux-memory",
                    "plugin_digest": "sha256:" + "d" * 64,
                    "action_id": "linux.memory",
                },
                "grants": {"capabilities": []},
                "limits": {"timeout_ms": 5_000, "memory_mb": 32, "output_mb": 1},
                "inputs": [],
            },
            input_root=input_root,
            output_root=output_root,
        )

    assert not tuple(resources.delegated_root.glob("shejane-*"))


@pytest.mark.asyncio
@pytest.mark.skipif(sys.platform != "linux", reason="Linux cgroup v2 conformance")
async def test_linux_cgroup_cancellation_reaps_ignored_descendants(tmp_path: Path) -> None:
    resources = _linux_resources(bubblewrap=False)
    if resources is None:
        pytest.skip("packaged Linux cgroup launcher or delegated root unavailable")

    package_root = tmp_path / "package"
    input_root = tmp_path / "input"
    output_root = tmp_path / "output"
    package_root.mkdir()
    input_root.mkdir()
    output_root.mkdir()
    worker = package_root / "worker.py"
    worker.write_text(
        """
import json
import os
import time
import sys

json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","id":1,"result":{"protocol_version":1,"process_isolated":True,"access_isolated":False,"resource_isolated":False,"sandboxed":False}}), flush=True)
json.loads(sys.stdin.readline())
open(os.environ["SHEJANE_PLUGIN_OUTPUT_ROOT"] + "/started", "w").close()
if os.fork() == 0:
    time.sleep(60)
    raise SystemExit(0)
time.sleep(60)
""".strip()
    )
    executor = ManagedWorkerActionExecutor(
        (sys.executable, str(worker)),
        package_root=package_root,
        linux_cgroup=resources,
    )
    task = asyncio.create_task(
        executor.invoke(
            {
                "invocation_id": "823e4567-e89b-42d3-a456-426614174007",
                "operation_id": "run_01:linux.cancel:001",
                "action": {
                    "plugin_id": "dev.shejane.fixture.linux-cancel",
                    "plugin_digest": "sha256:" + "d" * 64,
                    "action_id": "linux.cancel",
                },
                "grants": {"capabilities": []},
                "limits": {"timeout_ms": 5_000, "memory_mb": 64, "output_mb": 1},
                "inputs": [],
            },
            input_root=input_root,
            output_root=output_root,
        )
    )
    for _ in range(100):
        if (output_root / "started").exists():
            break
        await asyncio.sleep(0.01)
    assert (output_root / "started").is_file()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0.1)

    assert not tuple(resources.delegated_root.glob("shejane-*"))
