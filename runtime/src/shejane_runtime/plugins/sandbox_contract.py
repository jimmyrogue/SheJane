"""Host-owned limits and evidence shared by every Managed Worker sandbox backend."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .platforms import managed_worker_execution_platform as managed_worker_execution_platform
from .sandbox_runtime import SandboxRuntimeError

_MIB = 1024 * 1024
_MAX_SCRATCH_BYTES = 8 * 1024 * _MIB
_POLICY_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


@dataclass(frozen=True)
class SandboxLimits:
    wall_time_ms: int
    cpu_time_ms: int
    memory_bytes: int
    process_count: int
    scratch_bytes: int
    output_bytes: int
    stdout_bytes: int = _MIB
    stderr_bytes: int = 64 * 1024
    protocol_frame_bytes: int = _MIB

    @classmethod
    def from_action_limits(cls, limits: dict[str, Any]) -> SandboxLimits:
        try:
            wall_time_ms = int(limits["timeout_ms"])
            memory_bytes = int(limits["memory_mb"]) * _MIB
            output_bytes = int(limits["output_mb"]) * _MIB
        except (KeyError, TypeError, ValueError) as exc:
            raise SandboxRuntimeError("managed worker limits are invalid") from exc
        if wall_time_ms < 100 or memory_bytes < 16 * _MIB or output_bytes < _MIB:
            raise SandboxRuntimeError("managed worker limits are invalid")
        return cls(
            wall_time_ms=wall_time_ms,
            cpu_time_ms=wall_time_ms,
            memory_bytes=memory_bytes,
            process_count=16,
            scratch_bytes=min(_MAX_SCRATCH_BYTES, max(output_bytes, memory_bytes * 2)),
            output_bytes=output_bytes,
        )


@dataclass(frozen=True)
class SandboxEvidence:
    host_platform: str
    execution_platform: str
    backend_id: str
    policy_digest: str
    process_isolated: bool
    access_isolated: bool
    resource_isolated: bool
    proofs: tuple[str, ...]

    def __post_init__(self) -> None:
        if not self.host_platform or not self.execution_platform or not self.backend_id:
            raise SandboxRuntimeError("managed worker sandbox identity is invalid")
        if _POLICY_DIGEST.fullmatch(self.policy_digest) is None:
            raise SandboxRuntimeError("managed worker sandbox policy digest is invalid")
        if not self.proofs or len(self.proofs) != len(set(self.proofs)):
            raise SandboxRuntimeError("managed worker sandbox proofs are invalid")

    @property
    def sandboxed(self) -> bool:
        return self.process_isolated and self.access_isolated and self.resource_isolated

    def require_sandboxed(self) -> None:
        if not self.sandboxed:
            raise SandboxRuntimeError("managed worker hard sandbox evidence is incomplete")


def planned_sandbox_backend(target_platform: str) -> str:
    if target_platform.startswith("linux/"):
        return "linux_native_v1"
    if target_platform.startswith("windows/"):
        return "windows_qemu_linux_vm_v1"
    if target_platform.startswith("darwin/"):
        return "darwin_vf_linux_vm_v1"
    raise SandboxRuntimeError("managed worker sandbox target is unsupported")
