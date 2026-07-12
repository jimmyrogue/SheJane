"""code.execute — run Python code in a per-conversation E2B microVM.

This tool gives the agent a real Python interpreter (jupyter kernel
inside an isolated VM) for tasks the deepagents built-ins can't cover:
data analysis (pandas/numpy), plotting (matplotlib), PDF surgery
(pdfplumber), batch file processing, light ML, etc.

Architecture
============

Per CLAUDE.md Invariant #1, the E2B API key MUST live in the Go API
only — never in the daemon. So this tool is a *thin client* that
proxies to /api/v1/agent/tools/execute with `tool_name="code.execute"`
exactly like web.search and image.*. The Go side handles:

  - sandbox provisioning + per-conversation reuse (kernel state
    persists across calls so the agent can iterate),
  - reservation/settlement against the user's credit ledger,
  - audit log (external_tool_call_records row per call),
  - reaper for idle sandboxes (15-min default).

PR v1 adds file IO:

  - The agent passes `files_in=["sales.xlsx"]` (workspace-relative).
  - We read those bytes from the user's workspace, run them through
    a SENSITIVE-pattern blacklist, base64-encode, and ship along with
    the code. The Go gateway uploads each to /workspace/ in the
    sandbox so the agent's `pd.read_csv('sales.xlsx')` Just Works.
  - After the run, the gateway lists /output/ in the sandbox and
    streams non-empty files back as `data.files_out[{path,
    content_b64, size}]`. We decode each and write to
    `<workspace>/.code-output/<conversation_id>/<basename>`. Same
    basename across calls overwrites — the agent iterating on a
    chart is the common case.

Security
========

Three guards stack on top of the platform-level E2B isolation:

  1. **Workspace boundary**: every `files_in` path must resolve to a
     real file inside the configured workspace_root. Anything
     starting with `..`, `/`, or `~/` is rejected before reading.
  2. **SENSITIVE_PATTERNS**: filenames matching `.env*`, `*.key`,
     `*.pem`, `*credential*`, `*secret*`, `*token*`, `id_rsa*`,
     `*.p12`, `*.pfx` are rejected even when path is valid (case
     insensitive).
  3. **Size cap**: any single file > MAX_FILE_BYTES (50 MB) is
     rejected — way above realistic Excel/CSV but below "user
     accidentally uploaded a video".

The Go gateway re-checks total bytes (200 MB cap, see code_gateway.go).
"""

from __future__ import annotations

import base64
import fnmatch
import logging
from pathlib import Path
from typing import Annotated, Any

from langchain.tools import ToolRuntime
from langchain_core.runnables import RunnableConfig
from langchain_core.runnables.config import ensure_config
from langchain_core.tools import InjectedToolCallId, tool

from ._gateway import call_tool_gateway, run_id_from_config

log = logging.getLogger("local_host.tools.code")


# Filename glob patterns we refuse to upload, case-insensitive. Any
# match here returns a tool-error without touching the disk so we
# also gain a tiny defense against "agent constructs a path it
# shouldn't" bugs. Pairs with the Go gateway's total-size cap.
SENSITIVE_PATTERNS: tuple[str, ...] = (
    ".env",
    ".env.*",
    "*.env",
    "*.key",
    "*.pem",
    "*.p12",
    "*.pfx",
    "id_rsa",
    "id_rsa.*",
    "id_ed25519",
    "id_ed25519.*",
    "id_ecdsa",
    "id_ecdsa.*",
    "id_dsa",
    "id_dsa.*",
    "known_hosts",
    "authorized_keys",
    "*credential*",
    "*credentials*",
    "*secret*",
    "*secrets*",
    "*token*",
    "*tokens*",
    "*.pgpass",
    ".netrc",
    "*.kdbx",
    # GPG/PGP — both armored (.asc) and binary keyrings.
    "*.gpg",
    "*.asc",
    "secring.*",
    "pubring.*",
    # AWS / cloud CLI defaults (when copied out of ~/.aws into a project).
    "credentials",
    "config.toml",
    # Kubernetes — `kubeconfig` itself plus the .kube directory convention.
    "kubeconfig",
    "kubeconfig.*",
)

# Per-file cap. Excel files realistically peak at low single-digit MB;
# CSVs over a few tens of MB usually warrant pandas chunked reading
# anyway. 50 MB stops "accidentally upload an mp4".
MAX_FILE_BYTES = 50 * 1024 * 1024


def _is_sensitive(name: str) -> bool:
    """Case-insensitive glob match against SENSITIVE_PATTERNS."""
    lowered = name.lower()
    return any(fnmatch.fnmatchcase(lowered, pat) for pat in SENSITIVE_PATTERNS)


