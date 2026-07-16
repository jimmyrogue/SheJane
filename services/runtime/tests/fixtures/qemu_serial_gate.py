#!/usr/bin/env python3
"""Exercise the Managed Worker Guest protocol over QEMU pipe chardevs."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import BinaryIO

_MIB = 1024 * 1024


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: qemu_serial_gate.py CONTROL_PIPE ARTIFACT_PIPE")
    control = open_pipe(Path(sys.argv[1]))
    artifact = open_pipe(Path(sys.argv[2]))
    try:
        assert read_frame(control[1]) == {
            "input_read_only": True,
            "package_read_only": True,
            "protocol_version": 1,
            "rootfs_read_only": True,
            "scratch_bytes": 64 * _MIB,
            "type": "ready",
        }
        write_frame(
            control[0],
            {
                "entrypoint": "worker",
                "memory_bytes": 64 * _MIB,
                "output_bytes": _MIB,
                "type": "configure",
            },
        )
        assert read_frame(control[1]) == {
            "cpu_max": "100000 100000",
            "memory_bytes": 64 * _MIB,
            "output_bytes": _MIB,
            "pids_max": 16,
            "type": "configured",
        }
        write_frame(
            control[0],
            request(
                1,
                "initialize",
                {
                    "protocol_version": 1,
                    "plugin_id": "dev.shejane.fixture.qemu",
                    "plugin_digest": "sha256:" + "c" * 64,
                    "actions": ["probe.run"],
                    "granted_capabilities": ["input.read", "artifact.write"],
                    "limits": {"timeout_ms": 60_000, "memory_mb": 64, "output_mb": 1},
                    "runtime_assets": [],
                },
            ),
        )
        assert read_frame(control[1])["result"]["sandboxed"] is True
        input_bytes = b"authorized input\n"
        invocation = {
            "schema_version": 1,
            "invocation_id": "inv_qemu_gate",
            "operation_id": "op_qemu_gate",
            "action": {
                "plugin_id": "dev.shejane.fixture.qemu",
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
            "limits": {"timeout_ms": 60_000, "memory_mb": 64, "output_mb": 1},
            "environment": {"locale": "en-US", "timezone": "UTC"},
            "mode": "temporary_mount",
        }
        write_frame(control[0], request(2, "invoke", invocation))
        result = read_frame(control[1])["result"]
        assert result["status"] == "succeeded"
        assert result["output"] == {
            "private": True,
            "rootfs_read_only": True,
            "scratch_backed": True,
            "temporary_noexec": True,
            "temporary_writable": True,
        }
        write_frame(control[0], request(3, "shutdown", {}))
        assert read_frame(control[1]) == {"id": 3, "jsonrpc": "2.0", "result": {}}
        assert read_frame(control[1]) == {"type": "stopped"}
    finally:
        for stream in (*control, *artifact):
            stream.close()
    print("qemu serial gate: ok")


def open_pipe(base: Path) -> tuple[BinaryIO, BinaryIO]:
    return base.with_suffix(".in").open("wb", buffering=0), base.with_suffix(".out").open(
        "rb", buffering=0
    )


def request(request_id: int, method: str, params: dict[str, object]) -> dict[str, object]:
    return {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}


def write_frame(stream: BinaryIO, frame: dict[str, object]) -> None:
    stream.write(json.dumps(frame, sort_keys=True, separators=(",", ":")).encode() + b"\n")


def read_frame(stream: BinaryIO) -> dict[str, object]:
    frame = stream.readline(_MIB + 1)
    if not frame or len(frame) > _MIB:
        raise RuntimeError("QEMU Guest protocol frame is invalid")
    value = json.loads(frame)
    if not isinstance(value, dict):
        raise RuntimeError("QEMU Guest protocol frame is invalid")
    return value


if __name__ == "__main__":
    main()
