"""LSP-style JSON-RPC 2.0 over Unix Domain Socket.

Bidirectional: a single endpoint can both serve incoming requests and
make outbound calls. Notifications (no id) get no reply. Each frame is:

    Content-Length: N\r\n
    \r\n
    {N bytes of JSON}
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import uuid4

log = logging.getLogger("rpc")

Handler = Callable[[dict[str, Any]], Awaitable[Any]]


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class RpcEndpoint:
    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        self._reader = reader
        self._writer = writer
        self._handlers: dict[str, Handler] = {}
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._write_lock = asyncio.Lock()
        self._closed = asyncio.Event()

    # --------- public API ---------

    def register(self, method: str, handler: Handler) -> None:
        self._handlers[method] = handler

    async def call(self, method: str, params: Any = None, timeout: float = 30.0) -> Any:
        req_id = uuid4().hex
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        await self._send({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(req_id, None)

    async def notify(self, method: str, params: Any = None) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})

    async def run(self) -> None:
        try:
            while not self._closed.is_set():
                msg = await self._read_message()
                if msg is None:
                    break
                asyncio.create_task(self._dispatch(msg))
        finally:
            self.close()

    def close(self) -> None:
        self._closed.set()
        try:
            self._writer.close()
        except Exception:
            pass
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(RpcError(-32000, "peer closed"))
        self._pending.clear()

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    # --------- internals ---------

    async def _send(self, msg: dict[str, Any]) -> None:
        body = json.dumps(msg, separators=(",", ":")).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        async with self._write_lock:
            self._writer.write(header + body)
            await self._writer.drain()

    async def _read_message(self) -> dict[str, Any] | None:
        headers: dict[str, str] = {}
        while True:
            line = await self._reader.readline()
            if not line:
                return None
            line = line.rstrip(b"\r\n")
            if not line:
                break
            try:
                key, value = line.decode("ascii").split(":", 1)
            except ValueError:
                continue
            headers[key.strip().lower()] = value.strip()
        length_s = headers.get("content-length")
        if length_s is None:
            return None
        length = int(length_s)
        body = await self._reader.readexactly(length)
        return json.loads(body.decode("utf-8"))

    async def _dispatch(self, msg: dict[str, Any]) -> None:
        # response to one of our outbound calls?
        if "id" in msg and ("result" in msg or "error" in msg) and "method" not in msg:
            fut = self._pending.get(msg["id"])
            if fut is None or fut.done():
                return
            if "error" in msg:
                err = msg["error"]
                fut.set_exception(RpcError(err.get("code", -32000), err.get("message", ""), err.get("data")))
            else:
                fut.set_result(msg.get("result"))
            return

        # incoming request or notification
        method = msg.get("method")
        params = msg.get("params")
        req_id = msg.get("id")
        handler = self._handlers.get(method or "")

        if handler is None:
            if req_id is not None:
                await self._send(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {"code": -32601, "message": f"method not found: {method}"},
                    }
                )
            else:
                log.warning("unhandled notification: %s", method)
            return

        try:
            result = await handler(params or {})
        except RpcError as e:
            if req_id is not None:
                await self._send(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {"code": e.code, "message": e.message, "data": e.data},
                    }
                )
            return
        except Exception as e:
            log.exception("handler %s raised", method)
            if req_id is not None:
                await self._send(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {"code": -32000, "message": str(e)},
                    }
                )
            return

        if req_id is not None:
            await self._send({"jsonrpc": "2.0", "id": req_id, "result": result})
