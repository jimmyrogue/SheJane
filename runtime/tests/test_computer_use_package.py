from __future__ import annotations

import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Any

import pytest

from shejane_runtime.plugins.computer_use import (
    COMPUTER_USE_PLUGIN_DIGEST,
    COMPUTER_USE_PLUGIN_ID,
    COMPUTER_USE_PLUGIN_VERSION,
    ComputerUseActionExecutor,
    ComputerUseError,
    ComputerUseService,
    is_allowed_computer_use_package,
)
from shejane_runtime.plugins.manifest import load_plugin_manifest
from shejane_runtime.store.sqlite import LocalStore

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "computer-use"


def test_computer_use_manifest_exposes_state_scoped_desktop_actions(tmp_path: Path) -> None:
    shutil.copytree(PLUGIN / "actions", tmp_path / "actions")
    shutil.copytree(PLUGIN / "commands", tmp_path / "commands")
    (tmp_path / ".shejane-plugin").mkdir()
    manifest = (PLUGIN / ".shejane-plugin" / "plugin.template.json").read_text()
    manifest = manifest.replace("__PLUGIN_VERSION__", "0.1.0").replace(
        "__PLATFORM__", "darwin/arm64"
    )
    (tmp_path / ".shejane-plugin" / "plugin.json").write_text(manifest)

    parsed = load_plugin_manifest(tmp_path)

    assert parsed.runtime.execution.kind == "builtin"
    assert parsed.runtime.execution.handler == "computer_use"
    assert [action.id for action in parsed.contributions.actions] == [
        "setup",
        "status",
        "find_roots",
        "observe_ui",
        "search_ui",
        "expand_ui",
        "inspect_ui",
        "act_ui",
        "read_text",
        "wait_for",
    ]
    assert next(
        action for action in parsed.contributions.actions if action.id == "act_ui"
    ).capabilities == ["computer.control"]


def test_computer_use_builtin_requires_the_exact_audited_package() -> None:
    identity = {
        "plugin_id": COMPUTER_USE_PLUGIN_ID,
        "version": COMPUTER_USE_PLUGIN_VERSION,
        "handler": "computer_use",
    }
    assert is_allowed_computer_use_package(digest=COMPUTER_USE_PLUGIN_DIGEST, **identity)
    assert not is_allowed_computer_use_package(digest="sha256:" + "0" * 64, **identity)


@pytest.mark.asyncio
async def test_computer_use_executor_preserves_plugin_result_identity(tmp_path: Path) -> None:
    class FakeService:
        async def call(
            self, action: str, arguments: dict[str, Any], *, timeout_ms: int
        ) -> dict[str, Any]:
            assert (action, arguments, timeout_ms) == ("status", {}, 15_000)
            return {"text": "ready", "details": {"accessibility": True}}

    executor = ComputerUseActionExecutor(FakeService(), "status")  # type: ignore[arg-type]
    result = await executor.invoke(
        {
            "invocation_id": "invocation-1",
            "operation_id": "operation-1",
            "arguments": {},
            "limits": {"timeout_ms": 15_000},
        },
        input_root=tmp_path,
        output_root=tmp_path,
    )

    assert result == {
        "schema_version": 1,
        "invocation_id": "invocation-1",
        "operation_id": "operation-1",
        "status": "succeeded",
        "output": {"text": "ready", "details": {"accessibility": True}},
        "artifacts": [],
    }


@pytest.mark.asyncio
async def test_computer_use_service_rejects_oversized_response(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    package = tmp_path / "package"
    bridge = package / "payload" / "bridge-server.mjs"
    bridge.parent.mkdir(parents=True)
    bridge.write_text(
        "import sys\n"
        "sys.stdin.readline()\n"
        'sys.stdout.write(\'{"id":1,"result":{"text":"\' + \'x\' * 128 + \'"}}\\n\')\n'
        "sys.stdout.flush()\n"
    )
    monkeypatch.setenv("SHEJANE_RUNTIME_NODE_PATH", sys.executable)
    monkeypatch.setattr("shejane_runtime.plugins.computer_use.MAX_FRAME_BYTES", 64)
    service = ComputerUseService(package, workspace_root=tmp_path)

    try:
        with pytest.raises(ComputerUseError, match="response exceeds the protocol limit"):
            await service.call("status", {}, timeout_ms=1_000)
    finally:
        await service.aclose()


@pytest.mark.asyncio
async def test_existing_plugin_table_migrates_to_builtin_execution(tmp_path: Path) -> None:
    database = tmp_path / "runtime.sqlite3"
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE plugin_versions ("
            "plugin_id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL UNIQUE, "
            "manifest_json TEXT NOT NULL, execution_kind TEXT NOT NULL "
            "CHECK (execution_kind IN ('wasi', 'managed_worker')), "
            "signature_status TEXT NOT NULL CHECK (signature_status IN ('unsigned', 'verified')), "
            "signer_key_id TEXT, compatibility TEXT NOT NULL "
            "CHECK (compatibility IN ('compatible', 'incompatible')), source TEXT NOT NULL, "
            "state TEXT NOT NULL CHECK (state IN ('installed', 'retired')), "
            "created_at TEXT NOT NULL, updated_at TEXT NOT NULL, retired_at TEXT, "
            "PRIMARY KEY (plugin_id, digest), UNIQUE (plugin_id, version))"
        )
        connection.execute(
            "INSERT INTO plugin_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "dev.shejane.fixture.archive",
                "0.1.0",
                "sha256:" + "a" * 64,
                "{}",
                "wasi",
                "unsigned",
                None,
                "compatible",
                "local_file",
                "installed",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z",
                None,
            ),
        )
        connection.execute(
            "CREATE TABLE plugin_installations ("
            "principal_id TEXT NOT NULL, plugin_id TEXT NOT NULL, active_digest TEXT NOT NULL, "
            "enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)), source TEXT NOT NULL, "
            "revision INTEGER NOT NULL DEFAULT 1, model_binding_json TEXT, "
            "model_binding_revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, "
            "updated_at TEXT NOT NULL, retired_at TEXT, PRIMARY KEY (principal_id, plugin_id), "
            "FOREIGN KEY (active_digest) REFERENCES plugin_versions(digest))"
        )
        connection.execute(
            "INSERT INTO plugin_installations VALUES (?, ?, ?, 1, ?, 1, NULL, 0, ?, ?, NULL)",
            (
                "local:owner",
                "dev.shejane.fixture.archive",
                "sha256:" + "a" * 64,
                "local_file",
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z",
            ),
        )

    store = await LocalStore.open(database)
    await store.close()

    with sqlite3.connect(database) as connection:
        schema = connection.execute(
            "SELECT sql FROM sqlite_master WHERE name = 'plugin_versions'"
        ).fetchone()[0]
        row = connection.execute("SELECT plugin_id, execution_kind FROM plugin_versions").fetchone()
        active = connection.execute(
            "SELECT plugin_id, enabled FROM plugin_installations"
        ).fetchone()
    assert "'builtin'" in schema
    assert row == ("dev.shejane.fixture.archive", "wasi")
    assert active == ("dev.shejane.fixture.archive", 1)
