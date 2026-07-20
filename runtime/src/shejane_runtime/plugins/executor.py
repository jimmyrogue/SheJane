"""Common ActionExecutor seam for both plugin execution kinds."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from functools import partial
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any, Protocol

from .linux_cgroup import LinuxCgroupResources
from .managed_worker import invoke_managed_worker
from .wasi import (
    WASI_MAX_BUFFERED_INPUT_BYTES,
    WasiProtocolError,
    WasiResourceLimitError,
    invoke_wasi_component,
)

if TYPE_CHECKING:
    from .macos_vm import MacOSVMResources
    from .runtime_assets import RuntimeAssetHandle


class ActionExecutor(Protocol):
    async def invoke(
        self,
        invocation: dict[str, Any],
        *,
        input_root: Path,
        output_root: Path,
        on_progress: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]: ...


@dataclass(frozen=True, slots=True)
class WasiActionExecutor:
    component_path: Path
    component_digest: str | None = None

    async def invoke(
        self,
        invocation: dict[str, Any],
        *,
        input_root: Path,
        output_root: Path,
        on_progress: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        inputs = await asyncio.to_thread(_read_authorized_inputs, invocation, input_root)
        return await asyncio.to_thread(
            partial(
                invoke_wasi_component,
                component_path=self.component_path,
                expected_component_digest=(
                    self.component_digest or str(invocation["action"]["plugin_digest"])
                ),
                invocation=invocation,
                inputs=inputs,
                output_root=output_root,
            )
        )


@dataclass(frozen=True, slots=True)
class ManagedWorkerActionExecutor:
    command: tuple[str, ...]
    sandbox_command: tuple[str, ...] | None = None
    linux_cgroup: LinuxCgroupResources | None = None
    vm_resources: MacOSVMResources | None = None
    package_root: Path | None = None
    runtime_assets: tuple[RuntimeAssetHandle, ...] = ()
    vision_handler: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]] | None = None

    async def invoke(
        self,
        invocation: dict[str, Any],
        *,
        input_root: Path,
        output_root: Path,
        on_progress: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        return await invoke_managed_worker(
            command=list(self.command),
            invocation=invocation,
            input_root=input_root,
            output_root=output_root,
            sandbox_command=self.sandbox_command,
            linux_cgroup=self.linux_cgroup,
            vm_resources=self.vm_resources,
            package_root=self.package_root,
            runtime_assets=self.runtime_assets,
            on_progress=on_progress,
            vision_handler=self.vision_handler,
        )


def _read_authorized_inputs(
    invocation: dict[str, Any],
    input_root: Path,
) -> dict[str, bytes]:
    input_root = input_root.resolve(strict=True)
    materialized: dict[str, bytes] = {}
    total_bytes = 0
    for reference in invocation["inputs"]:
        try:
            relative = PurePosixPath(str(reference["path"])).relative_to("/input")
        except (KeyError, ValueError) as exc:
            raise WasiProtocolError("input is outside /input") from exc
        if not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
            raise WasiProtocolError("input path is unsafe")
        candidate = input_root.joinpath(*relative.parts)
        current = input_root
        for part in relative.parts:
            current /= part
            if current.is_symlink():
                raise WasiProtocolError("input path contains a symlink")
        try:
            candidate.resolve(strict=True).relative_to(input_root)
        except (FileNotFoundError, ValueError) as exc:
            raise WasiProtocolError("input does not resolve inside /input") from exc
        if not candidate.is_file():
            raise WasiProtocolError("input is not a regular file")
        size = candidate.stat().st_size
        declared_size = reference.get("size_bytes")
        if not isinstance(declared_size, int) or isinstance(declared_size, bool):
            raise WasiProtocolError("input size is invalid")
        if size != declared_size:
            raise WasiProtocolError("authorized input size changed")
        total_bytes += size
        if total_bytes > WASI_MAX_BUFFERED_INPUT_BYTES:
            raise WasiResourceLimitError(
                "WASI buffered input limit exceeded; use a Managed Worker Action"
            )
        input_id = str(reference["id"])
        if input_id in materialized:
            raise WasiProtocolError("input id is duplicated")
        materialized[input_id] = candidate.read_bytes()
    return materialized
