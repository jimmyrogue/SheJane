"""Contract tests for the code.execute tool — cloud Tool Gateway proxy.

Same shape as test_web_search_tool.py / test_image_tool.py. The
daemon's `code.execute` tool POSTs to `/api/v1/agent/tools/execute`
with `tool="code.execute"` and the Go API holds the E2B API key (per
CLAUDE.md Invariant #1). We pin:

  1. Outbound HTTP shape matches code_gateway.go (conversation_id +
     code + language fields, idempotency key, run_id for billing).
  2. Successful response unwraps `data` from the API envelope.
  3. Unpaired daemon returns a recoverable tool error.
  4. Network failure during the proxy also returns a recoverable error.
  5. registry.build_tools(include_code_exec=False) does NOT include
     code.execute in the toolset.
  6. registry.build_tools(include_code_exec=True) DOES include it.
"""

from __future__ import annotations

import json

import httpx
import pytest

from local_host.config import reset_settings_for_tests
from local_host.tools import _gateway as gateway_module
from local_host.tools import code as code_module


def _patch_httpx(monkeypatch, handler) -> list[httpx.Request]:
    """Replace httpx.AsyncClient inside the shared gateway helper with
    a MockTransport that records every outbound request."""
    recorded: list[httpx.Request] = []

    def _capture(request: httpx.Request) -> httpx.Response:
        recorded.append(request)
        return handler(request)

    class _Patched(httpx.AsyncClient):
        def __init__(self, **kw):
            kw.pop("transport", None)
            super().__init__(transport=httpx.MockTransport(_capture), **kw)

    monkeypatch.setattr(gateway_module.httpx, "AsyncClient", _Patched)
    return recorded


@pytest.fixture
def settings_with_session(monkeypatch):
    return reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://api.test",
        SHEJANE_CLOUD_TOKEN="cloud-jwt",
    )


@pytest.fixture
def settings_unpaired(monkeypatch):
    return reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        SHEJANE_CLOUD_BASE_URL="http://api.test",
        SHEJANE_CLOUD_TOKEN="",
    )


@pytest.mark.asyncio
async def test_code_execute_proxies_to_cloud_gateway(monkeypatch, settings_with_session) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "code": 0,
                "message": "ok",
                "data": {
                    "ok": True,
                    "content": "stdout:\nhello from sandbox",
                    "data": {
                        "source": "code.execute",
                        "sandbox_id": "sbx-xyz",
                        "session_id": "sess-1",
                        "stdout": "hello from sandbox\n",
                        "stderr": "",
                        "results": [],
                        "execution_ms": 42,
                    },
                },
            },
        )

    recorded = _patch_httpx(monkeypatch, handler)
    result = await code_module._invoke_code_execute(
        code="print('hello from sandbox')",
        language="python",
        conversation_id="conv-1",
        files_in=[],
        run_id="run_abc",
        tool_call_id="call_1",
    )

    assert len(recorded) == 1
    req = recorded[0]
    assert req.method == "POST"
    assert str(req.url) == "http://api.test/api/v1/agent/tools/execute"
    assert req.headers["authorization"] == "Bearer cloud-jwt"
    body = json.loads(req.content)
    assert body["tool"] == "code.execute"
    assert body["run_id"] == "run_abc"
    assert body["tool_call_id"] == "call_1"
    assert body["arguments"]["code"] == "print('hello from sandbox')"
    assert body["arguments"]["language"] == "python"
    assert body["arguments"]["conversation_id"] == "conv-1"
    assert body["idempotency_key"] == "call_1"

    assert result["ok"] is True
    assert "hello from sandbox" in result["content"]
    assert result["data"]["sandbox_id"] == "sbx-xyz"
    assert result["data"]["execution_ms"] == 42


@pytest.mark.asyncio
async def test_code_execute_no_pairing_returns_recoverable_error(
    monkeypatch, settings_unpaired
) -> None:
    recorded = _patch_httpx(monkeypatch, lambda _r: httpx.Response(500))
    result = await code_module._invoke_code_execute(
        code="print(1)",
        language="python",
        conversation_id="c",
        files_in=[],
        run_id="r",
        tool_call_id="t",
    )
    assert recorded == []  # short-circuited before HTTP
    assert result["ok"] is False
    assert result["errorCode"] == "cloud_session_missing"
    assert result["recoverable"] is True


