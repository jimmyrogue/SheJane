#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
LOCK_PATH = ROOT / "ffmpeg-8.1.2.lock.json"


def load_lock() -> dict[str, Any]:
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    upstream = lock["upstream"]
    if lock.get("schema_version") != 1 or upstream.get("version") != "8.1.2":
        raise SystemExit("unsupported FFmpeg source lock")
    return lock


def file_identity(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def verify_source(source: Path, signature: Path, signing_key: Path) -> dict[str, Any]:
    lock = load_lock()
    upstream = lock["upstream"]
    source = source.resolve(strict=True)
    signature = signature.resolve(strict=True)
    signing_key = signing_key.resolve(strict=True)
    size, digest = file_identity(source)
    if size != upstream["source_size_bytes"] or digest != upstream["source_sha256"]:
        raise SystemExit("FFmpeg source archive does not match the lock")

    with tempfile.TemporaryDirectory(prefix="shejane-ffmpeg-gpg-") as temporary:
        home = Path(temporary)
        home.chmod(0o700)
        run_gpg(home, ["--import", str(signing_key)])
        fingerprints = run_gpg(
            home,
            ["--with-colons", "--fingerprint", "--fingerprint"],
            capture=True,
        ).stdout.splitlines()
        expected = str(upstream["signing_key_fingerprint"])
        actual = {line.split(":")[9] for line in fingerprints if line.startswith("fpr:")}
        if expected not in actual:
            raise SystemExit("FFmpeg signing key fingerprint does not match the lock")
        verification = run_gpg(
            home,
            ["--status-fd", "1", "--verify", str(signature), str(source)],
            capture=True,
        ).stdout
        if f"[GNUPG:] VALIDSIG {expected} " not in verification:
            raise SystemExit("FFmpeg source signature is not valid for the locked key")
    return lock


def run_gpg(
    home: Path,
    arguments: list[str],
    *,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["gpg", "--homedir", str(home), "--batch", *arguments],
        check=True,
        text=True,
        encoding="utf-8",
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--signature", type=Path, required=True)
    parser.add_argument("--signing-key", type=Path, required=True)
    args = parser.parse_args()
    lock = verify_source(args.source, args.signature, args.signing_key)
    print(lock["upstream"]["source_sha256"])


if __name__ == "__main__":
    main()
