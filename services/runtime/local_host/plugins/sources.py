"""Strict, detached-signature verification for static plugin source indexes."""

from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass
from typing import Annotated, Literal
from urllib.parse import urljoin, urlsplit

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    ValidationError,
    field_validator,
    model_validator,
)

from ..tools.web import MAX_REDIRECTS, _pinned_transport
from .manifest import Capability, Digest, ManagedWorkerPlatform, MimeType, PluginId, Semver

_SIGNATURE_DOMAIN = b"shejane-plugin-source-v1\0"
_MAX_INDEX_BYTES = 8 * 1024 * 1024
_MAX_SIGNATURE_BYTES = 64 * 1024
_MAX_PACKAGE_BYTES = 64 * 1024 * 1024

KeyId = Annotated[str, Field(pattern=r"^ed25519:sha256:[0-9a-f]{64}$")]
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class InvalidPluginSource(ValueError):
    """A source index or its detached signature is invalid."""


@dataclass(frozen=True)
class VerifiedPluginSource:
    index: PluginSourceIndex
    raw_index: bytes
    raw_signature: bytes
    index_sha256: str
    key_id: str


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PluginSourceIdentity(_StrictModel):
    id: PluginId
    name: str = Field(min_length=1, max_length=100)


class PluginSourcePackage(_StrictModel):
    plugin_id: PluginId
    version: Semver
    name: str = Field(min_length=1, max_length=80)
    publisher_id: PluginId
    runtime_min_version: Semver
    execution_kind: Literal["wasi", "managed_worker"]
    platform: Literal["any"] | ManagedWorkerPlatform
    package_url: HttpUrl
    package_size_bytes: int = Field(ge=1, le=_MAX_PACKAGE_BYTES)
    package_digest: Digest
    signer_key_id: KeyId
    capabilities: list[Capability] = Field(max_length=32)
    consumes: list[MimeType] = Field(max_length=32)
    produces: list[MimeType] = Field(max_length=32)
    release_notes: str = Field(default="", max_length=10_000)

    @field_validator("package_url")
    @classmethod
    def require_https(cls, value: HttpUrl) -> HttpUrl:
        if value.scheme != "https":
            raise ValueError("plugin source packages require HTTPS")
        return value

    @model_validator(mode="after")
    def require_execution_platform_and_unique_summaries(self) -> PluginSourcePackage:
        if (self.execution_kind == "wasi") != (self.platform == "any"):
            raise ValueError(
                "WASI packages require platform any; Managed Workers require one platform"
            )
        for values in (self.capabilities, self.consumes, self.produces):
            if len(values) != len(set(values)):
                raise ValueError("plugin source package summaries must be unique")
        return self


class PluginSourceIndex(_StrictModel):
    schema_version: Literal[1]
    source: PluginSourceIdentity
    packages: list[PluginSourcePackage] = Field(max_length=10_000)

    @model_validator(mode="after")
    def require_unique_package_targets(self) -> PluginSourceIndex:
        targets = [
            (item.plugin_id, item.version, item.execution_kind, item.platform)
            for item in self.packages
        ]
        if len(targets) != len(set(targets)):
            raise ValueError("plugin source package targets must be unique")
        return self


class PluginSourceSignature(_StrictModel):
    schema_version: Literal[1]
    algorithm: Literal["ed25519"]
    key_id: KeyId
    index_sha256: Sha256
    signature: str = Field(min_length=88, max_length=88)