@pytest.mark.asyncio
async def test_code_execute_gateway_error_surfaces(monkeypatch, settings_with_session) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "code": 1,
                "message": "tool not configured",
                "data": {
                    "ok": False,
                    "content": "code.execute is disabled because E2B is not configured.",
                    "errorCode": "code_exec_disabled",
                    "recoverable": True,
                },
            },
        )

    _patch_httpx(monkeypatch, handler)
    result = await code_module._invoke_code_execute(
        code="print(1)",
        language="python",
        conversation_id="c",
        files_in=[],
        run_id="r",
        tool_call_id="t",
    )
    assert result["ok"] is False
    assert result["errorCode"] == "code_exec_disabled"


@pytest.mark.asyncio
async def test_code_execute_transport_error_returns_recoverable(
    monkeypatch, settings_with_session
) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    _patch_httpx(monkeypatch, handler)
    result = await code_module._invoke_code_execute(
        code="print(1)",
        language="python",
        conversation_id="c",
        files_in=[],
        run_id="r",
        tool_call_id="t",
    )
    assert result["ok"] is False
    assert result["errorCode"] == "gateway_unreachable"
    assert result["recoverable"] is True


@pytest.mark.asyncio
async def test_code_execute_gated_off_by_default(monkeypatch, settings_with_session) -> None:
    """build_tools(include_code_exec=False) must NOT expose code.execute
    so the agent doesn't even see the tool when the user hasn't opted
    in. This is the daemon-side enforcement of the "default OFF"
    invariant; the client-side toggle drives the include_code_exec
    parameter via runs.py."""
    from local_host.tools.registry import build_tools

    tools = await build_tools(include_mcp=False, include_code_exec=False)
    names = {t.name for t in tools}
    assert "code.execute" not in names


@pytest.mark.asyncio
async def test_code_execute_gated_on_when_enabled(monkeypatch, settings_with_session) -> None:
    from local_host.tools.registry import build_tools

    tools = await build_tools(include_mcp=False, include_code_exec=True)
    names = {t.name for t in tools}
    assert "code.execute" in names


@pytest.mark.asyncio
async def test_cloud_gateway_tools_are_omitted_without_a_cloud_binding() -> None:
    from local_host.tools.registry import build_tools

    tools = await build_tools(
        include_mcp=False,
        include_code_exec=True,
        include_cloud_tools=False,
    )
    names = {tool.name for tool in tools}
    assert "web.fetch" in names
    assert not {"web.search", "image.generate", "image.edit", "pdf.inspect", "code.execute"} & names


# --- PR v1: files_in + blacklist + output sync -------------------------------


def test_is_sensitive_blacklist_patterns() -> None:
    """All sensitive patterns rejected; mundane filenames pass."""
    assert code_module._is_sensitive(".env") is True
    assert code_module._is_sensitive(".env.production") is True
    assert code_module._is_sensitive("aws.key") is True
    assert code_module._is_sensitive("server.pem") is True
    assert code_module._is_sensitive("id_rsa") is True
    assert code_module._is_sensitive("id_ecdsa.pub") is True
    assert code_module._is_sensitive("authorized_keys") is True
    assert code_module._is_sensitive("known_hosts") is True
    assert code_module._is_sensitive("my_secret.txt") is True
    assert code_module._is_sensitive("github_token") is True
    assert code_module._is_sensitive("CREDENTIALS.json") is True  # case insensitive
    assert code_module._is_sensitive("vault.kdbx") is True  # *.kdbx pattern matches
    # GPG / PGP keys.
    assert code_module._is_sensitive("backup.gpg") is True
    assert code_module._is_sensitive("publickey.asc") is True
    assert code_module._is_sensitive("secring.gpg") is True
    # AWS CLI default name (when copied out into a project folder).
    assert code_module._is_sensitive("credentials") is True
    # Kubernetes config.
    assert code_module._is_sensitive("kubeconfig") is True
    # Normal filenames pass.
    assert code_module._is_sensitive("sales.xlsx") is False
    assert code_module._is_sensitive("notes.md") is False
    assert code_module._is_sensitive("data.csv") is False