def _resolve_workspace_path(workspace_root: str, rel_path: str) -> Path:
    """Resolve `rel_path` against `workspace_root`, raising ValueError
    on anything that escapes the workspace boundary.

    Accepts:                relative paths within the workspace.
    Rejects:                absolute paths, ~/-prefixed, "..", and any
                            resolved path that's not under workspace_root.
    """
    if not workspace_root:
        raise ValueError(
            "no workspace open — open a project before calling code.execute with files_in"
        )
    if not rel_path:
        raise ValueError("empty path")
    if rel_path.startswith(("/", "~")) or ".." in rel_path.split("/"):
        raise ValueError(
            f"path {rel_path!r} must be workspace-relative (no leading /, no ~/, no ..)"
        )
    root = Path(workspace_root).resolve()
    target = (root / rel_path).resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"path {rel_path!r} escapes workspace") from exc
    return target


def _read_files_in(workspace_root: str | None, file_paths: list[str]) -> list[dict[str, str]]:
    """Read each file from workspace, blacklist-check, base64-encode.
    Raises ValueError for any rejected file so the caller can surface
    a clear error to the agent (and avoid wasting a sandbox call).
    """
    if not file_paths:
        return []
    if not workspace_root:
        raise ValueError(
            "files_in requires an open workspace; ask the user to open a project first"
        )
    out: list[dict[str, str]] = []
    for rel in file_paths:
        if _is_sensitive(Path(rel).name):
            raise ValueError(f"refusing to upload sensitive file {rel!r}")
        target = _resolve_workspace_path(workspace_root, rel)
        if not target.is_file():
            raise ValueError(f"file not found: {rel!r}")
        size = target.stat().st_size
        if size > MAX_FILE_BYTES:
            raise ValueError(f"file {rel!r} is {size} bytes; exceeds {MAX_FILE_BYTES} byte cap")
        data = target.read_bytes()
        out.append(
            {
                "path": rel,
                "content_b64": base64.standard_b64encode(data).decode("ascii"),
            }
        )
    return out


def _write_files_out(
    workspace_root: str | None,
    conversation_id: str,
    files_out: list[dict[str, Any]],
) -> list[str]:
    """Decode + write each {path, content_b64, size} entry to
    workspace/.code-output/<conv_id>/<basename>. Returns the list of
    workspace-relative paths written (used for the tool-result message
    the LLM sees). Skips entries whose base64 is malformed (logs +
    drops; the agent still sees the others).
    """
    if not files_out or not workspace_root:
        return []
    out_dir = Path(workspace_root) / ".code-output" / (conversation_id or "default")
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[str] = []
    for entry in files_out:
        path = str(entry.get("path") or "")
        content_b64 = str(entry.get("content_b64") or "")
        if not path or not content_b64:
            continue
        # Strip sandbox-side prefix (e.g. /output/) → basename only.
        name = Path(path).name
        try:
            data = base64.standard_b64decode(content_b64)
        except (ValueError, TypeError) as exc:
            log.warning("code.execute: skipping bad files_out entry %s: %s", path, exc)
            continue
        target = out_dir / name
        target.write_bytes(data)
        rel = str(target.relative_to(Path(workspace_root)))
        written.append(rel)
    return written


async def _invoke_code_execute(
    *,
    code: str,
    language: str,
    conversation_id: str,
    files_in: list[dict[str, str]],
    run_id: str,
    tool_call_id: str,
) -> dict[str, Any]:
    """Test-friendly wrapper around the shared gateway helper. Tests
    target this directly so they don't have to construct a LangChain
    ToolCall envelope just to exercise the proxy."""
    arguments: dict[str, Any] = {
        "code": code,
        "language": language,
        "conversation_id": conversation_id,
    }
    if files_in:
        arguments["files_in"] = files_in
    return await call_tool_gateway(
        "code.execute",
        arguments,
        run_id=run_id,
        tool_call_id=tool_call_id,
    )


