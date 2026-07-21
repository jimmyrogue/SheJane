from __future__ import annotations

import asyncio
import os
import shutil
import sys
from pathlib import Path

import pytest

from shejane_runtime.agent.backends import RuntimeLocalShellBackend


def test_agent_shell_fails_closed_without_a_sandbox_launcher(tmp_path: Path) -> None:
    backend = RuntimeLocalShellBackend(
        root_dir=tmp_path,
        virtual_mode=True,
        sandbox_launcher=None,
    )

    response = asyncio.run(backend.aexecute("touch escaped.txt"))

    assert response.exit_code == 1
    assert "sandbox is unavailable" in response.output
    assert not (tmp_path / "escaped.txt").exists()


@pytest.mark.skipif(sys.platform != "darwin", reason="packaged macOS sandbox proof")
def test_agent_shell_can_read_workspace_but_cannot_modify_it(tmp_path: Path) -> None:
    node = shutil.which("node")
    cli = (
        Path(__file__).resolve().parents[2]
        / "client"
        / "node_modules"
        / "@anthropic-ai"
        / "sandbox-runtime"
        / "dist"
        / "cli.js"
    )
    if node is None or not cli.is_file():
        pytest.skip("sandbox runtime development dependency is unavailable")
    existing = tmp_path / "existing.txt"
    existing.write_text("visible", encoding="utf-8")
    backend = RuntimeLocalShellBackend(
        root_dir=tmp_path,
        virtual_mode=True,
        sandbox_launcher=(node, str(cli)),
        env={"PATH": os.environ["PATH"], "LANG": "C.UTF-8"},
    )

    readable = asyncio.run(backend.aexecute("cat existing.txt"))
    blocked = asyncio.run(backend.aexecute("printf changed > escaped.txt"))

    assert readable.exit_code == 0
    assert "visible" in readable.output
    assert blocked.exit_code != 0
    assert not (tmp_path / "escaped.txt").exists()