def test_resolve_workspace_path_rejects_escapes(tmp_path) -> None:
    """`..`, `/abs`, `~/home`, and resolves-outside paths must raise."""
    (tmp_path / "ok.txt").write_text("data")
    code_module._resolve_workspace_path(str(tmp_path), "ok.txt")  # passes
    with pytest.raises(ValueError, match="must be workspace-relative"):
        code_module._resolve_workspace_path(str(tmp_path), "/etc/passwd")
    with pytest.raises(ValueError, match="must be workspace-relative"):
        code_module._resolve_workspace_path(str(tmp_path), "~/.ssh/id_rsa")
    with pytest.raises(ValueError, match="must be workspace-relative"):
        code_module._resolve_workspace_path(str(tmp_path), "../../etc/passwd")


def test_read_files_in_blacklists(tmp_path) -> None:
    """Sensitive filename rejected even when path is valid."""
    (tmp_path / ".env").write_text("SECRET=xyz")
    with pytest.raises(ValueError, match="sensitive"):
        code_module._read_files_in(str(tmp_path), [".env"])


def test_read_files_in_size_cap(tmp_path, monkeypatch) -> None:
    """File above MAX_FILE_BYTES is rejected."""
    monkeypatch.setattr(code_module, "MAX_FILE_BYTES", 100)
    big = tmp_path / "big.csv"
    big.write_bytes(b"x" * 200)
    with pytest.raises(ValueError, match="exceeds"):
        code_module._read_files_in(str(tmp_path), ["big.csv"])


def test_read_files_in_encodes_payload(tmp_path) -> None:
    """Happy path: returns base64-encoded entries with correct paths."""
    (tmp_path / "data.csv").write_bytes(b"col\n1\n2\n")
    payload = code_module._read_files_in(str(tmp_path), ["data.csv"])
    assert len(payload) == 1
    assert payload[0]["path"] == "data.csv"
    import base64 as _b

    assert _b.standard_b64decode(payload[0]["content_b64"]) == b"col\n1\n2\n"


def test_read_files_in_missing_file_raises(tmp_path) -> None:
    with pytest.raises(ValueError, match="not found"):
        code_module._read_files_in(str(tmp_path), ["nope.csv"])


def test_read_files_in_no_workspace_raises() -> None:
    with pytest.raises(ValueError, match="open a project"):
        code_module._read_files_in(None, ["x.csv"])


def test_write_files_out_writes_basename_under_conversation_dir(tmp_path) -> None:
    """files_out entries land in workspace/.code-output/<conv_id>/<basename>.
    Same basename across calls overwrites (agent iterating common case)."""
    import base64 as _b

    files_out = [
        {
            "path": "/output/chart.png",
            "content_b64": _b.standard_b64encode(b"PNGDATA").decode("ascii"),
            "size": 7,
        },
        {
            "path": "/output/subdir/result.csv",  # subdir path → still basename
            "content_b64": _b.standard_b64encode(b"a,b\n1,2\n").decode("ascii"),
            "size": 8,
        },
    ]
    written = code_module._write_files_out(str(tmp_path), "conv-1", files_out)
    assert sorted(written) == sorted(
        [".code-output/conv-1/chart.png", ".code-output/conv-1/result.csv"]
    )
    assert (tmp_path / ".code-output" / "conv-1" / "chart.png").read_bytes() == b"PNGDATA"


def test_write_files_out_overwrites_same_basename(tmp_path) -> None:
    import base64 as _b

    code_module._write_files_out(
        str(tmp_path),
        "conv-1",
        [
            {
                "path": "/output/x.png",
                "content_b64": _b.standard_b64encode(b"v1").decode("ascii"),
                "size": 2,
            }
        ],
    )
    code_module._write_files_out(
        str(tmp_path),
        "conv-1",
        [
            {
                "path": "/output/x.png",
                "content_b64": _b.standard_b64encode(b"v2NEWER").decode("ascii"),
                "size": 7,
            }
        ],
    )
    assert (tmp_path / ".code-output" / "conv-1" / "x.png").read_bytes() == b"v2NEWER"


def test_write_files_out_skips_malformed_base64(tmp_path, caplog) -> None:
    """One bad entry must not kill the others."""
    import base64 as _b

    files_out = [
        {"path": "/output/good.txt", "content_b64": _b.standard_b64encode(b"ok").decode("ascii")},
        {"path": "/output/bad.txt", "content_b64": "not-valid-base64-@@@"},
    ]
    written = code_module._write_files_out(str(tmp_path), "conv-x", files_out)
    assert written == [".code-output/conv-x/good.txt"]


