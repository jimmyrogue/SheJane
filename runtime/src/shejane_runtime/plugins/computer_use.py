"""Runtime-owned host adapter for the first-party Computer Use plugin."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path
from typing import Any

from .executor import ActionExecutor

MAX_FRAME_BYTES = 24 * 1024 * 1024
COMPUTER_USE_PLUGIN_ID = "org.shejane.computer-use"
COMPUTER_USE_PLUGIN_VERSION = "0.1.0"
COMPUTER_USE_PLUGIN_DIGEST = (
    "sha256:3cf2a4089e37c325df9f61c20235c7e6a6a5979e81ff47e3319f588fafbedf55"
)


def is_allowed_computer_use_package(
    *, plugin_id: str, version: str, digest: str, handler: str
) -> bool:
    return (
        plugin_id == COMPUTER_USE_PLUGIN_ID
        and version == COMPUTER_USE_PLUGIN_VERSION
        and digest == COMPUTER_USE_PLUGIN_DIGEST
        and handler == "computer_use"
    )


class ComputerUseError(RuntimeError):
    pass


class ComputerUseService:
    def __init__(self, package_root: Path, *, workspace_root: Path) -> None:
        self._package_root = package_root.resolve(strict=True)
        self._workspace_root = workspace_root.resolve(strict=True)
        self._process: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._request_id = 0
        self._stderr = bytearray()
        self._stderr_task: asyncio.Task[None] | None = None

    async def call(self, action: str, arguments: dict[str, Any], *, timeout_ms: int) -> Any:
        async with self._lock:
            process = await self._ensure_process()
            assert process.stdin is not None and process.stdout is not None
            self._request_id += 1
            request_id = self._request_id
            frame = (
                json.dumps(
                    {"id": request_id, "action": action, "arguments": arguments},
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode()
                + b"\n"
            )
            if len(frame) > MAX_FRAME_BYTES:
                raise ComputerUseError("computer-use request exceeds the protocol limit")
            process.stdin.write(frame)
            await process.stdin.drain()
            try:
                raw = await asyncio.wait_for(
                    process.stdout.readline(), timeout=max(0.1, timeout_ms / 1000)
                )
            except TimeoutError:
                await self.aclose()
                raise ComputerUseError("computer-use action timed out") from None
            except ValueError:
                await self.aclose()
                raise ComputerUseError("computer-use response exceeds the protocol limit") from None
            if not raw:
                detail = self._stderr.decode(errors="replace").strip()
                await self.aclose()
                raise ComputerUseError(detail or "computer-use service exited unexpectedly")
            if len(raw) > MAX_FRAME_BYTES:
                await self.aclose()
                raise ComputerUseError("computer-use response exceeds the protocol limit")
            try:
                response = json.loads(raw)
            except json.JSONDecodeError as exc:
                await self.aclose()
                raise ComputerUseError("computer-use service returned invalid JSON") from exc
            if not isinstance(response, dict) or response.get("id") != request_id:
                await self.aclose()
                raise ComputerUseError("computer-use response identity changed")
            if isinstance(response.get("error"), dict):
                raise ComputerUseError(str(response["error"].get("message") or "action failed"))
            if "result" not in response:
                raise ComputerUseError("computer-use service omitted its result")
            return response["result"]

    async def _ensure_process(self) -> asyncio.subprocess.Process:
        if self._process is not None and self._process.returncode is None:
            return self._process
        bridge = self._package_root / "payload" / "bridge-server.mjs"
        if not bridge.is_file():
            raise ComputerUseError("computer-use bridge is missing from the plugin package")
        configured_node = os.environ.get("SHEJANE_RUNTIME_NODE_PATH", "").strip()
        node = configured_node or shutil.which("node") or ""
        if not node or not Path(node).is_file():
            raise ComputerUseError("computer-use requires the Runtime-provided Node.js executable")
        env = {
            key: os.environ[key]
            for key in ("HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE")
            if key in os.environ
        }
        env.update(
            {
                "ELECTRON_RUN_AS_NODE": "1",
                "SHEJANE_COMPUTER_USE_PACKAGE_ROOT": str(self._package_root),
                "SHEJANE_COMPUTER_USE_WORKSPACE": str(self._workspace_root),
            }
        )
        self._stderr.clear()
        self._process = await asyncio.create_subprocess_exec(
            node,
            bridge,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._workspace_root,
            env=env,
            start_new_session=os.name != "nt",
            limit=MAX_FRAME_BYTES + 1,
        )
        assert self._process.stderr is not None
        self._stderr_task = asyncio.create_task(self._capture_stderr(self._process.stderr))
        return self._process

    async def _capture_stderr(self, stream: asyncio.StreamReader) -> None:
        while chunk := await stream.read(4096):
            remaining = 64 * 1024 - len(self._stderr)
            if remaining > 0:
                self._stderr.extend(chunk[:remaining])

    async def aclose(self) -> None:
        process, self._process = self._process, None
        stderr_task, self._stderr_task = self._stderr_task, None
        if process is not None and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=1)
            except TimeoutError:
                process.kill()
                await process.wait()
        if stderr_task is not None:
            await asyncio.gather(stderr_task, return_exceptions=True)


class ComputerUseActionExecutor(ActionExecutor):
    def __init__(self, service: ComputerUseService, action_id: str) -> None:
        self._service = service
        self._action_id = action_id

    async def invoke(
        self,
        invocation: dict[str, Any],
        *,
        input_root: Path,
        output_root: Path,
        on_progress: Any = None,
    ) -> dict[str, Any]:
        del input_root, output_root, on_progress
        output = await self._service.call(
            self._action_id,
            dict(invocation["arguments"]),
            timeout_ms=int(invocation["limits"]["timeout_ms"]),
        )
        return {
            "schema_version": 1,
            "invocation_id": invocation["invocation_id"],
            "operation_id": invocation["operation_id"],
            "status": "succeeded",
            "output": output,
            "artifacts": [],
        }
