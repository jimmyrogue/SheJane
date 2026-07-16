"""Developer CLI for validating and packing SheJane plugins."""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

from .plugins.manifest import load_plugin_manifest
from .plugins.package import (
    SIGNATURE_PATH,
    InvalidPluginPackage,
    InvalidPluginSignature,
    canonical_package_digest,
    extract_plugin_archive,
    pack_plugin_archive,
)


def _signature_summary(root: Path, digest: str) -> dict[str, str]:
    path = root / SIGNATURE_PATH
    if not path.exists():
        return {"status": "unsigned"}
    try:
        if path.stat().st_size > 64 * 1024:
            raise InvalidPluginSignature("plugin signature is too large")
        envelope = json.loads(path.read_text(encoding="utf-8"))
        signature_text = envelope["signature"]
        if not isinstance(signature_text, str):
            raise TypeError("signature must be text")
        signature = base64.b64decode(signature_text, validate=True)
    except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        raise InvalidPluginSignature("plugin signature envelope is invalid") from exc
    if (
        not isinstance(envelope, dict)
        or set(envelope) != {"schema_version", "algorithm", "key_id", "package_digest", "signature"}
        or envelope["schema_version"] != 1
        or envelope["algorithm"] != "ed25519"
        or not isinstance(envelope["key_id"], str)
        or not re.fullmatch(r"ed25519:sha256:[0-9a-f]{64}", envelope["key_id"])
        or envelope["package_digest"] != digest
        or len(signature) != 64
    ):
        raise InvalidPluginSignature("plugin signature envelope is invalid")
    return {"status": "present_unverified", "key_id": envelope["key_id"]}


def _summary(root: Path) -> dict[str, Any]:
    manifest = load_plugin_manifest(root)
    digest = canonical_package_digest(root)
    execution = manifest.runtime.execution
    return {
        "digest": digest,
        "execution_kind": execution.kind,
        "id": manifest.id,
        "platforms": execution.platforms,
        "signature": _signature_summary(root, digest),
        "version": manifest.version,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="shejane-plugin")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("validate", "inspect"):
        command = commands.add_parser(name)
        command.add_argument("path", type=Path)
    pack = commands.add_parser("pack")
    pack.add_argument("path", type=Path)
    pack.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "inspect":
            if args.path.suffix != ".shejane-plugin":
                raise InvalidPluginPackage("plugin archive must end in .shejane-plugin")
            with tempfile.TemporaryDirectory(prefix="shejane-plugin-inspect-") as temporary:
                root = Path(temporary) / "package"
                extract_plugin_archive(args.path.expanduser(), root)
                result = _summary(root)
        else:
            root = args.path.expanduser().resolve(strict=True)
            result = _summary(root)
            if args.command == "pack":
                digest = pack_plugin_archive(root, args.output)
                if digest != result["digest"]:
                    raise InvalidPluginPackage("plugin package changed while packing")
    except (OSError, InvalidPluginPackage, InvalidPluginSignature) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
