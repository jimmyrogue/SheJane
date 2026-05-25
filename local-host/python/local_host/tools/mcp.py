"""MCP integration via langchain-mcp-adapters.

We do NOT install or manage MCP servers ourselves. Instead, on every
agent boot we scan the user's machine for MCP server configs that
*other* tools have already set up (Claude Desktop, Cursor, Codex) plus
our own canonical location. Whatever we find gets normalized to
`MultiServerMCPClient`'s schema, deduped by name, and handed to the
agent as native LangChain tools.

This means: the user installs an MCP server once via their preferred
tool (e.g. `claude mcp add ...` for Claude Desktop) and SheJane picks
it up automatically — no separate "add MCP server" UI required.

Sources, in priority order (first one that defines a given name wins):

  1. `JIANDANLY_LOCAL_MCP_SERVERS` env var — full override. When set,
     the on-disk sources below are skipped entirely. JSON value matches
     MultiServerMCPClient's schema. Test escape hatch and one-off
     debugging.
  2. `~/.shejane/mcp-servers.json` — our own canonical user-managed
     location. Same JSON format as Claude Desktop / Cursor (a top-level
     `mcpServers` map OR the bare server map). Created on demand.
  3. `<data_dir>/mcp-servers.json` — legacy path kept for back-compat
     with Phase-3 daemons that wrote there.
  4. `~/Library/Application Support/Claude/claude_desktop_config.json`
     (macOS Claude Desktop)
  5. `~/.config/Claude/claude_desktop_config.json` (Linux Claude Desktop)
  6. `~/.cursor/mcp.json` (Cursor, user-global)
  7. `~/.codex/config.toml` (Codex CLI — TOML, table `mcp_servers`)

Per-entry normalization to MultiServerMCPClient format:

    {
        "<name>": {
            "transport": "stdio" | "sse" | "http" | "websocket",
            "command": "...",            # for stdio
            "args": [...],
            "cwd": "...",
            "env": {...},
            "url": "...",                # for http/sse/websocket
            "headers": {...}
        }
    }

If `transport` is missing, we infer it: `command` → stdio, `url` → http.
This matches how Claude Desktop / Cursor lay out their configs (they
default to stdio implicitly).

If a single server's config is malformed (missing both command and url,
or wrong types), it's dropped with a log line — boot must not fail on
one bad entry, because typically the user has many servers and only
cares that the rest still work.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from langchain_core.tools import BaseTool

log = logging.getLogger("local_host.tools.mcp")


# Identifier the UI groups by. Matches the skills `source` convention —
# the renderer maps these to human labels (Claude / Cursor / Codex /
# SheJane). Keep stable; client code switches on these strings.
SOURCE_SHEJANE = "shejane"
SOURCE_DATA_DIR = "shejane-legacy"
SOURCE_CLAUDE_DESKTOP = "claude-desktop"
SOURCE_CURSOR = "cursor"
SOURCE_CODEX = "codex"
SOURCE_ENV = "env"


@dataclass(frozen=True)
class _SourceFile:
    """A potential on-disk MCP config file we'll try to read."""

    source: str
    path: Path
    fmt: str  # "json" | "toml"


@dataclass(frozen=True)
class DiscoveredServer:
    """One normalized MCP server entry plus where it came from.

    `config` is the MultiServerMCPClient-compatible dict (no `name`
    inside — name is the map key). `source` is one of the SOURCE_*
    constants above. `source_path` is the absolute path of the config
    file we read this entry from (for UI display).
    """

    name: str
    config: dict[str, Any]
    source: str
    source_path: str


def _candidate_source_files(data_dir: Path | None) -> list[_SourceFile]:
    """Return every config-file candidate in priority order.

    We don't check existence here — `_read_config_file` handles missing
    files gracefully. Returning the full ordered list keeps the logic
    declarative and the source priority easy to read.
    """
    home = Path.home()
    out: list[_SourceFile] = [
        _SourceFile(SOURCE_SHEJANE, home / ".shejane" / "mcp-servers.json", "json"),
    ]
    if data_dir is not None:
        out.append(_SourceFile(SOURCE_DATA_DIR, data_dir / "mcp-servers.json", "json"))

    # Claude Desktop — platform-specific install path.
    if sys.platform == "darwin":
        out.append(
            _SourceFile(
                SOURCE_CLAUDE_DESKTOP,
                home / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json",
                "json",
            )
        )
    elif sys.platform.startswith("linux"):
        out.append(
            _SourceFile(
                SOURCE_CLAUDE_DESKTOP,
                home / ".config" / "Claude" / "claude_desktop_config.json",
                "json",
            )
        )
    elif sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        if appdata:
            out.append(
                _SourceFile(
                    SOURCE_CLAUDE_DESKTOP,
                    Path(appdata) / "Claude" / "claude_desktop_config.json",
                    "json",
                )
            )

    out.append(_SourceFile(SOURCE_CURSOR, home / ".cursor" / "mcp.json", "json"))
    out.append(_SourceFile(SOURCE_CODEX, home / ".codex" / "config.toml", "toml"))
    return out


