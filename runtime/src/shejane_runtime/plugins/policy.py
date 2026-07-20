"""Deployment-owned publisher trust policy for signed plugin packages."""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from .package import SIGNATURE_PATH, InvalidPluginSignature, verify_package_signature


class PluginTrustError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class _TrustedPublisherKey(BaseModel):
    model_config = ConfigDict(extra="forbid")

    publisher_id: str = Field(
        min_length=3,
        max_length=200,
        pattern=r"^[a-z0-9]+(?:[.-][a-z0-9]+)+$",
    )
    key_id: str = Field(pattern=r"^ed25519:sha256:[0-9a-f]{64}$")
    public_key: str = Field(min_length=43, max_length=44)
    status: Literal["trusted", "revoked"] = "trusted"
    not_before: datetime | None = None
    expires_at: datetime | None = None

    @field_validator("not_before", "expires_at")
    @classmethod
    def require_timezone(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.tzinfo is None:
            raise ValueError("trust key timestamps require a timezone")
        return value


class _PluginTrustStore(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    keys: list[_TrustedPublisherKey] = Field(max_length=1024)

    @model_validator(mode="after")
    def require_unique_key_ids(self) -> _PluginTrustStore:
        key_ids = [key.key_id for key in self.keys]
        if len(key_ids) != len(set(key_ids)):
            raise ValueError("trust store key ids must be unique")
        return self


def verify_trusted_package(root: Path, publisher_id: str, trust_store_path: Path) -> str:
    try:
        if trust_store_path.stat().st_size > 1024 * 1024:
            raise PluginTrustError("plugin_trust_store_invalid", "plugin trust store is too large")
        trust_store = _PluginTrustStore.model_validate_json(
            trust_store_path.read_text(encoding="utf-8")
        )
        signature_path = root / SIGNATURE_PATH
        if signature_path.stat().st_size > 64 * 1024:
            raise PluginTrustError("plugin_signature_invalid", "plugin signature is too large")
        envelope = json.loads(signature_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise PluginTrustError(
            "plugin_signature_trust_unavailable",
            "signed plugin installation requires a configured trusted publisher key",
        ) from exc
    except (OSError, UnicodeError, json.JSONDecodeError, ValidationError) as exc:
        raise PluginTrustError(
            "plugin_trust_store_invalid", "plugin trust store or signature envelope is invalid"
        ) from exc
    if not isinstance(envelope, dict) or not isinstance(envelope.get("key_id"), str):
        raise PluginTrustError("plugin_signature_invalid", "plugin signature envelope is invalid")
    matching_id = [key for key in trust_store.keys if key.key_id == envelope["key_id"]]
    if not matching_id:
        raise PluginTrustError("plugin_signer_unknown", "plugin signing key is not trusted")
    key = next((item for item in matching_id if item.publisher_id == publisher_id), None)
    if key is None:
        raise PluginTrustError(
            "plugin_publisher_mismatch", "plugin publisher does not own the signing key"
        )
    if key.status == "revoked":
        raise PluginTrustError("plugin_signer_revoked", "plugin signing key is revoked")
    now = datetime.now(UTC)
    not_before = key.not_before.astimezone(UTC) if key.not_before else None
    expires_at = key.expires_at.astimezone(UTC) if key.expires_at else None
    if not_before is not None and now < not_before:
        raise PluginTrustError("plugin_signer_not_yet_valid", "plugin signing key is not yet valid")
    if expires_at is not None and now >= expires_at:
        raise PluginTrustError("plugin_signer_expired", "plugin signing key has expired")
    try:
        public_key = base64.b64decode(key.public_key, validate=True)
        if len(public_key) != 32:
            raise ValueError("invalid Ed25519 public key length")
        return verify_package_signature(root, envelope, public_key)
    except (InvalidPluginSignature, ValueError) as exc:
        raise PluginTrustError("plugin_signature_invalid", "plugin signature is invalid") from exc
