#!/usr/bin/env python3
"""Hold a packaged Managed Worker VM open so its Runtime can be SIGKILLed."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from shejane_runtime.plugins.macos_vm import load_macos_vm_resources
from shejane_runtime.plugins.managed_worker import invoke_managed_worker


async def main() -> None:
    if len(sys.argv) != 8:
        raise SystemExit("invalid runtime crash fixture arguments")
    manifest, entrypoint, package, input_root, output_root, invocation_file, marker = map(
        Path,
        sys.argv[1:],
    )
    invocation = json.loads(invocation_file.read_text(encoding="utf-8"))

    def mark_progress(_frame: dict[str, object]) -> None:
        marker.write_text("active\n", encoding="utf-8")

    await invoke_managed_worker(
        command=[str(entrypoint)],
        invocation=invocation,
        input_root=input_root,
        output_root=output_root,
        package_root=package,
        vm_resources=load_macos_vm_resources(manifest),
        on_progress=mark_progress,
    )
    raise SystemExit("runtime crash fixture returned before SIGKILL")


if __name__ == "__main__":
    asyncio.run(main())
