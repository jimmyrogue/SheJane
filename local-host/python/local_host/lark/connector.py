from __future__ import annotations

import asyncio
import json
import os
import platform
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

ConnectorSource = Literal["bundled", "system", "missing"]
LARK_IM_USER_SCOPES = [
    "im:chat:read",
    "im:message.group_msg:get_as_user",
    "im:message.p2p_msg:get_as_user",
    "im:message.reactions:read",
    "contact:user.base:readonly",
]
_BACKGROUND_TASKS: set[asyncio.Task[None]] = set()


def _track_background_task(task: asyncio.Task[None]) -> None:
    _BACKGROUND_TASKS.add(task)

    def forget(completed: asyncio.Task[None]) -> None:
        _BACKGROUND_TASKS.discard(completed)
        try:
            completed.result()
        except (asyncio.CancelledError, Exception):
            pass

    task.add_done_callback(forget)


class LarkAuthRequiredError(RuntimeError):
    pass


@dataclass(frozen=True)
class LarkConnectorStatus:
    available: bool
    source: ConnectorSource
    executable_path: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "available": self.available,
            "source": self.source,
            "executable_path": self.executable_path,
        }


@dataclass(frozen=True)
class ConnectorCommandResult:
    returncode: int
    stdout: str
    stderr: str


@dataclass(frozen=True)
class LarkAuthStatus:
    status: Literal["disconnected", "needs_auth", "connected", "error"]
    tenant_label: str = ""
    account_label: str = ""
    last_error_code: str = ""


@dataclass(frozen=True)
class LarkLoginResult:
    status: Literal["needs_auth", "connected", "error"]
    authorization_url: str | None = None
    device_code: str | None = None
    last_error_code: str = ""


@dataclass(frozen=True)
class LarkLogoutResult:
    status: Literal["disconnected", "error"]
    last_error_code: str = ""


@dataclass(frozen=True)
class LarkFetchedSource:
    provider_source_id: str
    source_type: Literal["p2p", "group", "thread"]
    display_label: str = ""


@dataclass(frozen=True)
class LarkFetchedMessage:
    source_provider_id: str
    provider_message_id: str
    sender_id: str = ""
    message_type: str = "text"
    created_at_lark: str | None = None
    raw: dict[str, object] | None = None


@dataclass(frozen=True)
class LarkMessageSnapshot:
    sources: list[LarkFetchedSource]
    messages: list[LarkFetchedMessage]


class LarkCommandRunner(Protocol):
    async def run(
        self,
        executable_path: str,
        args: list[str],
        *,
        timeout_seconds: float,
    ) -> ConnectorCommandResult: ...

    async def run_until_url(
        self,
        executable_path: str,
        args: list[str],
        *,
        timeout_seconds: float,
    ) -> ConnectorCommandResult: ...


