"""Runtime-owned plugin installation and query control plane."""

from __future__ import annotations

import asyncio
import base64
import binascii
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from packaging.version import InvalidVersion, Version

from ..store.sqlite import LocalStore, PluginStateError, PluginVersionConflictError
from .manifest import load_plugin_manifest
from .package import (
    SIGNATURE_PATH,
    InvalidPluginPackage,
    canonical_package_digest,
    extract_plugin_archive,
)
from .platforms import (
    current_managed_worker_execution_platform,
    current_managed_worker_platform,
    prepare_managed_worker_entrypoint,
)
from .policy import PluginTrustError, verify_trusted_package
from .runtime_assets import RuntimeAssetStore
from .sandbox_runtime import managed_worker_release_gate
from .sources import (
    InvalidPluginSource,
    PluginSourceIndex,
    PluginSourcePackage,
    fetch_source_package,
    fetch_verified_source,
)


class PluginRegistryError(RuntimeError):
    def __init__(self, code: str, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


@dataclass(frozen=True)
class _PreparedPackage:
    manifest: dict[str, Any]
    digest: str
    compatibility: str
    signature_status: str
    signer_key_id: str | None
    destination: Path
    created_blob: bool


class PluginRegistry:
    def __init__(self, *, store: LocalStore, data_dir: Path, runtime_version: str) -> None:
        self._store = store
        self._root = data_dir / "plugins"
        self._runtime_version = runtime_version
        self._runtime_assets = RuntimeAssetStore(data_dir)

    async def add_source(
        self,
        *,
        principal_id: str,
        command_id: str,
        index_url: str,
        signature_url: str,
        public_key: str,
    ) -> dict[str, Any]:
        command_payload = {
            "type": "plugin.source.add",
            "index_url": index_url,
            "signature_url": signature_url,
            "public_key": public_key,
        }
        replay = await self._store.accepted_command_receipt(
            principal_id=principal_id,
            command_id=command_id,
            command_type="plugin.source.add",
            payload=command_payload,
        )
        if replay is not None:
            return replay
        key_bytes = _decode_source_public_key(public_key)
        try:
            snapshot = await fetch_verified_source(index_url, signature_url, key_bytes)
            return await self._store.add_plugin_source_command(
                principal_id=principal_id,
                command_id=command_id,
                command_payload=command_payload,
                source_id=snapshot.index.source.id,
                name=snapshot.index.source.name,
                index_url=index_url,
                signature_url=signature_url,
                public_key=public_key,
                key_id=snapshot.key_id,
                index_sha256=snapshot.index_sha256,
                index_json=snapshot.raw_index.decode("utf-8"),
                signature_json=snapshot.raw_signature.decode("utf-8"),
                package_count=len(snapshot.index.packages),
            )
        except InvalidPluginSource as exc:
            raise PluginRegistryError("plugin_source_invalid", str(exc), status_code=409) from exc
        except PluginStateError as exc:
            raise PluginRegistryError(exc.code, str(exc), status_code=409) from exc

    async def refresh_source(
        self,
        *,
        principal_id: str,
        command_id: str,
        source_id: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        command_payload = {
            "type": "plugin.source.refresh",
            "source_id": source_id,
            "expected_revision": expected_revision,
        }
        replay = await self._store.accepted_command_receipt(
            principal_id=principal_id,
            command_id=command_id,
            command_type="plugin.source.refresh",
            payload=command_payload,
        )
        if replay is not None:
            return replay
        source = await self._store.get_plugin_source(
            principal_id=principal_id,
            source_id=source_id,
        )
        if source is None:
            raise PluginRegistryError(
                "plugin_source_not_found", "plugin source not found", status_code=404
            )
        key_bytes = _decode_source_public_key(str(source["public_key"]))
        try:
            snapshot = await fetch_verified_source(
                str(source["index_url"]),
                str(source["signature_url"]),
                key_bytes,
            )
            if snapshot.index.source.id != source_id:
                raise InvalidPluginSource("plugin source identity changed")
            return await self._store.refresh_plugin_source_command(
                principal_id=principal_id,
                command_id=command_id,
                command_payload=command_payload,
                source_id=source_id,
                expected_revision=expected_revision,
                name=snapshot.index.source.name,
                index_sha256=snapshot.index_sha256,
                index_json=snapshot.raw_index.decode("utf-8"),
                signature_json=snapshot.raw_signature.decode("utf-8"),
                package_count=len(snapshot.index.packages),
            )
        except InvalidPluginSource as exc:
            raise PluginRegistryError("plugin_source_invalid", str(exc), status_code=409) from exc
        except PluginStateError as exc:
            raise PluginRegistryError(exc.code, str(exc), status_code=409) from exc

    async def remove_source(
        self,
        *,
        principal_id: str,
        command_id: str,
        source_id: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        command_payload = {
            "type": "plugin.source.remove",
            "source_id": source_id,
            "expected_revision": expected_revision,
        }
        try:
            return await self._store.remove_plugin_source_command(
                principal_id=principal_id,
                command_id=command_id,
                command_payload=command_payload,
                source_id=source_id,
                expected_revision=expected_revision,
            )
        except PluginStateError as exc:
            status_code = 404 if exc.code == "plugin_source_not_found" else 409
            raise PluginRegistryError(exc.code, str(exc), status_code=status_code) from exc

    async def list_sources(self, *, principal_id: str) -> list[dict[str, Any]]:
        return await self._store.list_plugin_sources(principal_id=principal_id)

    async def inspect_source(
        self,
        *,
        principal_id: str,
        source_id: str,
    ) -> dict[str, Any]:
        source = await self._store.get_plugin_source(
            principal_id=principal_id,
            source_id=source_id,
        )
        if source is None:
            raise PluginRegistryError(
                "plugin_source_not_found", "plugin source not found", status_code=404
            )
        return {
            "source_id": source["source_id"],
            "name": source["name"],
            "index_url": source["index_url"],
            "key_id": source["key_id"],
            "index_sha256": source["index_sha256"],
            "package_count": source["package_count"],
            "revision": source["revision"],
            "updated_at": source["updated_at"],
            "packages": source["index"]["packages"],
        }

    async def install_from_source(
        self,
        *,
        principal_id: str,
        command_id: str,
        source_id: str,
        expected_revision: int,
        plugin_id: str,
        version: str,
        execution_kind: str,
        platform: str,
        package_digest: str,
        expected_active_digest: str | None,
    ) -> dict[str, Any]:
        command_payload = {
            "type": "plugin.source.install",
            "source_id": source_id,
            "expected_revision": expected_revision,
            "plugin_id": plugin_id,
            "version": version,
            "execution_kind": execution_kind,
            "platform": platform,
            "package_digest": package_digest,
            "expected_active_digest": expected_active_digest,
        }
        replay = await self._store.accepted_command_receipt(
            principal_id=principal_id,
            command_id=command_id,
            command_type="plugin.source.install",
            payload=command_payload,
        )
        if replay is not None:
            return replay
        source = await self._store.get_plugin_source(
            principal_id=principal_id,
            source_id=source_id,
        )
        if source is None:
            raise PluginRegistryError(
                "plugin_source_not_found", "plugin source not found", status_code=404
            )
        if int(source["revision"]) != expected_revision:
            raise PluginRegistryError(
                "plugin_source_revision_conflict",
                "plugin source changed; refresh the catalog before installing",
                status_code=409,
            )
        try:
            index = PluginSourceIndex.model_validate(source["index"])
        except ValueError as exc:
            raise PluginRegistryError(
                "plugin_source_invalid", "stored plugin source index is invalid", status_code=409
            ) from exc
        package = next(
            (
                item
                for item in index.packages
                if item.plugin_id == plugin_id
                and item.version == version
                and item.execution_kind == execution_kind
                and item.platform == platform
            ),
            None,
        )
        if package is None:
            raise PluginRegistryError(
                "plugin_source_package_not_found",
                "plugin package is not present in this source revision",
                status_code=404,
            )
        if package.package_digest != package_digest:
            raise PluginRegistryError(
                "plugin_source_package_changed",
                "plugin package selection is stale",
                status_code=409,
            )
        installation = await self._store.get_plugin(
            principal_id=principal_id,
            plugin_id=plugin_id,
        )
        if installation is None and expected_active_digest is not None:
            raise PluginRegistryError(
                "plugin_digest_mismatch",
                "plugin is no longer installed",
                status_code=409,
            )
        if installation is not None and installation["digest"] != expected_active_digest:
            raise PluginRegistryError(
                "plugin_digest_mismatch",
                "plugin active digest changed",
                status_code=409,
            )

        download_root = self._root / "staging"
        download_root.mkdir(parents=True, exist_ok=True)
        download_dir = Path(tempfile.mkdtemp(prefix="source-", dir=download_root))
        archive = download_dir / f"{plugin_id}-{version}.shejane-plugin"
        prepared: _PreparedPackage | None = None
        try:
            try:
                archive_bytes = await fetch_source_package(
                    str(package.package_url), package.package_size_bytes
                )
            except InvalidPluginSource as exc:
                raise PluginRegistryError(
                    "plugin_source_download_failed", str(exc), status_code=409
                ) from exc
            await asyncio.to_thread(archive.write_bytes, archive_bytes)
            await asyncio.to_thread(os.chmod, archive, 0o600)
            prepared = await asyncio.to_thread(
                self._ingest_package,
                str(archive),
                False,
                package.package_digest,
            )
            self._validate_source_package(package, prepared)
            store_kwargs = {
                "principal_id": principal_id,
                "command_id": command_id,
                "command_payload": command_payload,
                "manifest": prepared.manifest,
                "digest": prepared.digest,
                "signature_status": prepared.signature_status,
                "signer_key_id": prepared.signer_key_id,
                "compatibility": prepared.compatibility,
                "source": f"plugin_source:{source_id}",
                "command_type": "plugin.source.install",
                "receipt_type": "plugin.source.install",
                "receipt_extra": {
                    "source_id": source_id,
                    "source_revision": expected_revision,
                },
            }
            if installation is None or installation["digest"] == prepared.digest:
                receipt, _created = await self._store.install_plugin_command(**store_kwargs)
            else:
                receipt, _created = await self._store.update_plugin_command(
                    plugin_id=plugin_id,
                    **store_kwargs,
                )
            return receipt
        except PluginStateError as exc:
            if prepared is not None:
                await self._discard_new_blob(prepared)
            raise PluginRegistryError(exc.code, str(exc), status_code=409) from exc
        except PluginVersionConflictError as exc:
            if prepared is not None:
                await self._discard_new_blob(prepared)
            raise PluginRegistryError("plugin_version_conflict", str(exc), status_code=409) from exc
        except BaseException:
            if prepared is not None:
                await self._discard_new_blob(prepared)
            raise
        finally:
            await asyncio.to_thread(shutil.rmtree, download_dir, True)

    @staticmethod
    def _validate_source_package(
        source_package: PluginSourcePackage,
        prepared: _PreparedPackage,
    ) -> None:
        manifest = prepared.manifest
        execution = manifest["runtime"]["execution"]
        actions = manifest["contributions"]["actions"]
        summaries = {
            "capabilities": {value for action in actions for value in action["capabilities"]},
            "consumes": {value for action in actions for value in action["consumes"]},
            "produces": {value for action in actions for value in action["produces"]},
        }
        expected = {
            "plugin_id": source_package.plugin_id,
            "version": source_package.version,
            "name": source_package.name,
            "publisher_id": source_package.publisher_id,
            "runtime_min_version": source_package.runtime_min_version,
            "execution_kind": source_package.execution_kind,
            "platform": source_package.platform,
            "signer_key_id": source_package.signer_key_id,
        }
        actual = {
            "plugin_id": manifest["id"],
            "version": manifest["version"],
            "name": manifest["name"],
            "publisher_id": manifest["publisher"]["id"],
            "runtime_min_version": manifest["runtime"]["min_version"],
            "execution_kind": execution["kind"],
            "platform": execution["platforms"][0],
            "signer_key_id": prepared.signer_key_id,
        }
        if actual != expected or any(
            summaries[key] != set(getattr(source_package, key)) for key in summaries
        ):
            raise PluginRegistryError(
                "plugin_source_metadata_mismatch",
                "downloaded plugin manifest does not match the signed source index",
                status_code=409,
            )

    async def install_runtime_asset(
        self,
        *,
        principal_id: str,
        command_id: str,
        source_path: str,
        expected_digest: str | None,
    ) -> dict[str, Any]:
        command_payload: dict[str, Any] = {
            "type": "plugin.runtime_asset.install",
            "source_path": source_path,
        }
        if expected_digest is not None:
            command_payload["expected_digest"] = expected_digest
        replay = await self._store.accepted_command_receipt(
            principal_id=principal_id,
            command_id=command_id,
            command_type="plugin.runtime_asset.install",
            payload=command_payload,
        )
        if replay is not None:
            return replay
        try:
            handle = await asyncio.to_thread(
                self._runtime_assets.install,
                Path(source_path).expanduser(),
                expected_digest=expected_digest,
            )
        except InvalidPluginPackage as exc:
            raise PluginRegistryError(
                "invalid_runtime_asset",
                str(exc),
                status_code=409,
            ) from exc
        receipt = {
            "type": "plugin.runtime_asset.install",
            "command_id": command_id,
            "asset_id": handle.asset_id,
            "version": handle.version,
            "platform": handle.platform,
            "digest": handle.digest,
            "installed": True,
        }
        return await self._store.record_command_receipt(
            principal_id=principal_id,
            command_id=command_id,
            command_type="plugin.runtime_asset.install",
            payload=command_payload,
            receipt=receipt,
        )

    async def install(
        self,
        *,
        principal_id: str,
        command_id: str,
        source_path: str,
        expected_digest: str | None,
        allow_unsigned: bool,
    ) -> dict[str, Any]:
        command_payload: dict[str, Any] = {
            "type": "plugin.install",
            "source_path": source_path,
            "allow_unsigned": allow_unsigned,
        }
        if expected_digest is not None:
            command_payload["expected_digest"] = expected_digest
        replay = await self._store.accepted_command_receipt(
            principal_id=principal_id,
            command_id=command_id,
            command_type="plugin.install",
            payload=command_payload,
        )
        if replay is not None:
            return replay

        try:
            prepared = await asyncio.to_thread(
                self._ingest_package,
                source_path,
                allow_unsigned,
                expected_digest,
            )
        except InvalidPluginPackage as exc:
            raise PluginRegistryError("invalid_plugin_package", str(exc)) from exc
        try:
            receipt, _created = await self._store.install_plugin_command(
                principal_id=principal_id,
                command_id=command_id,
                command_payload=command_payload,
                manifest=prepared.manifest,
                digest=prepared.digest,
                signature_status=prepared.signature_status,
                signer_key_id=prepared.signer_key_id,
                compatibility=prepared.compatibility,
                source="local_file",
            )
        except PluginVersionConflictError as exc:
            await self._discard_new_blob(prepared)
            raise PluginRegistryError("plugin_version_conflict", str(exc), status_code=409) from exc
        return receipt

    def _ingest_package(
        self,
        source_path: str,
        allow_unsigned: bool,
        expected_package_digest: str | None,
    ) -> _PreparedPackage:
        source = Path(source_path).expanduser()
        if source.suffix != ".shejane-plugin":
            raise PluginRegistryError(
                "plugin_archive_required", "plugin source must be a .shejane-plugin ZIP"
            )
        staging_root = self._root / "staging"
        packages_root = self._root / "packages"
        staging_root.mkdir(parents=True, exist_ok=True)
        packages_root.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix="install-", dir=staging_root))
        package_root = staging / "package"
        try:
            extract_plugin_archive(source, package_root)
            manifest = load_plugin_manifest(package_root)
            digest = canonical_package_digest(package_root)
            if expected_package_digest is not None and expected_package_digest != digest:
                raise PluginRegistryError(
                    "plugin_digest_mismatch",
                    "plugin package does not match expected_digest",
                    status_code=409,
                )
            if (package_root / SIGNATURE_PATH).exists():
                try:
                    signer_key_id = verify_trusted_package(
                        package_root,
                        manifest.publisher.id,
                        self._root / "trusted-publishers.json",
                    )
                except PluginTrustError as exc:
                    raise PluginRegistryError(exc.code, str(exc), status_code=409) from exc
                signature_status = "verified"
            elif not allow_unsigned:
                raise PluginRegistryError(
                    "unsigned_plugin_confirmation_required",
                    "installing this unsigned plugin requires explicit confirmation",
                    status_code=409,
                )
            else:
                signature_status = "unsigned"
                signer_key_id = None
            if manifest.runtime.execution.kind == "managed_worker":
                host_platform = current_managed_worker_platform()
                current_platform = current_managed_worker_execution_platform()
                target_platform = manifest.runtime.execution.platforms[0]
                if (
                    host_platform is None
                    or current_platform is None
                    or target_platform != current_platform
                ):
                    raise PluginRegistryError(
                        "plugin_platform_incompatible",
                        "Managed Worker package does not target this operating system and architecture",
                        status_code=409,
                    )
                for reference in manifest.runtime.execution.runtime_assets:
                    try:
                        self._runtime_assets.resolve(
                            asset_id=reference.id,
                            version=reference.version,
                            platform=target_platform,
                            digest=reference.digest,
                        )
                    except InvalidPluginPackage as exc:
                        raise PluginRegistryError(
                            "plugin_runtime_asset_unavailable",
                            f"required runtime asset {reference.id} is unavailable",
                            status_code=409,
                        ) from exc
                prepare_managed_worker_entrypoint(
                    package_root,
                    manifest.runtime.execution.entrypoint,
                )
                release_gate = managed_worker_release_gate(host_platform)
                if not release_gate.enabled:
                    raise PluginRegistryError(
                        "managed_worker_sandbox_unavailable",
                        "Managed Worker plugins require a production operating-system sandbox",
                        status_code=409,
                    )
            try:
                compatible = Version(self._runtime_version) >= Version(manifest.runtime.min_version)
            except InvalidVersion as exc:
                raise PluginRegistryError(
                    "plugin_runtime_version_invalid", "plugin runtime version is invalid"
                ) from exc
            destination = packages_root / digest.removeprefix("sha256:")
            created_blob = False
            if not destination.exists():
                try:
                    os.replace(package_root, destination)
                    created_blob = True
                except OSError:
                    if not destination.exists():
                        raise
            return _PreparedPackage(
                manifest=manifest.model_dump(mode="json"),
                digest=digest,
                compatibility="compatible" if compatible else "incompatible",
                signature_status=signature_status,
                signer_key_id=signer_key_id,
                destination=destination,
                created_blob=created_blob,
            )
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    async def _discard_new_blob(self, package: _PreparedPackage) -> None:
        if package.created_blob:
            await asyncio.to_thread(shutil.rmtree, package.destination, True)

    async def update(
        self,
        *,
        principal_id: str,
        command_id: str,
        plugin_id: str,
        source_path: str,
        expected_digest: str | None,
        allow_unsigned: bool,
    ) -> dict[str, Any]:
        command_payload: dict[str, Any] = {
            "type": "plugin.update",
            "plugin_id": plugin_id,
            "source_path": source_path,
            "allow_unsigned": allow_unsigned,
        }
        if expected_digest is not None:
            command_payload["expected_digest"] = expected_digest
        replay = await self._store.accepted_command_receipt(
            principal_id=principal_id,
            command_id=command_id,
            command_type="plugin.update",
            payload=command_payload,
        )
        if replay is not None:
            return replay
        try:
            prepared = await asyncio.to_thread(
                self._ingest_package,
                source_path,
                allow_unsigned,
                None,
            )
        except InvalidPluginPackage as exc:
            raise PluginRegistryError("invalid_plugin_package", str(exc)) from exc
        try:
            receipt, _created = await self._store.update_plugin_command(
                principal_id=principal_id,
                command_id=command_id,
                command_payload=command_payload,
                plugin_id=plugin_id,
                manifest=prepared.manifest,
                digest=prepared.digest,
                signature_status=prepared.signature_status,
                signer_key_id=prepared.signer_key_id,
                compatibility=prepared.compatibility,
                source="local_file",
            )
            return receipt
        except (PluginStateError, PluginVersionConflictError) as exc:
            await self._discard_new_blob(prepared)
            code = exc.code if isinstance(exc, PluginStateError) else "plugin_version_conflict"
            status_code = 404 if code == "plugin_not_found" else 409
            raise PluginRegistryError(code, str(exc), status_code=status_code) from exc

    async def rollback(
        self,
        *,
        principal_id: str,
        command_id: str,
        plugin_id: str,
        target_digest: str,
        expected_digest: str | None,
    ) -> dict[str, Any]:
        try:
            receipt, _created = await self._store.rollback_plugin_command(
                principal_id=principal_id,
                command_id=command_id,
                plugin_id=plugin_id,
                target_digest=target_digest,
                expected_digest=expected_digest,
            )
            return receipt
        except PluginStateError as exc:
            status_code = 404 if exc.code == "plugin_not_found" else 409
            raise PluginRegistryError(exc.code, str(exc), status_code=status_code) from exc

    async def remove(
        self,
        *,
        principal_id: str,
        command_id: str,
        plugin_id: str,
        expected_digest: str | None,
    ) -> dict[str, Any]:
        try:
            receipt, _created = await self._store.remove_plugin_command(
                principal_id=principal_id,
                command_id=command_id,
                plugin_id=plugin_id,
                expected_digest=expected_digest,
            )
            return receipt
        except PluginStateError as exc:
            status_code = 404 if exc.code == "plugin_not_found" else 409
            raise PluginRegistryError(exc.code, str(exc), status_code=status_code) from exc

    async def list(self, *, principal_id: str) -> list[dict[str, Any]]:
        records = await self._store.list_plugins(principal_id=principal_id)
        return [_plugin_summary(record) for record in records]

    async def inspect(self, *, principal_id: str, plugin_id: str) -> dict[str, Any]:
        record = await self._store.get_plugin(principal_id=principal_id, plugin_id=plugin_id)
        if record is None:
            raise PluginRegistryError(
                "plugin_not_found", "plugin is not installed", status_code=404
            )
        manifest = record["manifest"]
        versions = await self._store.list_plugin_versions(
            principal_id=principal_id,
            plugin_id=plugin_id,
        )
        return {
            **_plugin_summary(record),
            "description": manifest["description"],
            "license": manifest.get("license"),
            "actions": [
                {
                    key: action[key]
                    for key in (
                        "id",
                        "title",
                        "description",
                        "consumes",
                        "produces",
                        "effects",
                        "determinism",
                        "capabilities",
                        "limits",
                    )
                }
                for action in manifest["contributions"]["actions"]
            ],
            "skills": [
                {key: skill[key] for key in ("id", "path")}
                for skill in manifest["contributions"].get("skills", [])
            ],
            "commands": [
                {key: command[key] for key in ("id", "title", "description", "required_actions")}
                for command in manifest["contributions"].get("commands", [])
            ],
            "mcp_servers": [
                {key: binding[key] for key in ("id", "path")}
                for binding in manifest["contributions"].get("mcp_servers", [])
            ],
            "versions": versions,
            "model_binding": _model_binding_summary(record.get("model_binding")),
        }

    async def set_enabled(
        self,
        *,
        principal_id: str,
        command_id: str,
        plugin_id: str,
        expected_digest: str | None,
        enabled: bool,
    ) -> dict[str, Any]:
        command_type = "plugin.enable" if enabled else "plugin.disable"
        try:
            receipt, _created = await self._store.set_plugin_enabled_command(
                principal_id=principal_id,
                command_id=command_id,
                command_type=command_type,
                plugin_id=plugin_id,
                expected_digest=expected_digest,
                enabled=enabled,
            )
            return receipt
        except PluginStateError as exc:
            status_code = 404 if exc.code == "plugin_not_found" else 409
            raise PluginRegistryError(exc.code, str(exc), status_code=status_code) from exc

    async def bind_model(
        self,
        *,
        principal_id: str,
        command_id: str,
        plugin_id: str,
        binding_id: str,
        requested_model: str,
        model_binding: dict[str, Any],
        expected_digest: str | None,
    ) -> dict[str, Any]:
        try:
            receipt, _created = await self._store.bind_plugin_model_command(
                principal_id=principal_id,
                command_id=command_id,
                plugin_id=plugin_id,
                binding_id=binding_id,
                requested_model=requested_model,
                model_binding=model_binding,
                expected_digest=expected_digest,
            )
            return receipt
        except PluginStateError as exc:
            status_code = 404 if exc.code == "plugin_not_found" else 409
            raise PluginRegistryError(exc.code, str(exc), status_code=status_code) from exc


def _plugin_summary(record: dict[str, Any]) -> dict[str, Any]:
    manifest = record["manifest"]
    return {
        "id": record["plugin_id"],
        "name": manifest["name"],
        "version": record["version"],
        "digest": record["digest"],
        "publisher": {
            "id": manifest["publisher"]["id"],
            "name": manifest["publisher"]["name"],
        },
        "execution_kind": record["execution_kind"],
        "signature_status": record["signature_status"],
        "compatibility": record["compatibility"],
        "enabled": record["enabled"],
        "retired": record["installation_retired_at"] is not None,
    }


def _decode_source_public_key(value: str) -> bytes:
    try:
        key = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise PluginRegistryError(
            "plugin_source_key_invalid", "plugin source public key is invalid", status_code=409
        ) from exc
    if len(key) != 32:
        raise PluginRegistryError(
            "plugin_source_key_invalid", "plugin source public key is invalid", status_code=409
        )
    return key


def _model_binding_summary(binding: Any) -> dict[str, Any] | None:
    if not isinstance(binding, dict):
        return None
    return {
        "id": str(binding["id"]),
        "requested_model": str(binding["requested_model"]),
        "provider_id": str(binding["provider_id"]),
        "provider_version": int(binding["provider_version"]),
        "model_id": str(binding["model_id"]),
    }
