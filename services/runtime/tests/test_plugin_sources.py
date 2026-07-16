from __future__ import annotations

import base64
import hashlib
import json

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from local_host.plugins.sources import (
    InvalidPluginSource,
    fetch_source_package,
    fetch_verified_source,
    verify_source_index,
)


def _signed_source() -> tuple[bytes, bytes, bytes]:
    index = {
        "schema_version": 1,
        "source": {"id": "dev.shejane.source", "name": "SheJane test source"},
        "packages": [
            {
                "plugin_id": "dev.shejane.fixture.archive",
                "version": "0.1.0",
                "name": "Archive fixture",
                "publisher_id": "dev.shejane",
                "runtime_min_version": "0.1.0",
                "execution_kind": "wasi",
                "platform": "any",
                "package_url": "https://example.test/archive-0.1.0.shejane-plugin",
                "package_size_bytes": 1024,
                "package_digest": "sha256:" + "a" * 64,
                "signer_key_id": "ed25519:sha256:" + "b" * 64,
                "capabilities": ["artifact.write", "input.read"],
                "consumes": ["application/zip"],
                "produces": ["application/octet-stream"],
                "release_notes": "Initial release.",
            }
        ],
    }
    raw_index = json.dumps(index, sort_keys=True, separators=(",", ":")).encode()
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key().public_bytes_raw()
    digest = hashlib.sha256(raw_index).hexdigest()
    key_id = "ed25519:sha256:" + hashlib.sha256(public_key).hexdigest()
    signature = private_key.sign(b"shejane-plugin-source-v1\0" + digest.encode())
    envelope = {
        "schema_version": 1,
        "algorithm": "ed25519",
        "key_id": key_id,
        "index_sha256": digest,
        "signature": base64.b64encode(signature).decode(),
    }
    return raw_index, json.dumps(envelope).encode(), public_key


def test_source_index_requires_out_of_band_key_and_exact_signed_bytes() -> None:
    raw_index, raw_signature, public_key = _signed_source()

    source = verify_source_index(raw_index, raw_signature, public_key)
    assert source.source.id == "dev.shejane.source"
    assert source.packages[0].platform == "any"

    tampered = raw_index.replace(b"Initial release", b"Unsafe release")
    with pytest.raises(InvalidPluginSource, match="digest"):
        verify_source_index(tampered, raw_signature, public_key)


def test_source_index_rejects_platform_kind_mismatch() -> None:
    raw_index, raw_signature, public_key = _signed_source()
    index = json.loads(raw_index)
    index["packages"][0]["execution_kind"] = "managed_worker"
    changed = json.dumps(index, sort_keys=True, separators=(",", ":")).encode()

    with pytest.raises(InvalidPluginSource):
        verify_source_index(changed, raw_signature, public_key)


@pytest.mark.asyncio
async def test_fetch_verified_source_uses_bounded_https_bytes(monkeypatch) -> None:
    raw_index, raw_signature, public_key = _signed_source()

    def handler(request: httpx.Request) -> httpx.Response:
        body = raw_index if request.url.path == "/index.json" else raw_signature
        return httpx.Response(200, content=body)

    monkeypatch.setattr(
        "local_host.plugins.sources._pinned_transport",
        lambda _url: (httpx.MockTransport(handler), ""),
    )
    snapshot = await fetch_verified_source(
        "https://example.test/index.json",
        "https://example.test/index.sig.json",
        public_key,
    )

    assert snapshot.index.source.id == "dev.shejane.source"
    assert snapshot.raw_index == raw_index
    assert snapshot.index_sha256 == hashlib.sha256(raw_index).hexdigest()

    monkeypatch.setattr("local_host.plugins.sources._MAX_INDEX_BYTES", 10)
    with pytest.raises(InvalidPluginSource, match="size limit"):
        await fetch_verified_source(
            "https://example.test/index.json",
            "https://example.test/index.sig.json",
            public_key,
        )


@pytest.mark.asyncio
async def test_fetch_source_package_requires_exact_archive_size(monkeypatch) -> None:
    monkeypatch.setattr(
        "local_host.plugins.sources._pinned_transport",
        lambda _url: (
            httpx.MockTransport(lambda _request: httpx.Response(200, content=b"zip")),
            "",
        ),
    )

    assert await fetch_source_package("https://example.test/plugin.shejane-plugin", 3) == b"zip"
    with pytest.raises(InvalidPluginSource, match="does not match"):
        await fetch_source_package("https://example.test/plugin.shejane-plugin", 4)
