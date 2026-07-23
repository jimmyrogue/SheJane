"""Runtime-owned host adapter for the fixed Browser QA plugin."""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

from ..tools.web import _resolve_pinned, _validate_fetch_url
from .computer_use import ComputerUseError, ComputerUseService
from .executor import ActionExecutor
from .runtime_assets import RuntimeAssetHandle

BROWSER_QA_PLUGIN_ID = "org.shejane.browser-qa"
BROWSER_QA_PLUGIN_VERSION = "0.1.0"
MAX_PROXY_HEADER_BYTES = 64 * 1024


def windows_extended_path(path: Path | str, *, platform_name: str = os.name) -> str:
    value = str(path)
    if platform_name != "nt" or value.startswith("\\\\?\\"):
        return value
    if value.startswith("\\\\"):
        return "\\\\?\\UNC\\" + value.lstrip("\\")
    return "\\\\?\\" + value


def is_allowed_browser_qa_package(*, plugin_id: str, version: str, handler: str) -> bool:
    return (
        plugin_id == BROWSER_QA_PLUGIN_ID
        and version == BROWSER_QA_PLUGIN_VERSION
        and handler == "browser_qa"
    )


class BrowserQAError(ComputerUseError):
    pass


class _BrowserQACaller(Protocol):
    async def call(self, action: str, arguments: dict[str, Any], *, timeout_ms: int) -> Any: ...


class BrowserNetworkProxy:
    """Pin browser proxy connections to Runtime-validated public addresses."""

    def __init__(self) -> None:
        self._server: asyncio.Server | None = None
        self._connections: set[asyncio.StreamWriter] = set()

    @property
    def url(self) -> str:
        if self._server is None or not self._server.sockets:
            raise BrowserQAError("Browser QA network proxy is not running")
        port = int(self._server.sockets[0].getsockname()[1])
        return f"http://127.0.0.1:{port}"

    async def start(self) -> None:
        if self._server is None:
            self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._connections.add(writer)
        remote_writer: asyncio.StreamWriter | None = None
        try:
            header = await reader.readuntil(b"\r\n\r\n")
            if len(header) > MAX_PROXY_HEADER_BYTES:
                raise BrowserQAError("Browser QA proxy request is too large")
            lines = header.split(b"\r\n")
            method, target, version = lines[0].decode("ascii").split(" ", 2)
            if method.upper() == "CONNECT":
                host, port = _split_host_port(target, 443)
                ok, reason, address = _resolve_pinned(host, allow_fake_ip=port == 443)
                if not ok or address is None:
                    raise BrowserQAError(reason)
                remote_reader, remote_writer = await asyncio.open_connection(address, port)
                writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            else:
                parsed = urlsplit(target)
                if parsed.scheme != "http" or not parsed.hostname:
                    raise BrowserQAError("Browser QA proxy accepts HTTP or HTTPS only")
                ok, reason, address = _resolve_pinned(parsed.hostname)
                if not ok or address is None:
                    raise BrowserQAError(reason)
                port = parsed.port or 80
                remote_reader, remote_writer = await asyncio.open_connection(address, port)
                path = parsed.path or "/"
                if parsed.query:
                    path = f"{path}?{parsed.query}"
                forwarded = [f"{method} {path} {version}".encode("ascii")]
                forwarded.extend(
                    line
                    for line in lines[1:]
                    if not line.lower().startswith((b"proxy-connection:", b"connection:"))
                )
                remote_writer.write(b"\r\n".join(forwarded) + b"\r\n")
                await remote_writer.drain()
            await _relay_bidirectional(reader, writer, remote_reader, remote_writer)
        except (BrowserQAError, UnicodeError, ValueError, asyncio.IncompleteReadError) as exc:
            if not writer.is_closing():
                body = str(exc).encode("utf-8")[:1000]
                writer.write(
                    b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: "
                    + str(len(body)).encode("ascii")
                    + b"\r\n\r\n"
                    + body
                )
                with contextlib.suppress(ConnectionError):
                    await writer.drain()
        finally:
            if remote_writer is not None:
                remote_writer.close()
                with contextlib.suppress(ConnectionError):
                    await remote_writer.wait_closed()
            self._connections.discard(writer)
            writer.close()
            with contextlib.suppress(ConnectionError):
                await writer.wait_closed()

    async def aclose(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        for writer in tuple(self._connections):
            writer.close()
        await asyncio.gather(
            *(writer.wait_closed() for writer in tuple(self._connections)),
            return_exceptions=True,
        )
        self._connections.clear()


def _split_host_port(target: str, default_port: int) -> tuple[str, int]:
    parsed = urlsplit(f"//{target}")
    if not parsed.hostname or parsed.username or parsed.password:
        raise BrowserQAError("Browser QA proxy target is invalid")
    return parsed.hostname, parsed.port or default_port


async def _relay_bidirectional(
    client_reader: asyncio.StreamReader,
    client_writer: asyncio.StreamWriter,
    remote_reader: asyncio.StreamReader,
    remote_writer: asyncio.StreamWriter,
) -> None:
    async def pump(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        while chunk := await reader.read(64 * 1024):
            writer.write(chunk)
            await writer.drain()

    tasks = {
        asyncio.create_task(pump(client_reader, remote_writer)),
        asyncio.create_task(pump(remote_reader, client_writer)),
    }
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    await asyncio.gather(*done, *pending, return_exceptions=True)


class BrowserQAService(ComputerUseService):
    error_type = BrowserQAError
    service_name = "browser-qa"

    def __init__(
        self,
        package_root: Path,
        *,
        workspace_root: Path,
        profile_root: Path,
        runtime_asset: RuntimeAssetHandle,
        headless: bool = False,
    ) -> None:
        super().__init__(package_root, workspace_root=workspace_root)
        self._profile_root = profile_root.resolve(strict=False)
        self._profile_root.mkdir(parents=True, exist_ok=True)
        self._headless = headless
        self._runtime_asset = runtime_asset
        self._proxy = BrowserNetworkProxy()

    async def _ensure_process(self) -> asyncio.subprocess.Process:
        await self._proxy.start()
        return await super()._ensure_process()

    def _extra_environment(self) -> dict[str, str]:
        browsers = self._runtime_asset.payload / "browsers"
        return {
            "SHEJANE_BROWSER_QA_PROFILE": windows_extended_path(self._profile_root),
            "SHEJANE_BROWSER_QA_PROXY": self._proxy.url,
            "SHEJANE_BROWSER_QA_HEADLESS": "1" if self._headless else "0",
            "PLAYWRIGHT_BROWSERS_PATH": windows_extended_path(browsers),
        }

    async def aclose(self) -> None:
        process = self._process
        await super().aclose()
        if process is not None and os.name != "nt":
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(process.pid, signal.SIGKILL)
        await self._proxy.aclose()


class BrowserQAActionExecutor(ActionExecutor):
    def __init__(self, service: _BrowserQACaller, action_id: str) -> None:
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
        arguments = dict(invocation["arguments"])
        if self._action_id == "open":
            ok, reason = _validate_fetch_url(str(arguments.get("url") or ""))
            if not ok:
                raise BrowserQAError(reason)
        output = await self._service.call(
            self._action_id,
            arguments,
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
