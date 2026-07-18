"""Trivial tools — each is just a thin stdlib wrapper.

We expose these as LangChain `@tool` functions so they plug into ToolNode /
create_agent without any extra adapter layer.
"""

from __future__ import annotations

import os
import platform
import subprocess
import sys
import webbrowser
from datetime import datetime
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pyperclip
from langchain_core.tools import tool


@tool("time.now")
def time_now(timezone: str = "UTC") -> dict[str, str]:
    """Return the current wall-clock time as ISO 8601 + a few common formats.

    Args:
        timezone: IANA timezone name, e.g. "UTC", "Asia/Shanghai". Default: UTC.
    """
    try:
        zone = ZoneInfo(timezone)
    except ZoneInfoNotFoundError:
        return {"error": f"unknown timezone: {timezone}"}
    now = datetime.now(zone)
    return {
        "iso": now.isoformat(),
        "timezone": timezone,
        "year": str(now.year),
        "month": f"{now.month:02d}",
        "day": f"{now.day:02d}",
        "weekday": now.strftime("%A"),
    }


@tool("environment.observe")
def environment_observe() -> dict[str, str]:
    """Return a compact summary of the agent's runtime environment.

    Includes OS, Python version, working directory, and a few env hints.
    No secrets — only PATH-shaped variables and common locale settings.
    """
    safe_env_keys = ("LANG", "LC_ALL", "TERM", "SHELL", "USER", "HOME")
    return {
        "os": platform.system(),
        "os_release": platform.release(),
        "machine": platform.machine(),
        "python": sys.version.split()[0],
        "cwd": os.getcwd(),
        **{k: os.environ.get(k, "") for k in safe_env_keys},
    }


@tool("open.url")
def open_url(url: str) -> dict[str, str]:
    """Open the given URL in the user's default browser.

    Returns immediately; no confirmation that the browser actually loaded.
    """
    if url != url.strip() or any(ord(character) < 32 for character in url):
        return {"ok": "false", "error": "URL contains whitespace or control characters"}
    parts = urlsplit(url)
    if parts.scheme.lower() not in {"http", "https"}:
        return {"ok": "false", "error": "only http(s) URLs are allowed"}
    if not parts.hostname:
        return {"ok": "false", "error": "URL must include a hostname"}
    if parts.username is not None or parts.password is not None:
        return {"ok": "false", "error": "URL credentials are not allowed"}
    webbrowser.open(url, new=2)
    return {"ok": "true", "url": url}


@tool("open.file")
def open_file(path: str) -> dict[str, str]:
    """Open the given file with the OS's default application.

    macOS uses `open`, Linux uses `xdg-open`, Windows uses `start`.
    """
    if not os.path.exists(path):
        return {"ok": "false", "error": f"file not found: {path}"}
    system = platform.system()
    if system == "Darwin":
        cmd = ["open", path]
    elif system == "Windows":
        cmd = ["cmd", "/c", "start", "", path]
    else:
        cmd = ["xdg-open", path]
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"ok": "true", "path": path}


@tool("clipboard.read")
def clipboard_read() -> dict[str, str]:
    """Read the current clipboard text content."""
    try:
        text = pyperclip.paste()
    except pyperclip.PyperclipException as exc:
        return {"ok": "false", "error": str(exc)}
    return {"ok": "true", "text": text}


@tool("clipboard.write")
def clipboard_write(text: str) -> dict[str, str]:
    """Write text to the system clipboard."""
    try:
        pyperclip.copy(text)
    except pyperclip.PyperclipException as exc:
        return {"ok": "false", "error": str(exc)}
    return {"ok": "true", "bytes_written": str(len(text.encode("utf-8")))}


TRIVIAL_TOOLS = [
    time_now,
    environment_observe,
    open_url,
    open_file,
    clipboard_read,
    clipboard_write,
]