def make_code_execute_tool(workspace_root: str | None):
    """Build the code.execute tool bound to a specific workspace root.

    Why a factory rather than a top-level @tool: file IO needs to
    resolve paths against the run's workspace, which is determined
    at run start (see agent/builder.py:effective_workspace). We
    can't use InjectedToolArg here because we also need to write
    output files back AFTER the tool returns — the closure lets the
    write step see the same workspace.
    """

    @tool("code.execute")
    async def code_execute(
        code: str,
        runtime: ToolRuntime[Any] = None,  # type: ignore[assignment]
        language: str = "python",
        files_in: list[str] | None = None,
        tool_call_id: Annotated[str, InjectedToolCallId] = "",
        config: RunnableConfig | None = None,
    ) -> dict[str, Any]:
        """Run a Python code snippet in an isolated cloud sandbox.

        The sandbox persists across calls within the same conversation —
        variables, imports, and DataFrames you create now will still be
        available the next time you call this tool. This is intentional
        so you can iterate ("now do X to that df" → "now also plot it").

        Use this when:
          - You need to compute, analyze, or transform data (pandas,
            numpy, scipy, scikit-learn are pre-installed).
          - You want to render a chart (matplotlib / seaborn / plotly).
            Just call `plt.show()` — the PNG comes back inline
            automatically and the user sees it in the chat.
          - You need to do something the built-in tools can't.

        Args:
            code: Python source. Multi-line OK. Standard library +
                  pre-installed packages above are available. Kernel
                  state persists across calls — reference variables
                  defined earlier.

                  REMINDER: The sandbox is a Jupyter kernel. To see
                  a value, either `print(value)` OR put a bare
                  expression as the last line (Jupyter auto-displays
                  it). For plots, `plt.show()` is enough — no need to
                  savefig.

            language: Currently only "python".

            files_in: Workspace-relative file paths to upload into
                  the sandbox BEFORE running. Each lands at
                  /home/user/<path> (sandbox's CWD), so
                  `pd.read_csv('sales.xlsx')` Just Works.
                  Sensitive filenames (.env, *.key, etc.) are refused.
                  Files >50MB are refused.

                  To persist files back to the user's workspace,
                  write them under `/home/user/output/` in the
                  sandbox (e.g. `plt.savefig('/home/user/output/chart.png')`).
                  They'll auto-sync to `workspace/.code-output/<conv_id>/`
                  after the call returns. Files written ANYWHERE ELSE
                  in the sandbox (e.g. `/home/user/chart.png` or
                  `/tmp/`) are NOT synced and will be lost on the
                  next call.

        Returns: `{ok, content, data?, errorCode?, recoverable?}` matching
        `agentToolExecuteResult`. On success, `content` is a text summary
        (stdout / stderr / error / files_out names); `data.results`
        carries the rich outputs (matplotlib figures as base64 PNGs in
        `data.results[].data["image/png"]`) for the client renderer.
        """
        # LangChain's automatic RunnableConfig injection on tool calls
        # is inconsistent across agent paths — when invoked via deepagents'
        # graph nodes the kwarg can arrive as None even though there IS
        # a live config in the runtime contextvar. Fall back to
        # ensure_config() which reads from that contextvar. Diagnostic
        # log if we had to fall back, so we can spot future regressions.
        if config is None:
            try:
                config = ensure_config()
            except Exception as exc:  # pragma: no cover — defensive
                log.warning("code.execute: ensure_config() failed: %s", exc)
                config = {}
        run_id = run_id_from_config(config)
        conversation_id = run_id  # 1:1 for v0; see top-of-file comment
        if not conversation_id:
            log.warning(
                "code.execute: no thread_id in config; config keys=%s",
                list(config.keys()) if isinstance(config, dict) else type(config).__name__,
            )
            return {
                "ok": False,
                "content": (
                    "code.execute requires a conversation context. This usually "
                    "means the tool was called outside an active agent run."
                ),
                "errorCode": "no_conversation_context",
                "recoverable": False,
            }

        context = getattr(runtime, "context", None)
        active_workspace = workspace_root or getattr(context, "workspace_root", None)

        # Read + validate files_in before billing — return a clear
        # tool-error envelope so the LLM can self-correct.
        try:
            files_payload = _read_files_in(active_workspace, files_in or [])
        except ValueError as exc:
            return {
                "ok": False,
                "content": f"code.execute: {exc}",
                "errorCode": "files_in_rejected",
                "recoverable": True,
            }

        result = await _invoke_code_execute(
            code=code,
            language=language,
            conversation_id=conversation_id,
            files_in=files_payload,
            run_id=run_id,
            tool_call_id=tool_call_id,
        )

        # Auto-sync /output/. We never throw here — the LLM already
        # has its textual answer; failing the sync just means the
        # file isn't materialized locally (we log a warning so dev
        # can investigate). Mutate result so the agent's content
        # references the local paths the user can actually open.
        if isinstance(result, dict) and result.get("ok"):
            data = result.get("data") or {}
            files_out = data.get("files_out") or []
            try:
                written = _write_files_out(active_workspace, conversation_id, list(files_out))
            except OSError as exc:
                log.warning("code.execute: write_files_out failed: %s", exc)
                written = []
            if written:
                # Replace the gateway's basename-only summary with
                # actual local paths so the agent can reference them
                # in follow-up turns.
                content = str(result.get("content") or "")
                local_paths = "\n  ".join(written)
                result["content"] = content + f"\n\nfiles_out (local):\n  {local_paths}"
                # Mirror the local paths into data so the client UI
                # can render "open this file" affordances. Distinct
                # from data.files_out which has the base64 bytes.
                if isinstance(data, dict):
                    data["files_out_local"] = written
                    result["data"] = data

        return result

    return code_execute


def CODE_TOOLS_for_workspace(workspace_root: str | None) -> list:
    """Convenience for registry.build_tools — return the gated list
    of code-execution tools bound to `workspace_root`."""
    return [make_code_execute_tool(workspace_root)]


# Backwards-compatible top-level tool for legacy callers (tests that
# import CODE_TOOLS directly). Bound to None workspace so any
# files_in attempt fails with a clear error; tests for "no workspace"
# behavior key off this.
CODE_TOOLS = CODE_TOOLS_for_workspace(None)
