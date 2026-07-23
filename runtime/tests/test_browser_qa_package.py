from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

from shejane_runtime.plugins.manifest import PluginManifest
from shejane_runtime.plugins.package import extract_plugin_archive
from shejane_runtime.plugins.runtime_assets import RuntimeAssetStore

REPO_ROOT = Path(__file__).resolve().parents[2]
ROOT = REPO_ROOT / "runtime" / "plugins" / "browser-qa"
BUILDER = ROOT / "build_package.py"
ASSET_BUILDER = ROOT / "build_runtime_asset.py"


def test_browser_qa_manifest_exposes_only_bounded_actions() -> None:
    template = (ROOT / ".shejane-plugin" / "plugin.template.json").read_text(encoding="utf-8")
    manifest = PluginManifest.model_validate_json(
        template.replace("__PLUGIN_VERSION__", "0.1.0")
        .replace("__PLATFORM__", "darwin/arm64")
        .replace("__RUNTIME_ASSET_DIGEST__", "sha256:" + "a" * 64)
    )

    assert manifest.runtime.execution.kind == "builtin"
    assert manifest.runtime.execution.handler == "browser_qa"
    assert manifest.runtime.execution.runtime_assets[0].id == "org.shejane.browser-qa.runtime"
    assert {action.id for action in manifest.contributions.actions} == {
        "open",
        "observe",
        "act",
        "inspect",
        "close",
    }
    for action in manifest.contributions.actions:
        for relative in (action.input_schema, action.output_schema):
            schema = json.loads((ROOT / relative).read_text(encoding="utf-8"))
            Draft202012Validator.check_schema(schema)
            assert schema["additionalProperties"] is False


def test_browser_qa_package_is_deterministic(tmp_path: Path) -> None:
    playwright = tmp_path / "playwright"
    playwright_core = tmp_path / "playwright-core"
    for root, name in (
        (playwright, "playwright"),
        (playwright_core, "playwright-core"),
    ):
        root.mkdir()
        (root / "package.json").write_text(
            json.dumps({"name": name, "version": "1.61.1"}), encoding="utf-8"
        )
        (root / "index.js").write_text("module.exports = {};\n", encoding="utf-8")
    outputs = [tmp_path / "first.shejane-plugin", tmp_path / "second.shejane-plugin"]
    for output in outputs:
        subprocess.run(
            [
                sys.executable,
                str(BUILDER),
                "--platform",
                "darwin/arm64",
                "--playwright",
                str(playwright),
                "--playwright-core",
                str(playwright_core),
                "--runtime-asset-digest",
                "sha256:" + "a" * 64,
                "--output",
                str(output),
            ],
            check=True,
        )

    assert outputs[0].read_bytes() == outputs[1].read_bytes()
    extracted = tmp_path / "extracted"
    extract_plugin_archive(outputs[0], extracted)
    assert (extracted / "payload/bridge-server.mjs").is_file()
    assert (extracted / "payload/node_modules/playwright/package.json").is_file()
    assert (extracted / "payload/node_modules/playwright-core/package.json").is_file()
    assert not (extracted / "payload/browsers").exists()


def test_browser_qa_runtime_asset_is_deterministic_and_content_addressed(
    tmp_path: Path,
) -> None:
    browser = tmp_path / "chromium-1228"
    headless_shell = tmp_path / "chromium_headless_shell-1228"
    for root in (browser, headless_shell):
        root.mkdir()
        executable = root / "chrome"
        executable.write_bytes(b"browser")
        executable.chmod(0o500)
    outputs = [
        tmp_path / "first.shejane-runtime-asset",
        tmp_path / "second.shejane-runtime-asset",
    ]
    for output in outputs:
        subprocess.run(
            [
                sys.executable,
                str(ASSET_BUILDER),
                "--browser",
                str(browser),
                "--headless-shell",
                str(headless_shell),
                "--output",
                str(output),
            ],
            check=True,
        )

    assert outputs[0].read_bytes() == outputs[1].read_bytes()
    installed = RuntimeAssetStore(tmp_path / "asset-store").install(
        outputs[0], target_platform="darwin/arm64"
    )
    assert installed.asset_id == "org.shejane.browser-qa.runtime"
    assert installed.version == "1.61.1+chromium1228.1"
    assert (installed.payload / "browsers/chromium-1228/chrome").is_file()