class SubprocessLarkCommandRunner:
    async def run(
        self,
        executable_path: str,
        args: list[str],
        *,
        timeout_seconds: float,
    ) -> ConnectorCommandResult:
        proc = await asyncio.create_subprocess_exec(
            executable_path,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout_seconds)
        except TimeoutError:
            proc.kill()
            await proc.communicate()
            return ConnectorCommandResult(
                returncode=124,
                stdout="",
                stderr="lark-cli command timed out",
            )
        return ConnectorCommandResult(
            returncode=proc.returncode or 0,
            stdout=stdout.decode("utf-8", errors="replace"),
            stderr=stderr.decode("utf-8", errors="replace"),
        )

    async def run_until_url(
        self,
        executable_path: str,
        args: list[str],
        *,
        timeout_seconds: float,
    ) -> ConnectorCommandResult:
        proc = await asyncio.create_subprocess_exec(
            executable_path,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_chunks: list[str] = []
        stderr_chunks: list[str] = []
        url_queue: asyncio.Queue[str] = asyncio.Queue(maxsize=1)

        async def read_stream(
            stream: asyncio.StreamReader | None,
            chunks: list[str],
        ) -> None:
            if stream is None:
                return
            while True:
                line = await stream.readline()
                if not line:
                    return
                text = line.decode("utf-8", errors="replace")
                chunks.append(text)
                if not url_queue.empty():
                    continue
                output = "".join(stdout_chunks + stderr_chunks)
                url = _first_url(output)
                if url:
                    url_queue.put_nowait(url)

        stdout_task = asyncio.create_task(read_stream(proc.stdout, stdout_chunks))
        stderr_task = asyncio.create_task(read_stream(proc.stderr, stderr_chunks))
        url_task = asyncio.create_task(url_queue.get())
        wait_task = asyncio.create_task(proc.wait())
        try:
            done, _ = await asyncio.wait(
                {url_task, wait_task},
                timeout=timeout_seconds,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if url_task in done:
                wait_task.cancel()
                _track_background_task(
                    asyncio.create_task(_drain_lark_process(proc, stdout_task, stderr_task))
                )
                return ConnectorCommandResult(
                    returncode=0,
                    stdout="".join(stdout_chunks),
                    stderr="".join(stderr_chunks),
                )
            if wait_task in done:
                await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
                return ConnectorCommandResult(
                    returncode=proc.returncode or 0,
                    stdout="".join(stdout_chunks),
                    stderr="".join(stderr_chunks),
                )
            proc.kill()
            await proc.wait()
            await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
            return ConnectorCommandResult(
                returncode=124,
                stdout="".join(stdout_chunks),
                stderr="".join(stderr_chunks) or "lark-cli command timed out",
            )
        finally:
            if not url_task.done():
                url_task.cancel()


class LarkConnector:
    def __init__(
        self,
        status: LarkConnectorStatus,
        *,
        runner: LarkCommandRunner | None = None,
    ) -> None:
        self.status = status
        self._runner = runner or SubprocessLarkCommandRunner()

    @classmethod
    def discover(
        cls,
        *,
        resources_path: Path | None = None,
        path_env: str | None = None,
        platform_name: str | None = None,
        arch: str | None = None,
        runner: LarkCommandRunner | None = None,
    ) -> LarkConnector:
        return cls(
            discover_lark_connector(
                resources_path=resources_path,
                path_env=path_env,
                platform_name=platform_name,
                arch=arch,
            ),
            runner=runner,
        )

    async def probe_auth_status(self) -> LarkAuthStatus:
        executable_path = self.status.executable_path
        if not self.status.available or not executable_path:
            return LarkAuthStatus(status="disconnected", last_error_code="lark_cli_missing")

        result = await self._runner.run(
            executable_path,
            ["auth", "status", "--json"],
            timeout_seconds=15,
        )
        payload = _parse_json_object(result.stdout)
        if result.returncode == 0:
            if not _user_identity_available(payload):
                return LarkAuthStatus(
                    status="needs_auth", last_error_code="lark_user_auth_required"
                )
            return LarkAuthStatus(
                status="connected",
                tenant_label=_first_string(
                    payload,
                    "tenant_label",
                    "tenant_name",
                    "tenant",
                    "tenant_key",
                ),
                account_label=_first_string(
                    payload,
                    "account_label",
                    "user_email",
                    "email",
                    "user_name",
                    "name",
                ),
            )
        output = f"{result.stdout}\n{result.stderr}".lower()
        if _looks_logged_out(output):
            return LarkAuthStatus(status="needs_auth", last_error_code="lark_auth_required")
        return LarkAuthStatus(status="error", last_error_code="lark_auth_status_failed")

    async def start_login(self) -> LarkLoginResult:
        executable_path = self.status.executable_path
        if not self.status.available or not executable_path:
            return LarkLoginResult(status="error", last_error_code="lark_cli_missing")

        result = await self._runner.run(
            executable_path,
            [
                "auth",
                "login",
                "--recommend",
                "--scope",
                " ".join(LARK_IM_USER_SCOPES),
                "--no-wait",
                "--json",
            ],
            timeout_seconds=60,
        )
        payload = _parse_json_object(result.stdout)
        if result.returncode != 0:
            output = f"{result.stdout}\n{result.stderr}".lower()
            if _looks_not_configured(output):
                return await self._start_config_init(executable_path)
            return LarkLoginResult(status="error", last_error_code="lark_auth_login_failed")

        authorization_url = _first_string(
            payload,
            "authorization_url",
            "verification_url",
            "auth_url",
            "url",
        )
        return LarkLoginResult(
            status="needs_auth" if authorization_url else "connected",
            authorization_url=authorization_url or None,
            device_code=_first_string(payload, "device_code") or None,
        )

    async def complete_login(self, device_code: str) -> LarkAuthStatus:
        executable_path = self.status.executable_path
        if not self.status.available or not executable_path:
            return LarkAuthStatus(status="error", last_error_code="lark_cli_missing")
        if not device_code.strip():
            return LarkAuthStatus(status="needs_auth", last_error_code="lark_auth_required")

        result = await self._runner.run(
            executable_path,
            ["auth", "login", "--device-code", device_code, "--json"],
            timeout_seconds=180,
        )
        if result.returncode == 0:
            return await self.probe_auth_status()
        if result.returncode == 124:
            return LarkAuthStatus(status="needs_auth", last_error_code="lark_auth_pending")
        output = f"{result.stdout}\n{result.stderr}".lower()
        if _looks_logged_out(output) or _looks_user_authorization_required(output):
            return LarkAuthStatus(status="needs_auth", last_error_code="lark_auth_required")
        return LarkAuthStatus(status="error", last_error_code="lark_auth_completion_failed")

    async def _start_config_init(self, executable_path: str) -> LarkLoginResult:
        result = await self._runner.run_until_url(
            executable_path,
            ["config", "init", "--new", "--brand", "feishu", "--lang", "zh"],
            timeout_seconds=30,
        )
        authorization_url = _first_url(f"{result.stdout}\n{result.stderr}")
        if authorization_url:
            return LarkLoginResult(
                status="needs_auth",
                authorization_url=authorization_url,
                last_error_code="lark_config_required",
            )
        return LarkLoginResult(status="error", last_error_code="lark_config_init_failed")

    async def logout(self) -> LarkLogoutResult:
        executable_path = self.status.executable_path
        if not self.status.available or not executable_path:
            return LarkLogoutResult(status="disconnected", last_error_code="lark_cli_missing")

        result = await self._runner.run(
            executable_path,
            ["auth", "logout", "--json"],
            timeout_seconds=30,
        )
        if result.returncode == 0:
            return LarkLogoutResult(status="disconnected")
        output = f"{result.stdout}\n{result.stderr}".lower()
        if _looks_logged_out(output):
            return LarkLogoutResult(status="disconnected")
        return LarkLogoutResult(status="error", last_error_code="lark_auth_logout_failed")

    async def fetch_recent_im_messages(
        self,
        *,
        chat_limit: int = 20,
        messages_per_chat: int = 20,
    ) -> LarkMessageSnapshot:
        sources = await self.fetch_recent_im_sources(chat_limit=chat_limit)
        return await self.fetch_recent_im_messages_for_sources(
            sources,
            messages_per_chat=messages_per_chat,
        )

    async def fetch_recent_im_sources(
        self,
        *,
        chat_limit: int = 20,
    ) -> list[LarkFetchedSource]:
        executable_path = self.status.executable_path
        if not self.status.available or not executable_path:
            return []

        chat_result = await self._runner.run(
            executable_path,
            [
                "im",
                "+chat-list",
                "--as",
                "user",
                "--types",
                "p2p,group",
                "--sort",
                "active_time",
                "--page-size",
                str(max(1, min(chat_limit, 100))),
                "--format",
                "json",
            ],
            timeout_seconds=30,
        )
        if chat_result.returncode != 0:
            output = f"{chat_result.stdout}\n{chat_result.stderr}"
            if _looks_user_authorization_required(output):
                raise LarkAuthRequiredError("lark_auth_scope_required")
            raise RuntimeError("lark_cli_chat_list_failed")

        sources = [
            _source_from_chat(item)
            for item in _extract_items(_parse_json_object(chat_result.stdout))
        ]
        return [source for source in sources if source is not None]

    async def fetch_recent_im_messages_for_sources(
        self,
        sources: list[LarkFetchedSource],
        *,
        messages_per_chat: int = 20,
    ) -> LarkMessageSnapshot:
        executable_path = self.status.executable_path
        if not self.status.available or not executable_path:
            return LarkMessageSnapshot(sources=sources, messages=[])

        messages: list[LarkFetchedMessage] = []
        for source in sources:
            message_result = await self._runner.run(
                executable_path,
                [
                    "im",
                    "+chat-messages-list",
                    "--as",
                    "user",
                    "--chat-id",
                    source.provider_source_id,
                    "--page-size",
                    str(max(1, min(messages_per_chat, 50))),
                    "--order",
                    "desc",
                    "--format",
                    "json",
                    "--no-reactions",
                ],
                timeout_seconds=45,
            )
            if message_result.returncode != 0:
                output = f"{message_result.stdout}\n{message_result.stderr}"
                if _looks_user_authorization_required(output):
                    raise LarkAuthRequiredError("lark_auth_scope_required")
                continue
            for item in _extract_items(_parse_json_object(message_result.stdout)):
                message = _message_from_item(source.provider_source_id, item)
                if message is not None:
                    messages.append(message)

        return LarkMessageSnapshot(sources=sources, messages=messages)


async def _drain_lark_process(
    proc: asyncio.subprocess.Process,
    *tasks: asyncio.Task[None],
) -> None:
    await proc.wait()
    await asyncio.gather(*tasks, return_exceptions=True)


def discover_lark_connector(
    *,
    resources_path: Path | None = None,
    path_env: str | None = None,
    platform_name: str | None = None,
    arch: str | None = None,
) -> LarkConnectorStatus:
    platform_name = platform_name or sys.platform
    arch = _normalize_arch(arch or platform.machine())
    executable = _executable_name(platform_name)

    if resources_path is not None:
        for candidate in _bundled_candidates(resources_path, platform_name, arch, executable):
            if candidate.is_file():
                return LarkConnectorStatus(
                    available=True,
                    source="bundled",
                    executable_path=str(candidate),
                )

    for candidate in _path_candidates(
        executable=executable,
        path_env=os.environ.get("PATH", "") if path_env is None else path_env,
        platform_name=platform_name,
    ):
        if candidate.is_file():
            return LarkConnectorStatus(
                available=True,
                source="system",
                executable_path=str(candidate),
            )

    return LarkConnectorStatus(available=False, source="missing")


def _bundled_candidates(
    resources_path: Path,
    platform_name: str,
    arch: str,
    executable: str,
) -> list[Path]:
    base = Path(resources_path)
    platform_arch = f"{platform_name}-{arch}"
    return [
        base / "connectors" / "lark" / platform_arch / executable,
        base / "connectors" / "lark" / executable,
    ]


def _path_candidates(
    *,
    executable: str,
    path_env: str,
    platform_name: str,
) -> list[Path]:
    if not path_env:
        return []
    separator = ";" if platform_name.startswith("win") else os.pathsep
    return [Path(entry) / executable for entry in path_env.split(separator) if entry]


def _executable_name(platform_name: str) -> str:
    if platform_name.startswith("win"):
        return "lark-cli.exe"
    return "lark-cli"


def _normalize_arch(arch: str) -> str:
    normalized = arch.lower()
    if normalized in {"amd64", "x86_64"}:
        return "x64"
    if normalized in {"aarch64", "arm64"}:
        return "arm64"
    return normalized


def _looks_logged_out(output: str) -> bool:
    return any(
        marker in output
        for marker in [
            "not logged",
            "not login",
            "not configured",
            "not_configured",
            "unauthorized",
            "no token",
        ]
    )


def _looks_not_configured(output: str) -> bool:
    return "not configured" in output or "not_configured" in output


def _looks_user_authorization_required(output: str) -> bool:
    normalized = output.lower()
    return any(
        marker in normalized
        for marker in [
            "need_user_authorization",
            "current command requires scope",
            "token_missing",
            "missing scope",
        ]
    )


def _user_identity_available(payload: dict[str, object]) -> bool:
    identities = payload.get("identities")
    if not isinstance(identities, dict):
        return True
    user = identities.get("user")
    if not isinstance(user, dict):
        return True
    available = user.get("available")
    if available is False:
        return False
    status = _first_string(user, "status").lower()
    if status in {"missing", "unavailable", "unauthorized", "needs_auth", "not_logged_in"}:
        return False
    return True


_URL_PATTERN = re.compile(r"https?://[^\s\"'<>]+")


def _first_url(raw: str) -> str:
    match = _URL_PATTERN.search(raw)
    if not match:
        return ""
    return match.group(0).rstrip(".,;)")


def _parse_json_object(raw: str) -> dict[str, object]:
    text = raw.strip()
    if not text:
        return {}
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _first_string(payload: dict[str, object], *keys: str) -> str:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _extract_items(payload: dict[str, object]) -> list[dict[str, object]]:
    candidates: list[object] = [
        payload.get("items"),
        payload.get("list"),
        payload.get("chats"),
        payload.get("messages"),
    ]
    for key in ("data", "result"):
        nested = payload.get(key)
        if isinstance(nested, dict):
            candidates.extend(
                [
                    nested.get("items"),
                    nested.get("list"),
                    nested.get("chats"),
                    nested.get("messages"),
                ]
            )
    for candidate in candidates:
        if isinstance(candidate, list):
            return [item for item in candidate if isinstance(item, dict)]
    return []


def _source_from_chat(item: dict[str, object]) -> LarkFetchedSource | None:
    provider_source_id = _first_string(item, "chat_id", "id", "feed_id")
    if not provider_source_id:
        return None
    raw_type = _first_string(item, "chat_type", "chat_mode", "type", "mode").lower()
    source_type: Literal["p2p", "group", "thread"] = "group"
    if raw_type == "p2p" or raw_type == "private":
        source_type = "p2p"
    elif raw_type == "thread" or raw_type == "topic":
        source_type = "thread"
    return LarkFetchedSource(
        provider_source_id=provider_source_id,
        source_type=source_type,
        display_label=_first_string(item, "name", "chat_name", "title", "display_name"),
    )


def _message_from_item(
    source_provider_id: str, item: dict[str, object]
) -> LarkFetchedMessage | None:
    provider_message_id = _first_string(item, "message_id", "id", "msg_id")
    if not provider_message_id:
        return None
    sender = item.get("sender")
    sender_id = (
        _first_string(sender, "id", "open_id", "user_id") if isinstance(sender, dict) else ""
    )
    return LarkFetchedMessage(
        source_provider_id=source_provider_id,
        provider_message_id=provider_message_id,
        sender_id=sender_id,
        message_type=_first_string(item, "message_type", "msg_type") or "text",
        created_at_lark=_first_string(item, "create_time", "created_at", "send_time") or None,
        raw=item,
    )