def test_write_files_out_no_workspace_returns_empty() -> None:
    """Without a workspace there's nowhere to put files; degrade silently."""
    assert code_module._write_files_out(None, "conv-1", [{"path": "/output/x"}]) == []


@pytest.mark.asyncio
async def test_code_execute_proxies_files_in_through_gateway(
    monkeypatch, settings_with_session, tmp_path
) -> None:
    """Tool factory bound to workspace_root reads files_in from disk,
    blacklist-checks, base64-encodes, and forwards via gateway.
    files_out from response auto-write back to workspace/.code-output."""
    (tmp_path / "sales.csv").write_bytes(b"region,total\nAPAC,100\n")

    def handler(_req: httpx.Request) -> httpx.Response:
        import base64 as _b

        return httpx.Response(
            200,
            json={
                "code": 0,
                "message": "ok",
                "data": {
                    "ok": True,
                    "content": "stdout:\nDone",
                    "data": {
                        "source": "code.execute",
                        "sandbox_id": "sbx-1",
                        "session_id": "sess-1",
                        "stdout": "Done\n",
                        "stderr": "",
                        "files_out": [
                            {
                                "path": "/output/summary.txt",
                                "content_b64": _b.standard_b64encode(b"hi from sandbox").decode(
                                    "ascii"
                                ),
                                "size": 15,
                            }
                        ],
                        "execution_ms": 12,
                    },
                },
            },
        )

    recorded = _patch_httpx(monkeypatch, handler)
    tool = code_module.make_code_execute_tool(str(tmp_path))
    # We test via the raw .func to bypass LangChain's ToolCall envelope
    # machinery (which adds friction around InjectedToolCallId /
    # RunnableConfig propagation). The agent-side wrapping is exercised
    # in integration via runs.py — what we care about here is the file
    # IO + gateway-proxy contract.
    result = await tool.coroutine(
        code="print('Done')",
        language="python",
        files_in=["sales.csv"],
        tool_call_id="call-v1",
        config={"configurable": {"thread_id": "run-v1"}},
    )

    # Outbound shape: files_in payload should contain the encoded bytes.
    assert len(recorded) == 1
    body = json.loads(recorded[0].content)
    assert body["arguments"]["code"] == "print('Done')"
    assert body["arguments"]["files_in"][0]["path"] == "sales.csv"
    import base64 as _b

    assert _b.standard_b64decode(body["arguments"]["files_in"][0]["content_b64"]) == (
        b"region,total\nAPAC,100\n"
    )

    # Result: files_out was synced to workspace/.code-output/<conv>/.
    assert result["ok"] is True
    expected = tmp_path / ".code-output" / "run-v1" / "summary.txt"
    assert expected.is_file()
    assert expected.read_bytes() == b"hi from sandbox"
    # content message references the local path so the LLM can mention
    # it to the user in the next turn.
    assert "summary.txt" in result["content"]


@pytest.mark.asyncio
async def test_code_execute_files_in_blacklisted_short_circuits(
    monkeypatch, settings_with_session, tmp_path
) -> None:
    """A .env file in files_in must fail before any HTTP call."""
    (tmp_path / ".env").write_text("SECRET=abc")
    recorded = _patch_httpx(monkeypatch, lambda _r: httpx.Response(500))
    tool = code_module.make_code_execute_tool(str(tmp_path))
    result = await tool.coroutine(
        code="print(1)",
        language="python",
        files_in=[".env"],
        tool_call_id="call-bl",
        config={"configurable": {"thread_id": "run-bl"}},
    )
    assert recorded == []  # never reached the gateway
    assert result["ok"] is False
    assert result["errorCode"] == "files_in_rejected"
    assert "sensitive" in result["content"]


@pytest.mark.asyncio
async def test_code_execute_path_escape_rejected(
    monkeypatch, settings_with_session, tmp_path
) -> None:
    recorded = _patch_httpx(monkeypatch, lambda _r: httpx.Response(500))
    tool = code_module.make_code_execute_tool(str(tmp_path))
    result = await tool.coroutine(
        code="print(1)",
        files_in=["../../etc/passwd"],
        tool_call_id="call-esc",
        config={"configurable": {"thread_id": "run-esc"}},
    )
    assert recorded == []
    assert result["ok"] is False
    assert result["errorCode"] == "files_in_rejected"
