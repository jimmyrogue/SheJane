from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from local_host.plugins.platforms import current_managed_worker_execution_platform
from local_host.plugins.runtime_assets import RuntimeAssetStore

REPO_ROOT = Path(__file__).resolve().parents[3]
BUILDER_PATH = REPO_ROOT / "plugins" / "office" / "runtime-assets" / "build_darwin.py"
LINUX_BUILDER_PATH = REPO_ROOT / "plugins" / "office" / "runtime-assets" / "build_linux_arm64.py"


def test_darwin_asset_packer_is_deterministic_and_preserves_layout(tmp_path: Path) -> None:
    spec = importlib.util.spec_from_file_location("office_asset_builder", BUILDER_PATH)
    assert spec and spec.loader
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)

    stage = tmp_path / "stage"
    metadata = stage / ".shejane-runtime-asset"
    payload = stage / "payload"
    metadata.mkdir(parents=True)
    payload.mkdir()
    (payload / "empty").mkdir()
    engine = payload / "engine"
    engine.write_bytes(b"engine")
    engine.chmod(0o700)
    (payload / "engine-link").symlink_to("engine")
    (metadata / "sbom.spdx.json").write_text("{}", encoding="utf-8")
    (metadata / "asset.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "id": "org.libreoffice.runtime",
                "version": "25.8.7",
                "platform": current_managed_worker_execution_platform() or "linux/arm64",
                "license": "MPL-2.0 AND AGPL-3.0-only AND OFL-1.1",
                "source_url": "https://www.libreoffice.org/",
                "payload": "payload",
                "sbom": ".shejane-runtime-asset/sbom.spdx.json",
                "executables": ["payload/engine"],
            }
        ),
        encoding="utf-8",
    )
    first = tmp_path / "first.shejane-runtime-asset"
    second = tmp_path / "second.shejane-runtime-asset"
    builder._pack_asset(stage, first)
    builder._pack_asset(stage, second)

    assert first.read_bytes() == second.read_bytes()
    installed = RuntimeAssetStore(tmp_path / "data").install(first)
    assert (installed.payload / "empty").is_dir()
    assert (installed.payload / "engine-link").resolve() == installed.payload / "engine"


def test_linux_asset_builder_marks_programs_but_not_shared_libraries_executable(
    tmp_path: Path,
) -> None:
    spec = importlib.util.spec_from_file_location("office_linux_asset_builder", LINUX_BUILDER_PATH)
    assert spec and spec.loader
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)

    stage = tmp_path / "stage"
    program = stage / "payload" / "libreoffice" / "program" / "soffice.bin"
    library = stage / "payload" / "libreoffice" / "program" / "libexample.so.1"
    mutool = stage / "payload" / "bin" / "mutool"
    for path in (program, library, mutool):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"binary")
        path.chmod(0o700)

    assert builder._asset_executables(stage) == [
        "payload/bin/mutool",
        "payload/libreoffice/program/soffice.bin",
    ]
