#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "services" / "runtime"))

from local_host.plugins.runtime_assets import RuntimeAssetStore  # noqa: E402


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def files_equal(first: Path, second: Path) -> bool:
    if first.stat().st_size != second.stat().st_size:
        return False
    with first.open("rb") as left, second.open("rb") as right:
        while True:
            left_chunk = left.read(1024 * 1024)
            if left_chunk != right.read(1024 * 1024):
                return False
            if not left_chunk:
                return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--asset", type=Path, required=True)
    parser.add_argument("--reproducible-copy", type=Path)
    parser.add_argument("--expected-archive-sha256")
    parser.add_argument("--expected-canonical-digest")
    args = parser.parse_args()

    asset = args.asset.resolve(strict=True)
    archive_sha256 = sha256_file(asset)
    if args.expected_archive_sha256 and archive_sha256 != args.expected_archive_sha256:
        raise SystemExit("runtime asset archive SHA-256 does not match the release lock")
    if args.reproducible_copy:
        reproducible_copy = args.reproducible_copy.resolve(strict=True)
        if not files_equal(asset, reproducible_copy):
            raise SystemExit("independent runtime asset builds are not byte-for-byte identical")

    with tempfile.TemporaryDirectory(prefix="shejane-mupdf-release-") as temporary:
        installed = RuntimeAssetStore(Path(temporary)).install(asset)
        if args.expected_canonical_digest and installed.digest != args.expected_canonical_digest:
            raise SystemExit("runtime asset canonical digest does not match the release lock")
        result = {
            "archive_sha256": archive_sha256,
            "canonical_digest": installed.digest,
            "id": installed.asset_id,
            "version": installed.version,
            "platform": installed.platform,
            "reproducible": args.reproducible_copy is not None,
        }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
