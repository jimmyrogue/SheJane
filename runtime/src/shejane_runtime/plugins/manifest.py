"""Strict parsing for the public plugin manifest v1 contract."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Literal

from jsonschema import Draft202012Validator, SchemaError
from pydantic import (
    AfterValidator,
    AnyUrl,
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from .package import InvalidPluginPackage

PluginId = Annotated[
    str,
    Field(min_length=3, max_length=200, pattern=r"^[a-z0-9]+(?:[.-][a-z0-9]+)+$"),
]
LocalId = Annotated[
    str,
    Field(min_length=1, max_length=100, pattern=r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$"),
]
Semver = Annotated[
    str,
    Field(
        max_length=100,
        pattern=(
            r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
            r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
            r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
        ),
    ),
]
MimeType = Annotated[
    str,
    Field(
        min_length=3,
        max_length=200,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,127}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,127}$",
    ),
]
Capability = Annotated[
    str,
    Field(
        min_length=3,
        max_length=100,
        pattern=r"^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$",
    ),
]
Digest = Annotated[
    str,
    Field(pattern=r"^sha256:[0-9a-f]{64}$"),
]
ManagedWorkerPlatform = Literal[
    "darwin/arm64",
    "darwin/amd64",
    "linux/arm64",
    "linux/amd64",
    "windows/arm64",
    "windows/amd64",
]
HostPlatform = Literal["darwin/arm64", "windows/amd64"]


def _package_path(value: str) -> str:
    if (
        value.startswith("/")
        or "\\" in value
        or "\x00" in value
        or "//" in value
        or any(part in {"", ".", ".."} for part in value.split("/"))
    ):
        raise ValueError("package path is not canonical")
    return value


PackagePath = Annotated[
    str,
    Field(min_length=1, max_length=512),
    AfterValidator(_package_path),
]


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PluginPublisher(_StrictModel):
    id: PluginId
    name: str = Field(min_length=1, max_length=100)
    url: AnyUrl | None = Field(default=None, max_length=2048)


class WasiExecution(_StrictModel):
    kind: Literal["wasi"]
    entrypoint: PackagePath
    platforms: list[Literal["any"]] = Field(min_length=1, max_length=1)

    @field_validator("entrypoint")
    @classmethod
    def require_component_suffix(cls, value: str) -> str:
        if not value.endswith(".wasm"):
            raise ValueError("WASI entrypoint must end in .wasm")
        return value


class RuntimeAssetReference(_StrictModel):
    id: PluginId
    version: Semver
    digest: Digest


class ManagedWorkerExecution(_StrictModel):
    kind: Literal["managed_worker"]
    entrypoint: PackagePath
    platforms: list[ManagedWorkerPlatform] = Field(min_length=1, max_length=1)
    runtime_assets: list[RuntimeAssetReference] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def require_unique_runtime_assets(self) -> ManagedWorkerExecution:
        identities = [(asset.id, asset.version, asset.digest) for asset in self.runtime_assets]
        if len(identities) != len(set(identities)):
            raise ValueError("worker runtime assets must be unique")
        ids = [asset.id for asset in self.runtime_assets]
        if len(ids) != len(set(ids)):
            raise ValueError("worker runtime asset ids must be unique")
        return self


class BuiltinExecution(_StrictModel):
    """A Runtime-authorized host adapter restricted to one exact package digest."""

    kind: Literal["builtin"]
    handler: Literal["browser_qa", "computer_use", "ocr"]
    platforms: list[HostPlatform] = Field(min_length=1, max_length=1)
    runtime_assets: list[RuntimeAssetReference] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def require_unique_runtime_assets(self) -> BuiltinExecution:
        identities = [(asset.id, asset.version, asset.digest) for asset in self.runtime_assets]
        if len(identities) != len(set(identities)):
            raise ValueError("built-in runtime assets must be unique")
        ids = [asset.id for asset in self.runtime_assets]
        if len(ids) != len(set(ids)):
            raise ValueError("built-in runtime asset ids must be unique")
        return self


class PluginRuntime(_StrictModel):
    min_version: Semver
    execution: WasiExecution | ManagedWorkerExecution | BuiltinExecution = Field(
        discriminator="kind"
    )


class ActionLimits(_StrictModel):
    timeout_ms: int = Field(ge=100, le=900_000)
    memory_mb: int = Field(ge=16, le=8192)
    output_mb: int = Field(ge=1, le=2048)


class PluginAction(_StrictModel):
    id: LocalId
    title: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=1000)
    input_schema: PackagePath
    output_schema: PackagePath
    consumes: list[MimeType] = Field(max_length=32)
    produces: list[MimeType] = Field(max_length=32)
    effects: list[Literal["read", "artifact", "external"]] = Field(min_length=1, max_length=3)
    determinism: Literal["pure", "input_stable", "nondeterministic"]
    capabilities: list[Capability] = Field(max_length=32)
    limits: ActionLimits

    @model_validator(mode="after")
    def require_unique_lists(self) -> PluginAction:
        for values in (self.consumes, self.produces, self.effects, self.capabilities):
            if len(values) != len(set(values)):
                raise ValueError("action lists must contain unique values")
        return self


class PluginSkill(_StrictModel):
    id: LocalId
    path: PackagePath


class PluginCommand(_StrictModel):
    id: LocalId
    title: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=500)
    instructions: PackagePath
    required_actions: list[LocalId] = Field(min_length=1, max_length=32)


class PluginMcpBinding(_StrictModel):
    id: LocalId
    path: PackagePath


class PluginContributions(_StrictModel):
    actions: list[PluginAction] = Field(min_length=1, max_length=128)
    skills: list[PluginSkill] = Field(default_factory=list, max_length=32)
    commands: list[PluginCommand] = Field(default_factory=list, max_length=32)
    mcp_servers: list[PluginMcpBinding] = Field(default_factory=list, max_length=16)

    @model_validator(mode="after")
    def require_unique_local_ids(self) -> PluginContributions:
        for values in (self.actions, self.skills, self.commands, self.mcp_servers):
            ids = [value.id for value in values]
            if len(ids) != len(set(ids)):
                raise ValueError("contribution ids must be unique within each kind")
        return self


class PluginManifest(_StrictModel):
    schema_version: Literal[1]
    id: PluginId
    version: Semver
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(min_length=1, max_length=500)
    license: str | None = Field(default=None, min_length=1, max_length=100)
    publisher: PluginPublisher
    runtime: PluginRuntime
    contributions: PluginContributions

    @model_validator(mode="after")
    def require_unique_references(self) -> PluginManifest:
        action_ids = [action.id for action in self.contributions.actions]
        if len(action_ids) != len(set(action_ids)):
            raise ValueError("action ids must be unique")
        for command in self.contributions.commands:
            if len(command.required_actions) != len(set(command.required_actions)):
                raise ValueError("command required_actions must be unique")
            if not set(command.required_actions).issubset(action_ids):
                raise ValueError("command references an unknown action")
        return self


def load_plugin_manifest(root: Path) -> PluginManifest:
    path = root / ".shejane-plugin" / "plugin.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        manifest = PluginManifest.model_validate(raw)
    except (OSError, UnicodeError, json.JSONDecodeError, ValidationError) as exc:
        raise InvalidPluginPackage("plugin manifest is invalid") from exc

    references = []
    if not isinstance(manifest.runtime.execution, BuiltinExecution):
        references.append(manifest.runtime.execution.entrypoint)
    references.extend(
        reference
        for action in manifest.contributions.actions
        for reference in (action.input_schema, action.output_schema)
    )
    references.extend(skill.path for skill in manifest.contributions.skills)
    references.extend(command.instructions for command in manifest.contributions.commands)
    references.extend(binding.path for binding in manifest.contributions.mcp_servers)
    if any(not (root / reference).is_file() for reference in references):
        raise InvalidPluginPackage("plugin manifest references a missing package file")
    try:
        for action in manifest.contributions.actions:
            for schema_path in (action.input_schema, action.output_schema):
                schema = json.loads((root / schema_path).read_text(encoding="utf-8"))
                Draft202012Validator.check_schema(schema)
    except (OSError, UnicodeError, json.JSONDecodeError, SchemaError) as exc:
        raise InvalidPluginPackage("plugin action schema is invalid") from exc
    return manifest
