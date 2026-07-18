"""Minimal Wasmtime Component executor for the Phase 0 Archive fixture."""

from __future__ import annotations

import base64
import hashlib
import json
import threading
from pathlib import Path, PurePosixPath
from typing import Any

from wasmtime import Config, Engine, Store, WasmtimeError
from wasmtime import component as wasm_component


class WasiProtocolError(RuntimeError):
    """The component or invocation violated the WASI Action contract."""


class WasiResourceLimitError(WasiProtocolError):
    """The component exhausted a deterministic Runtime resource limit."""

    code = "resource_exhausted"


WASI_MAX_BUFFERED_INPUT_BYTES = 16 * 1024 * 1024
WASI_MAX_BUFFERED_OUTPUT_BYTES = 16 * 1024 * 1024


def invoke_wasi_component(
    *,
    component_path: Path,
    expected_component_digest: str,
    invocation: dict[str, Any],
    inputs: dict[str, bytes],
    output_root: Path,
    fuel_per_ms: int = 100_000,
) -> dict[str, Any]:
    """Invoke a component with no ambient WASI imports and stage its artifacts."""

    component_bytes = component_path.read_bytes()
    actual_digest = "sha256:" + hashlib.sha256(component_bytes).hexdigest()
    if actual_digest != expected_component_digest:
        raise WasiProtocolError("component digest does not match the frozen binding")

    input_id = str(invocation["arguments"]["input_id"])
    try:
        input_bytes = inputs[input_id]
        reference = next(item for item in invocation["inputs"] if item["id"] == input_id)
    except (KeyError, StopIteration) as exc:
        raise WasiProtocolError("authorized input is missing") from exc
    if len(input_bytes) != reference["size_bytes"]:
        raise WasiProtocolError("authorized input size changed")
    if hashlib.sha256(input_bytes).hexdigest() != reference["sha256"]:
        raise WasiProtocolError("authorized input digest changed")

    limits = invocation["limits"]
    config = Config()
    config.consume_fuel = True
    config.epoch_interruption = True
    config.cranelift_nan_canonicalization = True
    engine = Engine(config)
    try:
        component = wasm_component.Component(engine, component_bytes)
    except WasmtimeError as exc:
        raise WasiProtocolError("WASI component is invalid") from exc
    store = Store(engine)
    store.set_epoch_deadline(1)
    store.set_limits(
        memory_size=int(limits["memory_mb"]) * 1024 * 1024,
        instances=16,
        tables=16,
        memories=16,
    )
    # ponytail: deterministic fuel budget; calibrate fuel_per_ms per release hardware matrix.
    store.set_fuel(int(limits["timeout_ms"]) * fuel_per_ms)
    linker = wasm_component.Linker(engine)
    linker.allow_shadowing = True
    linker.define_unknown_imports_as_traps(component)
    with linker.root() as root:
        with root.add_instance("wasi:random/insecure-seed@0.2.6") as random:
            random.add_func("insecure-seed", lambda _store: (0, 0))
    try:
        instance = linker.instantiate(store, component)
    except WasmtimeError as exc:
        raise WasiProtocolError("WASI component imports are invalid") from exc
    invoke = instance.get_func(store, "invoke")
    if invoke is None:
        raise WasiProtocolError("component does not export invoke")
    timeout = threading.Timer(
        max(0.1, int(limits["timeout_ms"]) / 1000),
        engine.increment_epoch,
    )
    timeout.start()
    try:
        try:
            raw_result = invoke(
                store,
                json.dumps(
                    invocation,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                input_bytes,
            )
            invoke.post_return(store)
        except WasmtimeError as exc:
            detail = str(exc).lower()
            if "all fuel consumed" in detail:
                raise WasiResourceLimitError("WASI execution fuel limit exceeded") from exc
            if "interrupt" in detail:
                raise WasiResourceLimitError("WASI execution deadline exceeded") from exc
            raise WasiProtocolError("WASI component trapped") from exc
    finally:
        timeout.cancel()
    if not isinstance(raw_result, str):
        raise WasiProtocolError("component result must be JSON text")
    try:
        internal = json.loads(raw_result)
    except json.JSONDecodeError as exc:
        raise WasiProtocolError("component returned invalid JSON") from exc
    return _stage_result(internal, invocation, output_root)


def _stage_result(
    internal: Any,
    invocation: dict[str, Any],
    output_root: Path,
) -> dict[str, Any]:
    if not isinstance(internal, dict) or internal.get("status") not in {"succeeded", "failed"}:
        raise WasiProtocolError("component returned an invalid status")
    if internal["status"] == "failed":
        return {
            "schema_version": 1,
            "invocation_id": invocation["invocation_id"],
            "operation_id": invocation["operation_id"],
            "status": "failed",
            "artifacts": [],
            "error": internal.get("error", {}),
        }

    output_root = output_root.resolve(strict=True)
    output_limit = min(
        int(invocation["limits"]["output_mb"]) * 1024 * 1024,
        WASI_MAX_BUFFERED_OUTPUT_BYTES,
    )
    candidates: list[tuple[Path, bytes, dict[str, str]]] = []
    seen: set[Path] = set()
    total = 0
    for artifact in internal.get("artifacts", []):
        if not isinstance(artifact, dict):
            raise WasiProtocolError("component artifact must be an object")
        try:
            relative = PurePosixPath(str(artifact["path"])).relative_to("/output")
            data = base64.b64decode(artifact["data_base64"], validate=True)
            public = {
                "path": str(artifact["path"]),
                "media_type": str(artifact["media_type"]),
                "name": str(artifact["name"]),
            }
        except (KeyError, ValueError, TypeError) as exc:
            raise WasiProtocolError("component artifact is invalid") from exc
        if not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
            raise WasiProtocolError("component artifact path is unsafe")
        destination = output_root.joinpath(*relative.parts)
        if destination in seen or destination.exists():
            raise WasiProtocolError("component artifact path is duplicated")
        destination.parent.resolve(strict=False).relative_to(output_root)
        total += len(data)
        if total > output_limit:
            raise WasiResourceLimitError("WASI buffered artifact output limit exceeded")
        seen.add(destination)
        candidates.append((destination, data, public))
    if len(candidates) > 128:
        raise WasiProtocolError("component returned too many artifacts")

    for destination, data, _public in candidates:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    return {
        "schema_version": 1,
        "invocation_id": invocation["invocation_id"],
        "operation_id": invocation["operation_id"],
        "status": "succeeded",
        "output": internal.get("output", {}),
        "artifacts": [public for _destination, _data, public in candidates],
    }
