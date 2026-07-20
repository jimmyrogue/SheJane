from __future__ import annotations

import json
import stat
import zipfile
from pathlib import Path

import pytest

from shejane_runtime.plugins.package import InvalidPluginPackage
from shejane_runtime.plugins.platforms import current_managed_worker_execution_platform
from shejane_runtime.plugins.runtime_assets import (
    _MAX_ASSET_ARCHIVE_BYTES,
    RuntimeAssetStore,
    canonical_runtime_asset_digest,
)


def _asset_tree(root: Path, *, platform: str | None = None) -> Path:
    target = platform or current_managed_worker_execution_platform() or "linux/arm64"
    manifest = {
        "schema_version": 1,
        "id": "org.libreoffice.runtime",
        "version": "25.8.7",
        "platform": target,
        "license": "MPL-2.0",
        "source_url": "https://www.libreoffice.org/download/download-libreoffice/",
        "payload": "payload/libreoffice",
        "sbom": ".shejane-runtime-asset/sbom.spdx.json",
    }
    metadata = root / ".shejane-runtime-asset"
    metadata.mkdir(parents=True)
    (metadata / "asset.json").write_text(json.dumps(manifest), encoding="utf-8")
    (metadata / "sbom.spdx.json").write_text(
        json.dumps({"spdxVersion": "SPDX-2.3"}),
        encoding="utf-8",
    )
    payload = root / "payload" / "libreoffice"
    payload.mkdir(parents=True)
    (payload / "program.bin").write_bytes(b"pinned engine")
    return root


def _pack(source: Path, destination: Path) -> None:
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(source).as_posix())


def _append_link(archive_path: Path, name: str, target: str) -> None:
    with zipfile.ZipFile(archive_path, "a", zipfile.ZIP_DEFLATED) as archive:
        info = zipfile.ZipInfo(name)
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(info, target)


def _append_directory(archive_path: Path, name: str) -> None:
    with zipfile.ZipFile(archive_path, "a", zipfile.ZIP_DEFLATED) as archive:
        info = zipfile.ZipInfo(name.rstrip("/") + "/")
        info.create_system = 3
        info.external_attr = (stat.S_IFDIR | 0o700) << 16
        archive.writestr(info, b"")


def test_runtime_asset_archive_limit_is_separate_from_plugin_packages() -> None:
    assert _MAX_ASSET_ARCHIVE_BYTES == 768 * 1024 * 1024


def test_runtime_asset_store_installs_and_resolves_exact_digest(tmp_path: Path) -> None:
    source = _asset_tree(tmp_path / "source")
    archive = tmp_path / "libreoffice.shejane-runtime-asset"
    _pack(source, archive)
    store = RuntimeAssetStore(tmp_path / "data")

    first = store.install(archive)
    replay = store.install(archive)
    resolved = store.resolve(
        asset_id="org.libreoffice.runtime",
        version="25.8.7",
        platform=first.platform,
        digest=first.digest,
    )

    assert first == replay
    assert resolved == first
    assert first.digest == canonical_runtime_asset_digest(first.root)
    assert first.payload == first.root / "payload" / "libreoffice"
    assert (first.payload / "program.bin").read_bytes() == b"pinned engine"


def test_runtime_asset_store_rejects_wrong_platform(tmp_path: Path) -> None:
    current = current_managed_worker_execution_platform()
    wrong = "windows/amd64" if current != "windows/amd64" else "darwin/arm64"
    source = _asset_tree(tmp_path / "source", platform=wrong)
    archive = tmp_path / "wrong.shejane-runtime-asset"
    _pack(source, archive)

    with pytest.raises(InvalidPluginPackage, match="does not target this platform"):
        RuntimeAssetStore(tmp_path / "data").install(archive)


def test_runtime_asset_store_preserves_only_internal_relative_links(tmp_path: Path) -> None:
    source = _asset_tree(tmp_path / "source")
    archive = tmp_path / "libreoffice.shejane-runtime-asset"
    _pack(source, archive)
    _append_link(archive, "payload/libreoffice/program-link", "program.bin")
    _append_directory(archive, "payload/libreoffice/empty-profile")

    installed = RuntimeAssetStore(tmp_path / "data").install(archive)

    link = installed.payload / "program-link"
    assert link.is_symlink()
    assert link.resolve(strict=True) == installed.payload / "program.bin"
    assert (installed.payload / "empty-profile").is_dir()


def test_runtime_asset_store_rejects_escaping_links(tmp_path: Path) -> None:
    source = _asset_tree(tmp_path / "source")
    archive = tmp_path / "libreoffice.shejane-runtime-asset"
    _pack(source, archive)
    _append_link(archive, "payload/libreoffice/escape", "../../../outside")

    with pytest.raises(InvalidPluginPackage, match="link escapes"):
        RuntimeAssetStore(tmp_path / "data").install(archive)


def test_runtime_asset_store_detects_tampering_before_lease(tmp_path: Path) -> None:
    source = _asset_tree(tmp_path / "source")
    archive = tmp_path / "libreoffice.shejane-runtime-asset"
    _pack(source, archive)
    store = RuntimeAssetStore(tmp_path / "data")
    installed = store.install(archive)
    (installed.payload / "program.bin").write_bytes(b"tampered")

    with pytest.raises(InvalidPluginPackage, match="digest changed"):
        store.resolve(
            asset_id=installed.asset_id,
            version=installed.version,
            platform=installed.platform,
            digest=installed.digest,
        )
    with pytest.raises(InvalidPluginPackage, match="digest changed"):
        store.install(archive)


def test_runtime_asset_archive_rejects_traversal(tmp_path: Path) -> None:
    archive = tmp_path / "bad.shejane-runtime-asset"
    with zipfile.ZipFile(archive, "w") as package:
        package.writestr(".shejane-runtime-asset/asset.json", "{}")
        package.writestr("../escape", "bad")

    with pytest.raises(InvalidPluginPackage):
        RuntimeAssetStore(tmp_path / "data").install(archive)
    assert not (tmp_path / "escape").exists()