def _read_config_file(src: _SourceFile) -> dict[str, Any]:
    """Read one source file and return its top-level dict.

    Missing files yield `{}` (silent — they're optional). Malformed
    files yield `{}` with a warning. Permission errors yield `{}` with
    a debug log (don't spam users who chmod'd their config).
    """
    try:
        if not src.path.is_file():
            return {}
        if src.fmt == "json":
            text = src.path.read_text(encoding="utf-8")
            return json.loads(text)
        if src.fmt == "toml":
            return tomllib.loads(src.path.read_text(encoding="utf-8"))
    except (OSError, PermissionError) as exc:
        log.debug("MCP source unreadable %s: %s", src.path, exc)
        return {}
    except (json.JSONDecodeError, tomllib.TOMLDecodeError) as exc:
        log.warning("MCP source malformed %s: %s", src.path, exc)
        return {}
    return {}


def _extract_servers_map(raw: dict[str, Any], src: _SourceFile) -> dict[str, dict[str, Any]]:
    """Pull the server map out of one config file's parsed contents.

    Different tools wrap their server lists differently:
      - Claude Desktop / Cursor / our shejane file: top-level
        `mcpServers` key, OR the bare map at the top level.
      - Codex: top-level `mcp_servers` table (TOML naming convention).

    We try the wrapped key first, then fall back to treating the whole
    object as the map (so a user can drop a bare `{"foo": {...}}` into
    `~/.shejane/mcp-servers.json` without ceremony).
    """
    if not isinstance(raw, dict):
        return {}
    if src.source == SOURCE_CODEX:
        servers = raw.get("mcp_servers")
        if isinstance(servers, dict):
            return servers
        return {}
    # JSON-format sources: prefer the conventional wrapper.
    servers = raw.get("mcpServers")
    if isinstance(servers, dict):
        return servers
    # Fallback: treat the whole object as the server map, but only if
    # every value looks like a server config (has `command` or `url`).
    # Otherwise we'd misinterpret a plain `claude_desktop_config.json`
    # with no `mcpServers` block as a giant server map.
    if all(
        isinstance(v, dict) and ("command" in v or "url" in v)
        for v in raw.values()
        if v is not None
    ):
        return raw  # type: ignore[return-value]
    return {}


def _normalize_entry(name: str, raw: Any) -> dict[str, Any] | None:
    """Normalize one server entry to MultiServerMCPClient format.

    Returns None if the entry is unusable (no transport-determining
    field). Always strips unknown keys so MultiServerMCPClient doesn't
    choke on Claude-Desktop-specific extras like `disabled` or
    `autoApprove`.
    """
    if not isinstance(raw, dict):
        return None
    # Skip explicitly-disabled servers (Claude Desktop's `disabled: true`
    # convention). User opted out, so don't load.
    if raw.get("disabled") is True:
        return None

    has_command = isinstance(raw.get("command"), str) and raw["command"].strip()
    has_url = isinstance(raw.get("url"), str) and raw["url"].strip()
    if not has_command and not has_url:
        log.warning("MCP server %r missing both command and url; skipping", name)
        return None

    declared_transport = raw.get("transport")
    if isinstance(declared_transport, str) and declared_transport.strip():
        transport = declared_transport.strip().lower()
    elif has_url:
        # Sniff the URL: ws:// → websocket, otherwise default to streamable_http
        # which MultiServerMCPClient maps to plain HTTP transport.
        url_lower = raw["url"].lower()
        if url_lower.startswith(("ws://", "wss://")):
            transport = "websocket"
        else:
            transport = "streamable_http"
    else:
        transport = "stdio"

    out: dict[str, Any] = {"transport": transport}
    if has_command:
        out["command"] = raw["command"]
        if isinstance(raw.get("args"), list):
            # Coerce all args to strings — Claude Desktop sometimes has
            # ints in there and the subprocess call would crash.
            out["args"] = [str(a) for a in raw["args"]]
        if isinstance(raw.get("env"), dict):
            # All values must be strings for env. Drop None / non-strings.
            env_clean = {
                str(k): str(v)
                for k, v in raw["env"].items()
                if v is not None and not isinstance(v, dict | list)
            }
            if env_clean:
                out["env"] = env_clean
        if isinstance(raw.get("cwd"), str):
            out["cwd"] = raw["cwd"]
    if has_url:
        out["url"] = raw["url"]
        if isinstance(raw.get("headers"), dict):
            out["headers"] = {str(k): str(v) for k, v in raw["headers"].items()}

    return out


