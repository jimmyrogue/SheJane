"""System credential-store access for model provider API keys."""

from __future__ import annotations

import asyncio
import uuid

import keyring
from keyring.errors import KeyringError

_SERVICE = "SheJane Runtime model providers"


class CredentialStoreError(RuntimeError):
    pass


def credential_ref(provider_id: str, version: str | None = None) -> str:
    suffix = f":{version}" if version else ""
    return f"keyring:model-provider:{provider_id}{suffix}"


def new_credential_ref(provider_id: str) -> str:
    return credential_ref(provider_id, uuid.uuid4().hex)


def _account(
    principal_id: str,
    provider_id: str,
    credential_reference: str | None,
) -> str:
    # Preserve the account name used by databases created before versioned
    # credential refs. New refs are immutable and get their own keyring item.
    if not credential_reference or credential_reference == credential_ref(provider_id):
        return f"{principal_id}:{provider_id}"
    return f"{principal_id}:{credential_reference}"


async def get_model_api_key(
    principal_id: str,
    provider_id: str,
    credential_reference: str | None = None,
) -> str | None:
    try:
        return await asyncio.to_thread(
            keyring.get_password,
            _SERVICE,
            _account(principal_id, provider_id, credential_reference),
        )
    except KeyringError as exc:
        raise CredentialStoreError("system credential store is unavailable") from exc


async def set_model_api_key(
    principal_id: str,
    provider_id: str,
    api_key: str,
    credential_reference: str | None = None,
) -> None:
    try:
        await asyncio.to_thread(
            keyring.set_password,
            _SERVICE,
            _account(principal_id, provider_id, credential_reference),
            api_key,
        )
    except KeyringError as exc:
        raise CredentialStoreError("system credential store is unavailable") from exc


async def delete_model_api_key(
    principal_id: str,
    provider_id: str,
    credential_reference: str | None = None,
) -> None:
    try:
        await asyncio.to_thread(
            keyring.delete_password,
            _SERVICE,
            _account(principal_id, provider_id, credential_reference),
        )
    except keyring.errors.PasswordDeleteError:
        return
    except KeyringError as exc:
        raise CredentialStoreError("system credential store is unavailable") from exc