async def _fetch_bounded_https(url: str, limit: int) -> bytes:
    current_url = url
    try:
        for redirect_count in range(MAX_REDIRECTS + 1):
            if urlsplit(current_url).scheme != "https":
                raise InvalidPluginSource("plugin source URLs and redirects require HTTPS")
            transport, reason = _pinned_transport(current_url)
            if transport is None:
                raise InvalidPluginSource(f"plugin source URL is unsafe: {reason}")
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(15.0),
                follow_redirects=False,
                transport=transport,
            ) as client:
                async with client.stream("GET", current_url) as response:
                    location = response.headers.get("location")
                    if response.status_code in {301, 302, 303, 307, 308} and location:
                        if redirect_count >= MAX_REDIRECTS:
                            raise InvalidPluginSource("plugin source has too many redirects")
                        current_url = urljoin(current_url, location)
                        continue
                    if not 200 <= response.status_code < 300:
                        raise InvalidPluginSource(
                            f"plugin source returned HTTP {response.status_code}"
                        )
                    content_length = response.headers.get("content-length")
                    if content_length is not None:
                        try:
                            declared_length = int(content_length)
                        except ValueError as exc:
                            raise InvalidPluginSource(
                                "plugin source response has invalid content length"
                            ) from exc
                        if declared_length < 0:
                            raise InvalidPluginSource(
                                "plugin source response has invalid content length"
                            )
                        if declared_length > limit:
                            raise InvalidPluginSource("plugin source response exceeds size limit")
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > limit:
                            raise InvalidPluginSource("plugin source response exceeds size limit")
                    return bytes(body)
    except httpx.HTTPError as exc:
        raise InvalidPluginSource(f"plugin source request failed: {type(exc).__name__}") from exc
    raise InvalidPluginSource("plugin source has too many redirects")


async def fetch_verified_source(
    index_url: str,
    signature_url: str,
    public_key_bytes: bytes,
) -> VerifiedPluginSource:
    """Fetch and verify a source without mutating its last-known-good state."""

    raw_index = await _fetch_bounded_https(index_url, _MAX_INDEX_BYTES)
    raw_signature = await _fetch_bounded_https(signature_url, _MAX_SIGNATURE_BYTES)
    index = verify_source_index(raw_index, raw_signature, public_key_bytes)
    return VerifiedPluginSource(
        index=index,
        raw_index=raw_index,
        raw_signature=raw_signature,
        index_sha256=hashlib.sha256(raw_index).hexdigest(),
        key_id="ed25519:sha256:" + hashlib.sha256(public_key_bytes).hexdigest(),
    )


async def fetch_source_package(url: str, expected_size: int) -> bytes:
    """Fetch one catalog-pinned package and require its exact archive size."""

    if expected_size < 1 or expected_size > _MAX_PACKAGE_BYTES:
        raise InvalidPluginSource("plugin source package size is invalid")
    package = await _fetch_bounded_https(url, expected_size)
    if len(package) != expected_size:
        raise InvalidPluginSource("plugin source package size does not match its index")
    return package


def verify_source_index(
    raw_index: bytes,
    raw_signature: bytes,
    public_key_bytes: bytes,
) -> PluginSourceIndex:
    """Verify exact index bytes with one out-of-band trusted Ed25519 key."""

    if len(raw_index) > _MAX_INDEX_BYTES or len(raw_signature) > _MAX_SIGNATURE_BYTES:
        raise InvalidPluginSource("plugin source index or signature exceeds its size limit")
    if len(public_key_bytes) != 32:
        raise InvalidPluginSource("plugin source public key is invalid")
    try:
        index = PluginSourceIndex.model_validate_json(raw_index)
        envelope = PluginSourceSignature.model_validate_json(raw_signature)
    except ValidationError as exc:
        raise InvalidPluginSource("plugin source index or signature schema is invalid") from exc

    digest = hashlib.sha256(raw_index).hexdigest()
    key_id = "ed25519:sha256:" + hashlib.sha256(public_key_bytes).hexdigest()
    if envelope.index_sha256 != digest:
        raise InvalidPluginSource("plugin source index digest does not match its signature")
    if envelope.key_id != key_id:
        raise InvalidPluginSource("plugin source signing key does not match the trusted key")
    try:
        signature = base64.b64decode(envelope.signature, validate=True)
        if len(signature) != 64:
            raise ValueError("invalid Ed25519 signature length")
        Ed25519PublicKey.from_public_bytes(public_key_bytes).verify(
            signature,
            _SIGNATURE_DOMAIN + digest.encode("ascii"),
        )
    except (InvalidSignature, ValueError, TypeError) as exc:
        raise InvalidPluginSource("plugin source signature is invalid") from exc
    return index
