from __future__ import annotations

import pytest

from shejane_runtime.plugins.sandbox_contract import (
    SandboxEvidence,
    SandboxLimits,
    managed_worker_execution_platform,
    planned_sandbox_backend,
)
from shejane_runtime.plugins.sandbox_runtime import SandboxRuntimeError


def test_sandbox_limits_derive_hard_tree_and_scratch_budgets() -> None:
    limits = SandboxLimits.from_action_limits(
        {"timeout_ms": 60_000, "memory_mb": 512, "output_mb": 128}
    )

    assert limits.wall_time_ms == 60_000
    assert limits.cpu_time_ms == 60_000
    assert limits.memory_bytes == 512 * 1024 * 1024
    assert limits.process_count == 16
    assert limits.output_bytes == 128 * 1024 * 1024
    assert limits.scratch_bytes == 1024 * 1024 * 1024
    assert limits.protocol_frame_bytes == 1024 * 1024


def test_sandbox_evidence_is_host_owned_and_requires_both_isolation_layers() -> None:
    access_only = SandboxEvidence(
        host_platform="darwin/arm64",
        execution_platform="darwin/arm64",
        backend_id="anthropic_srt_0.0.65",
        policy_digest="sha256:" + "a" * 64,
        process_isolated=True,
        access_isolated=True,
        resource_isolated=False,
        proofs=("filesystem_policy", "network_denial"),
    )

    assert access_only.sandboxed is False
    with pytest.raises(SandboxRuntimeError, match="hard sandbox evidence"):
        access_only.require_sandboxed()

    complete = SandboxEvidence(
        host_platform="linux/amd64",
        execution_platform="linux/amd64",
        backend_id="linux_native_v1",
        policy_digest="sha256:" + "b" * 64,
        process_isolated=True,
        access_isolated=True,
        resource_isolated=True,
        proofs=("cgroup_v2", "sized_tmpfs", "seccomp", "namespaces"),
    )
    assert complete.sandboxed is True
    complete.require_sandboxed()


def test_sandbox_backend_plan_is_explicit_per_platform() -> None:
    assert planned_sandbox_backend("linux/amd64") == "linux_native_v1"
    assert planned_sandbox_backend("windows/arm64") == "windows_qemu_linux_vm_v1"
    assert planned_sandbox_backend("darwin/arm64") == "darwin_vf_linux_vm_v1"
    assert managed_worker_execution_platform("darwin/arm64") == "linux/arm64"
    assert managed_worker_execution_platform("darwin/amd64") == "linux/amd64"
    assert managed_worker_execution_platform("linux/arm64") == "linux/arm64"
    assert managed_worker_execution_platform("windows/amd64") == "linux/amd64"
    with pytest.raises(SandboxRuntimeError, match="unsupported"):
        planned_sandbox_backend("plan9/mips")
