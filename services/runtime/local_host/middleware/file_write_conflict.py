"""Reduce avoidable ``read_file`` and ``write_file`` model loops."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from pathlib import PurePosixPath
from typing import Any

from langchain.agents.middleware import AgentMiddleware, ToolCallRequest
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.types import Command

from ..tools.user import ask_user

FILE_EXISTS_CODE = "file_exists"
FILE_EXISTS_ACTIONS = ["choose_new_path", "read_then_edit", "ask_user"]
FILE_EXISTS_OPTIONS = ["自动换名", "覆盖原文件", "取消写入"]
DEFAULT_READ_LIMIT = 2000


class FileWriteConflictMiddleware(AgentMiddleware):
    """Make common file operations complete without avoidable model loops.

    Plain reads default to the backend's full 2,000-line window. The first
    create collision includes an available path for the model. Repeating the
    same path pauses for explicit user intent instead of failing again.
    """

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        tool_name = request.tool_call.get("name")
        if tool_name not in {"write_file", "read_file", "edit_file"}:
            return await handler(request)

        arguments = request.tool_call.get("args") or {}
        file_path = arguments.get("file_path")
        if not isinstance(file_path, str):
            return await handler(request)

        if tool_name == "read_file" and "offset" not in arguments and "limit" not in arguments:
            arguments = {**arguments, "limit": DEFAULT_READ_LIMIT}
            request = request.override(tool_call={**request.tool_call, "args": arguments})

        messages = request.state.get("messages", []) if isinstance(request.state, dict) else []
        renamed_path = _renamed_path(messages, file_path)
        if renamed_path:
            if tool_name == "write_file":
                return _success_message(
                    request,
                    {
                        "ok": True,
                        "action": "already_renamed",
                        "original_path": file_path,
                        "path": renamed_path,
                        "message": f"文件名冲突已处理，请继续使用 {renamed_path}",
                    },
                )
            redirected = request.override(
                tool_call={
                    **request.tool_call,
                    "args": {**arguments, "file_path": renamed_path},
                }
            )
            return await handler(redirected)

        content = arguments.get("content")
        if tool_name != "write_file" or not isinstance(content, str):
            return await handler(request)

        if _same_path_conflict(messages, file_path):
            answer = ask_user(f"{file_path} 已存在，如何处理？", FILE_EXISTS_OPTIONS)
            if answer == "自动换名":
                return await _write_with_available_name(request, file_path, content)
            if answer == "覆盖原文件":
                return await _replace_existing_file(request, file_path, content)
            return _success_message(
                request,
                {
                    "ok": True,
                    "action": "canceled",
                    "path": file_path,
                    "message": f"已取消写入 {file_path}",
                },
            )

        result = await handler(request)
        if isinstance(result, ToolMessage) and _is_file_exists_result(result):
            suggested_path = await _available_path(request, file_path)
            return ToolMessage(
                content=json.dumps(
                    {
                        "ok": False,
                        "error_code": FILE_EXISTS_CODE,
                        "path": file_path,
                        "message": str(result.content),
                        "recoverable": True,
                        "retryable": False,
                        "allowed_actions": FILE_EXISTS_ACTIONS,
                        **({"suggested_path": suggested_path} if suggested_path else {}),
                    },
                    ensure_ascii=False,
                ),
                tool_call_id=str(request.tool_call.get("id") or result.tool_call_id),
                name="write_file",
                status="error",
            )
        return result


def _same_path_conflict(messages: Any, file_path: str) -> bool:
    if not isinstance(messages, list):
        return False
    turn_messages: list[Any] = []
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            break
        turn_messages.append(message)
    for message in turn_messages:
        if not isinstance(message, ToolMessage) or message.name != "write_file":
            continue
        envelope = _json_object(message.content)
        if (
            envelope
            and envelope.get("error_code") == FILE_EXISTS_CODE
            and envelope.get("path") == file_path
        ):
            return True
    return False


def _renamed_path(messages: Any, file_path: str) -> str | None:
    if not isinstance(messages, list):
        return None
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            break
        if not isinstance(message, ToolMessage) or message.name != "write_file":
            continue
        envelope = _json_object(message.content)
        if (
            envelope
            and envelope.get("ok") is True
            and envelope.get("action") == "renamed"
            and envelope.get("original_path") == file_path
            and isinstance(envelope.get("path"), str)
        ):
            return envelope["path"]
    return None


def _is_file_exists_result(result: ToolMessage) -> bool:
    if getattr(result, "status", None) != "error":
        return False
    content = str(result.content)
    return "Cannot write to " in content and " because it already exists" in content


def _json_object(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


async def _write_with_available_name(
    request: ToolCallRequest,
    file_path: str,
    content: str,
) -> ToolMessage:
    backend = _backend(request)
    path = PurePosixPath(file_path)
    suffix = path.suffix
    stem = path.name[: -len(suffix)] if suffix else path.name
    for index in range(2, 1002):
        candidate = str(path.with_name(f"{stem}-{index}{suffix}"))
        result = await backend.awrite(candidate, content)
        if not result.error:
            return _success_message(
                request,
                {
                    "ok": True,
                    "action": "renamed",
                    "original_path": file_path,
                    "path": result.path or candidate,
                    "message": f"已写入 {result.path or candidate}",
                },
            )
        if "already exists" not in result.error:
            return _error_message(request, candidate, result.error)
    return _error_message(request, file_path, "无法找到可用的新文件名")


async def _available_path(request: ToolCallRequest, file_path: str) -> str | None:
    backend = _backend(request)
    path = PurePosixPath(file_path)
    suffix = path.suffix
    stem = path.name[: -len(suffix)] if suffix else path.name
    for index in range(2, 1002):
        candidate = str(path.with_name(f"{stem}-{index}{suffix}"))
        existing = (await backend.adownload_files([candidate]))[0]
        if existing.error == "file_not_found":
            return candidate
        if existing.error:
            return None
    return None


async def _replace_existing_file(
    request: ToolCallRequest,
    file_path: str,
    content: str,
) -> ToolMessage:
    backend = _backend(request)
    downloaded = (await backend.adownload_files([file_path]))[0]
    if downloaded.error or downloaded.content is None:
        return _error_message(request, file_path, downloaded.error or "无法读取原文件")
    try:
        current = downloaded.content.decode("utf-8")
    except UnicodeDecodeError:
        return _error_message(request, file_path, "原文件不是 UTF-8 文本，无法安全覆盖")
    result = await backend.aedit(file_path, current, content)
    if result.error:
        return _error_message(request, file_path, result.error)
    return _success_message(
        request,
        {
            "ok": True,
            "action": "replaced",
            "path": result.path or file_path,
            "message": f"已覆盖 {result.path or file_path}",
        },
    )


def _backend(request: ToolCallRequest) -> Any:
    backend = getattr(getattr(request.runtime, "context", None), "backend", None)
    if backend is None:
        raise RuntimeError("agent workspace backend is not bound")
    return backend


def _success_message(request: ToolCallRequest, payload: dict[str, Any]) -> ToolMessage:
    return ToolMessage(
        content=json.dumps(payload, ensure_ascii=False),
        tool_call_id=str(request.tool_call.get("id") or ""),
        name="write_file",
    )


def _error_message(request: ToolCallRequest, file_path: str, message: str) -> ToolMessage:
    return ToolMessage(
        content=json.dumps(
            {
                "ok": False,
                "error_code": "file_write_failed",
                "path": file_path,
                "message": message,
                "recoverable": True,
                "retryable": False,
            },
            ensure_ascii=False,
        ),
        tool_call_id=str(request.tool_call.get("id") or ""),
        name="write_file",
        status="error",
    )
