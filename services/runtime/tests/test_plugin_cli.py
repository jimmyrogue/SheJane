from __future__ import annotations

import json
from pathlib import Path

from local_host.plugin_cli import main

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = REPO_ROOT / "plugins" / "fixtures" / "wasi-archive"


def test_validate_pack_and_inspect_share_one_canonical_identity(
    tmp_path: Path,
    capsys,
) -> None:
    assert main(["validate", str(FIXTURE)]) == 0
    validated = json.loads(capsys.readouterr().out)

    first = tmp_path / "first.shejane-plugin"
    second = tmp_path / "second.shejane-plugin"
    assert main(["pack", str(FIXTURE), "--output", str(first)]) == 0
    packed = json.loads(capsys.readouterr().out)
    assert main(["pack", str(FIXTURE), "--output", str(second)]) == 0
    capsys.readouterr()

    assert first.read_bytes() == second.read_bytes()
    assert main(["inspect", str(first)]) == 0
    inspected = json.loads(capsys.readouterr().out)
    assert validated == {
        "digest": packed["digest"],
        "execution_kind": "wasi",
        "id": "dev.shejane.fixture.archive",
        "platforms": ["any"],
        "signature": {"status": "unsigned"},
        "version": "0.1.0",
    }
    assert inspected == validated