def _disk_scan_enabled() -> bool:
    """Tests set `JIANDANLY_LOCAL_MCP_DISCOVERY=off` (via the autouse
    fixture in tests/conftest.py) to keep their environment hermetic.
    Production leaves it unset → scan runs."""
    flag = os.environ.get("JIANDANLY_LOCAL_MCP_DISCOVERY", "").strip().lower()
    return flag != "off"


def discover_servers(data_dir: Path | None) -> list[DiscoveredServer]:
    """Walk every source in priority order and return normalized servers.

    Dedupes by `name` — the FIRST source that defines a given server
    wins. This means a user who has the same server name in both their
    `~/.shejane/mcp-servers.json` and Claude Desktop config will get
    the shejane version, which is what we want (their explicit
    override).

    Env override (`JIANDANLY_LOCAL_MCP_SERVERS`) is treated as its own
    "source" at the head of the priority list. When the env var is
    set, on-disk sources are STILL consulted afterwards (so a test or
    debug var augments rather than replaces) — except names that
    collide with the env, which the env wins.

    Disk scanning is suppressed when `JIANDANLY_LOCAL_MCP_DISCOVERY` is
    `off` — used by the test suite via conftest.py to avoid loading the
    dev machine's real MCP configs.
    """
    out: list[DiscoveredServer] = []
    seen: set[str] = set()

    # 1. env override goes first. Always honored regardless of the
    # disk-scan flag — it's the explicit-config path.
    env_raw = os.environ.get("JIANDANLY_LOCAL_MCP_SERVERS", "").strip()
    if env_raw:
        try:
            env_map = json.loads(env_raw)
            if isinstance(env_map, dict):
                # Allow either wrapped or bare-map form.
                if isinstance(env_map.get("mcpServers"), dict):
                    env_map = env_map["mcpServers"]
                for name, raw in env_map.items():
                    norm = _normalize_entry(name, raw)
                    if norm is None or name in seen:
                        continue
                    seen.add(name)
                    out.append(
                        DiscoveredServer(
                            name=name,
                            config=norm,
                            source=SOURCE_ENV,
                            source_path="<env JIANDANLY_LOCAL_MCP_SERVERS>",
                        )
                    )
        except json.JSONDecodeError as exc:
            log.warning("ignoring malformed JIANDANLY_LOCAL_MCP_SERVERS: %s", exc)

    # 2. then each on-disk source in priority order.
    if not _disk_scan_enabled():
        return out
    for src in _candidate_source_files(data_dir):
        raw_obj = _read_config_file(src)
        if not raw_obj:
            continue
        servers_map = _extract_servers_map(raw_obj, src)
        for name, raw_entry in servers_map.items():
            if name in seen:
                continue
            norm = _normalize_entry(name, raw_entry)
            if norm is None:
                continue
            seen.add(name)
            out.append(
                DiscoveredServer(
                    name=name,
                    config=norm,
                    source=src.source,
                    source_path=str(src.path),
                )
            )

    return out


def _load_mcp_config(data_dir: Path | None) -> dict[str, dict[str, Any]]:
    """Public-ish helper kept for back-compat. Returns the normalized
    config map ready to feed into MultiServerMCPClient."""
    return {srv.name: srv.config for srv in discover_servers(data_dir)}


async def build_mcp_tools(
    data_dir: Path | None,
    *,
    disabled_servers: set[str] | None = None,
) -> list[BaseTool]:
    """Connect to every configured MCP server and return their tools.

    Failure to connect to any one server does NOT abort the boot — we
    log the error and continue with the others. This matches the
    daemon's desire to stay up even when an MCP server is misconfigured
    (a very common state given that users routinely point Claude
    Desktop at half-broken commands during dev).

    `disabled_servers` is a per-user opt-out set — names in here are
    dropped before MultiServerMCPClient sees them, so we never spawn
    the subprocess or open the WebSocket. The user toggles individual
    rows off from the MCP tab; the client sends the disabled-name
    list with every run.
    """
    config = _load_mcp_config(data_dir)
    if disabled_servers:
        config = {name: cfg for name, cfg in config.items() if name not in disabled_servers}
    if not config:
        return []

    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient
    except ImportError:
        log.warning("langchain-mcp-adapters not installed; skipping MCP")
        return []

    client = MultiServerMCPClient(config, tool_name_prefix=True)
    try:
        tools = await client.get_tools()
    except Exception as exc:
        log.warning("MCP get_tools() failed (%s): %s", type(exc).__name__, exc)
        return []
    log.info("loaded %d MCP tools across %d servers", len(tools), len(config))
    return list(tools)
