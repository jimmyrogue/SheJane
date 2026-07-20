#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import stat
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOCK = ROOT / "node-24.18.0-linux-arm64.lock.json"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--node-archive", type=Path, required=True)
    parser.add_argument("--signed-checksums", type=Path, required=True)
    parser.add_argument("--release-keyring", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.suffix != ".shejane-runtime-asset":
        parser.error("--output must end in .shejane-runtime-asset")

    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    _verify(args.node_archive, lock["node"])
    _verify(args.signed_checksums, lock["signed_checksums"])
    _verify(args.release_keyring, lock["release_keyring"])

    with tempfile.TemporaryDirectory(prefix="shejane-node-runtime-") as temporary:
        work = Path(temporary)
        _verify_signed_checksum(
            args.signed_checksums,
            args.release_keyring,
            work / "verified-checksums.txt",
            lock,
        )
        stage = work / "asset"
        node = stage / "payload" / "bin" / "node"
        license_file = stage / "licenses" / "node-LICENSE.txt"
        node.parent.mkdir(parents=True)
        license_file.parent.mkdir(parents=True)
        prefix = f"node-v{lock['node']['version']}-linux-arm64"
        with tarfile.open(args.node_archive, "r:xz") as archive:
            _extract_regular(archive, f"{prefix}/bin/node", node)
            _extract_regular(archive, f"{prefix}/LICENSE", license_file)
        node.chmod(0o500)
        _verify_linux_arm64_elf(node)
        _write_metadata(stage, lock)
        _pack(stage, args.output)
    print(args.output.resolve())


def _verify(path: Path, expected: dict[str, object]) -> None:
    if path.is_symlink():
        raise SystemExit(f"locked input cannot be a symlink: {path.name}")
    path = path.resolve(strict=True)
    if not path.is_file() or path.stat().st_size != expected["size_bytes"]:
        raise SystemExit(f"locked input size mismatch: {path.name}")
    with path.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != expected["sha256"]:
        raise SystemExit(f"locked input digest mismatch: {path.name}")


def _verify_signed_checksum(
    signed: Path,
    keyring: Path,
    verified: Path,
    lock: dict[str, object],
) -> None:
    result = subprocess.run(
        [
            "gpgv",
            "--status-fd=2",
            "--keyring",
            str(keyring.resolve()),
            "--output",
            "-",
            str(signed.resolve()),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    fingerprint = lock["signed_checksums"]["signer_fingerprint"]  # type: ignore[index]
    if not any(
        line.startswith(f"[GNUPG:] VALIDSIG {fingerprint} ") for line in result.stderr.splitlines()
    ):
        raise SystemExit("Node.js checksum signer changed")
    verified.write_text(result.stdout, encoding="utf-8")
    expected = f"{lock['node']['sha256']}  {lock['node']['filename']}"  # type: ignore[index]
    matches = [
        line
        for line in verified.read_text(encoding="utf-8").splitlines()
        if line.endswith(str(lock["node"]["filename"]))
    ]  # type: ignore[index]
    if matches != [expected]:
        raise SystemExit("signed Node.js archive checksum changed")


def _extract_regular(archive: tarfile.TarFile, name: str, output: Path) -> None:
    try:
        member = archive.getmember(name)
        source = archive.extractfile(member)
    except KeyError as exc:
        raise SystemExit(f"Node.js archive member is missing: {name}") from exc
    if not member.isfile() or source is None:
        raise SystemExit(f"Node.js archive member is not a regular file: {name}")
    with source, output.open("wb") as destination:
        while chunk := source.read(1024 * 1024):
            destination.write(chunk)


def _verify_linux_arm64_elf(path: Path) -> None:
    header = path.read_bytes()[:20]
    if (
        len(header) != 20
        or header[:4] != b"\x7fELF"
        or header[4] != 2
        or header[5] != 1
        or int.from_bytes(header[18:20], "little") != 183
    ):
        raise SystemExit("Node.js executable is not Linux arm64 ELF")


def _write_metadata(stage: Path, lock: dict[str, object]) -> None:
    metadata = stage / ".shejane-runtime-asset"
    metadata.mkdir()
    manifest = {
        "schema_version": 1,
        "id": lock["asset_id"],
        "version": lock["asset_version"],
        "platform": lock["platform"],
        "license": "MIT",
        "source_url": lock["node"]["url"],  # type: ignore[index]
        "payload": "payload",
        "sbom": ".shejane-runtime-asset/sbom.spdx.json",
        "executables": ["payload/bin/node"],
    }
    (metadata / "asset.json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    sbom = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": "shejane-nodejs-runtime-linux-arm64",
        "documentNamespace": f"https://shejane.org/spdx/runtime-assets/node/{lock['node']['sha256']}",  # type: ignore[index]
        "creationInfo": {
            "created": "2026-07-16T00:00:00Z",
            "creators": ["Organization: SheJane"],
        },
        "packages": [
            {
                "name": "Node.js",
                "SPDXID": "SPDXRef-Package-Nodejs",
                "versionInfo": lock["node"]["version"],  # type: ignore[index]
                "downloadLocation": lock["node"]["url"],  # type: ignore[index]
                "filesAnalyzed": False,
                "licenseConcluded": "MIT",
                "licenseDeclared": "MIT",
                "checksums": [
                    {
                        "algorithm": "SHA256",
                        "checksumValue": lock["node"]["sha256"],  # type: ignore[index]
                    }
                ],
            }
        ],
        "relationships": [
            {
                "spdxElementId": "SPDXRef-DOCUMENT",
                "relationshipType": "DESCRIBES",
                "relatedSpdxElement": "SPDXRef-Package-Nodejs",
            }
        ],
    }
    (metadata / "sbom.spdx.json").write_text(
        json.dumps(sbom, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )


def _pack(source: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(item for item in source.rglob("*") if item.is_file()):
                relative = path.relative_to(source).as_posix()
                info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                mode = 0o500 if stat.S_IMODE(path.stat().st_mode) & 0o111 else 0o600
                info.external_attr = mode << 16
                archive.writestr(info, path.read_bytes())
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
