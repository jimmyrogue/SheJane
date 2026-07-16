from __future__ import annotations

import base64
import hashlib
import json
import zipfile
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from local_host.config import reset_settings_for_tests
from local_host.plugins.package import canonical_package_digest, extract_plugin_archive
from local_host.plugins.sources import (
    InvalidPluginSource,
    PluginSourceIndex,
    VerifiedPluginSource,
)
from local_host.server import create_app

AUTH = {"Authorization": "Bearer tok"}
REPO_ROOT = Path(__file__).resolve().parents[3]
ARCHIVE_FIXTURE = REPO_ROOT / "plugins" / "fixtures" / "wasi-archive"


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    settings = reset_settings_for_tests(
        SHEJANE_LOCAL_HOST_TOKEN="tok",
        data_dir=tmp_path / "runtime",
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def _snapshot(public_key: bytes, *, version: str) -> VerifiedPluginSource:
    index = PluginSourceIndex.model_validate(
        {
            "schema_version": 1,
            "source": {"id": "dev.shejane.source", "name": "SheJane source"},
            "packages": [
                {
                    "plugin_id": "dev.shejane.fixture.archive",
                    "version": version,
                    "name": "Archive fixture",
                    "publisher_id": "dev.shejane",
                    "runtime_min_version": "0.1.0",
                    "execution_kind": "wasi",
                    "platform": "any",
                    "package_url": f"https://example.test/archive-{version}.shejane-plugin",
                    "package_size_bytes": 1024,
                    "package_digest": "sha256:" + ("a" if version == "0.1.0" else "c") * 64,
                    "signer_key_id": "ed25519:sha256:" + "b" * 64,
                    "capabilities": ["artifact.write", "input.read"],
                    "consumes": ["application/zip"],
                    "produces": ["application/octet-stream"],
                    "release_notes": f"Release {version}.",
                }
            ],
        }
    )
    raw_index = json.dumps(index.model_dump(mode="json"), sort_keys=True).encode()
    return VerifiedPluginSource(
        index=index,
        raw_index=raw_index,
        raw_signature=b"{}",
        index_sha256=hashlib.sha256(raw_index).hexdigest(),
        key_id="ed25519:sha256:" + hashlib.sha256(public_key).hexdigest(),
    )


def _signed_package(tmp_path: Path, *, version: str = "0.1.0") -> tuple[Path, str, str, bytes]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    unsigned = tmp_path / "unsigned.shejane-plugin"
    package_root = tmp_path / "signed-root"
    signed = tmp_path / "signed.shejane-plugin"
    with zipfile.ZipFile(unsigned, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(ARCHIVE_FIXTURE.rglob("*")):
            if path.is_file() and "target" not in path.parts:
                archive.write(path, path.relative_to(ARCHIVE_FIXTURE).as_posix())
    extract_plugin_archive(unsigned, package_root)
    manifest_path = package_root / ".shejane-plugin" / "plugin.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["version"] = version
    manifest_path.write_text(json.dumps(manifest))
    digest = canonical_package_digest(package_root)
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key().public_bytes_raw()
    key_id = "ed25519:sha256:" + hashlib.sha256(public_key).hexdigest()
    signature = private_key.sign(b"shejane-plugin-signature-v1\0" + digest.encode())
    signature_path = package_root / ".shejane-plugin" / "signature.json"
    signature_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "algorithm": "ed25519",
                "key_id": key_id,
                "package_digest": digest,
                "signature": base64.b64encode(signature).decode(),
            }
        )
    )
    with zipfile.ZipFile(signed, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(package_root.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(package_root).as_posix())
    return signed, digest, key_id, public_key


def test_installs_an_exact_signed_package_from_a_verified_source(
    client: TestClient,
    monkeypatch,
    tmp_path: Path,
) -> None:
    package, digest, signer_key_id, signer_public_key = _signed_package(tmp_path / "v1")
    package_v2, digest_v2, signer_key_id_v2, signer_public_key_v2 = _signed_package(
        tmp_path / "v2", version="0.2.0"
    )
    source_public_key = b"s" * 32

    def make_snapshot(
        *, version: str, archive: Path, package_digest: str, package_signer: str
    ) -> VerifiedPluginSource:
        index = PluginSourceIndex.model_validate(
            {
                "schema_version": 1,
                "source": {"id": "dev.shejane.source", "name": "SheJane source"},
                "packages": [
                    {
                        "plugin_id": "dev.shejane.fixture.archive",
                        "version": version,
                        "name": "Archive fixture",
                        "publisher_id": "dev.shejane",
                        "runtime_min_version": "0.1.0",
                        "execution_kind": "wasi",
                        "platform": "any",
                        "package_url": f"https://example.test/archive-{version}.shejane-plugin",
                        "package_size_bytes": archive.stat().st_size,
                        "package_digest": package_digest,
                        "signer_key_id": package_signer,
                        "capabilities": ["artifact.write", "input.read"],
                        "consumes": ["application/zip"],
                        "produces": ["application/octet-stream"],
                        "release_notes": f"Release {version}.",
                    }
                ],
            }
        )
        raw_index = json.dumps(index.model_dump(mode="json"), sort_keys=True).encode()
        return VerifiedPluginSource(
            index=index,
            raw_index=raw_index,
            raw_signature=b"{}",
            index_sha256=hashlib.sha256(raw_index).hexdigest(),
            key_id="ed25519:sha256:" + hashlib.sha256(source_public_key).hexdigest(),
        )

    snapshot = make_snapshot(
        version="0.1.0",
        archive=package,
        package_digest=digest,
        package_signer=signer_key_id,
    )

    async def fetch_source(*_args):
        return snapshot

    downloads = 0

    async def fetch_package(url: str, expected_size: int) -> bytes:
        nonlocal downloads
        downloads += 1
        packages = {
            "https://example.test/archive-0.1.0.shejane-plugin": package,
            "https://example.test/archive-0.2.0.shejane-plugin": package_v2,
        }
        selected = packages[url]
        assert expected_size == selected.stat().st_size
        return selected.read_bytes()

    monkeypatch.setattr("local_host.plugins.registry.fetch_verified_source", fetch_source)
    monkeypatch.setattr("local_host.plugins.registry.fetch_source_package", fetch_package)
    trust_store = tmp_path / "runtime" / "plugins" / "trusted-publishers.json"
    trust_store.parent.mkdir(parents=True, exist_ok=True)
    trust_store.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "keys": [
                    {
                        "publisher_id": "dev.shejane",
                        "key_id": key_id,
                        "public_key": base64.b64encode(public_key).decode(),
                        "status": "trusted",
                    }
                    for key_id, public_key in (
                        (signer_key_id, signer_public_key),
                        (signer_key_id_v2, signer_public_key_v2),
                    )
                ],
            }
        )
    )
    added = client.post(
        "/local/v1/commands",
        headers=AUTH,
        json={
            "type": "plugin.source.add",
            "command_id": "cmd_source_add_for_install",
            "index_url": "https://example.test/index.json",
            "signature_url": "https://example.test/index.sig.json",
            "public_key": base64.b64encode(source_public_key).decode(),
        },
    )
    assert added.status_code == 200, added.text
    command = {
        "type": "plugin.source.install",
        "command_id": "cmd_source_install",
        "source_id": "dev.shejane.source",
        "expected_revision": 1,
        "plugin_id": "dev.shejane.fixture.archive",
        "version": "0.1.0",
        "execution_kind": "wasi",
        "platform": "any",
        "package_digest": digest,
    }
    installed = client.post("/local/v1/commands", headers=AUTH, json=command)
    assert installed.status_code == 200, installed.text
    assert installed.json()["type"] == "plugin.source.install"
    assert installed.json()["source_id"] == "dev.shejane.source"
    assert client.post("/local/v1/commands", headers=AUTH, json=command).json() == installed.json()
    assert downloads == 1
    listed = client.get("/local/v1/plugins", headers=AUTH).json()["plugins"]
    assert listed[0]["digest"] == digest
    assert listed[0]["signature_status"] == "verified"
    snapshot = make_snapshot(
        version="0.2.0",
        archive=package_v2,
        package_digest=digest_v2,
        package_signer=signer_key_id_v2,
    )
    refreshed = client.post(
        "/local/v1/commands",
        headers=AUTH,
        json={
            "type": "plugin.source.refresh",
            "command_id": "cmd_source_refresh_for_update",
            "source_id": "dev.shejane.source",
            "expected_revision": 1,
        },
    )
    assert refreshed.status_code == 200, refreshed.text
    updated = client.post(
        "/local/v1/commands",
        headers=AUTH,
        json={
            **command,
            "command_id": "cmd_source_install_update",
            "expected_revision": 2,
            "version": "0.2.0",
            "package_digest": digest_v2,
            "expected_active_digest": digest,
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["previous_digest"] == digest
    assert updated.json()["digest"] == digest_v2
    assert client.get("/local/v1/plugins", headers=AUTH).json()["plugins"][0]["digest"] == digest_v2
    assert downloads == 2
    stale = client.post(
        "/local/v1/commands",
        headers=AUTH,
        json={**command, "command_id": "cmd_source_install_stale", "expected_revision": 3},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "plugin_source_revision_conflict"
    assert downloads == 2


def test_source_commands_are_idempotent_and_keep_last_known_good(
    client: TestClient,
    monkeypatch,
    tmp_path: Path,
) -> None:
    public_key = b"k" * 32
    current = _snapshot(public_key, version="0.1.0")
    fetches = 0

    async def fetch(_index_url: str, _signature_url: str, supplied_key: bytes):
        nonlocal fetches
        fetches += 1
        assert supplied_key == public_key
        return current

    monkeypatch.setattr("local_host.plugins.registry.fetch_verified_source", fetch)
    add = {
        "type": "plugin.source.add",
        "command_id": "cmd_source_add",
        "index_url": "https://example.test/index.json",
        "signature_url": "https://example.test/index.sig.json",
        "public_key": base64.b64encode(public_key).decode(),
    }
    first = client.post("/local/v1/commands", headers=AUTH, json=add)
    assert first.status_code == 200, first.text
    assert first.json()["source_id"] == "dev.shejane.source"
    assert first.json()["revision"] == 1
    assert client.post("/local/v1/commands", headers=AUTH, json=add).json() == first.json()
    assert fetches == 1

    detail = client.get("/local/v1/plugin-sources/dev.shejane.source", headers=AUTH)
    assert detail.status_code == 200
    assert detail.json()["packages"][0]["version"] == "0.1.0"

    current = _snapshot(public_key, version="0.2.0")
    refresh = {
        "type": "plugin.source.refresh",
        "command_id": "cmd_source_refresh",
        "source_id": "dev.shejane.source",
        "expected_revision": 1,
    }
    refreshed = client.post("/local/v1/commands", headers=AUTH, json=refresh)
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["revision"] == 2
    assert refreshed.json()["changed"] is True

    unchanged = client.post(
        "/local/v1/commands",
        headers=AUTH,
        json={**refresh, "command_id": "cmd_source_refresh_unchanged", "expected_revision": 2},
    )
    assert unchanged.status_code == 200
    assert unchanged.json()["revision"] == 2
    assert unchanged.json()["changed"] is False

    async def fail(*_args):
        raise InvalidPluginSource("source unavailable")

    monkeypatch.setattr("local_host.plugins.registry.fetch_verified_source", fail)
    failed = client.post(
        "/local/v1/commands",
        headers=AUTH,
        json={**refresh, "command_id": "cmd_source_refresh_failed", "expected_revision": 2},
    )
    assert failed.status_code == 409
    listed = client.get("/local/v1/plugin-sources", headers=AUTH).json()["sources"]
    assert listed[0]["revision"] == 2
    assert listed[0]["index_sha256"] == current.index_sha256

    package = tmp_path / "archive.shejane-plugin"
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(ARCHIVE_FIXTURE.rglob("*")):
            if path.is_file() and "target" not in path.parts:
                archive.write(path, path.relative_to(ARCHIVE_FIXTURE).as_posix())
    installed = client.post(
        "/local/v1/commands",
        headers=AUTH,
        json={
            "type": "plugin.install",
            "command_id": "cmd_plugin_install_before_source_remove",
            "source_path": str(package),
            "allow_unsigned": True,
        },
    )
    assert installed.status_code == 200, installed.text

    removed = client.post(
        "/local/v1/commands",
        headers=AUTH,
        json={
            "type": "plugin.source.remove",
            "command_id": "cmd_source_remove",
            "source_id": "dev.shejane.source",
            "expected_revision": 2,
        },
    )
    assert removed.status_code == 200, removed.text
    assert client.get("/local/v1/plugin-sources", headers=AUTH).json() == {"sources": []}
    assert len(client.get("/local/v1/plugins", headers=AUTH).json()["plugins"]) == 1
