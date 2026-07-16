#!/usr/bin/env python3
"""Build the frozen Linux/arm64 Managed Worker guest root filesystem."""

from __future__ import annotations

import argparse
import hashlib
import json
import lzma
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

LOCK_PATH = Path(__file__).with_name("darwin-arm64.lock.json")
_BUILD_SCRIPT = r"""
set -eu
jobs="$1"
epoch="$2"
blocks="$3"
expected_debian="$4"
expected_base_packages="$5"
expected_packages="$6"

mkdir -p /work/e2fs-source /work/e2fs-build
tar -xf /work/e2fsprogs.tar.xz -C /work/e2fs-source --strip-components=1
cd /work/e2fs-build
/work/e2fs-source/configure \
  --prefix=/ \
  --enable-libuuid \
  --enable-libblkid \
  --disable-nls \
  --disable-backtrace \
  --disable-debugfs \
  --disable-imager \
  --disable-resizer \
  --disable-defrag \
  --disable-uuidd \
  --disable-tdb \
  --disable-bmap-stats \
  --disable-fuse2fs \
  --disable-rpath \
  --without-pthread \
  --without-libarchive >/dev/null
make -j"$jobs" libs >/dev/null
make -j"$jobs" -C misc mke2fs >/dev/null
test "$(misc/mke2fs -V 2>&1 | sed -n '1p')" = "mke2fs 1.47.2 (1-Jan-2025)"

for build in 1 2; do
  root="/work/rootfs-$build"
  mkdir "$root"
  tar -xpf "/work/rootfs-$build.tar" -C "$root" --numeric-owner
  test "$(cat "$root/etc/debian_version")" = "$expected_debian"
  actual_base_packages="$({
    chroot "$root" dpkg-query -W \
      -f='${binary:Package}\t${Version}\t${Architecture}\n'
  } | sha256sum | cut -d' ' -f1)"
  test "$actual_base_packages" = "$expected_base_packages"
  mkdir -p "$root/tmp/shejane-runtime-packages"
  cp /work/runtime-packages/*.deb "$root/tmp/shejane-runtime-packages/"
  chroot "$root" /bin/sh -ceu '
    export DEBIAN_FRONTEND=noninteractive
    dpkg -i /tmp/shejane-runtime-packages/*.deb >/dev/null
    test -z "$(dpkg --audit)"
    rm -rf /tmp/shejane-runtime-packages
  '
  actual_packages="$({
    chroot "$root" dpkg-query -W \
      -f='${binary:Package}\t${Version}\t${Architecture}\n'
  } | sha256sum | cut -d' ' -f1)"
  test "$actual_packages" = "$expected_packages"
  rm -f \
    "$root/.dockerenv" \
    "$root/etc/hostname" \
    "$root/etc/hosts" \
    "$root/etc/resolv.conf" \
    "$root/var/cache/ldconfig/aux-cache" \
    "$root/var/log/dpkg.log"
  find "$root/dev" -mindepth 1 -delete
  mkdir -p \
    "$root/package" \
    "$root/input" \
    "$root/output" \
    "$root/proc" \
    "$root/sys/fs/cgroup"
  find "$root" -xdev -exec touch -h -d "@$epoch" {} +
  E2FSPROGS_FAKE_TIME="$epoch" \
  SOURCE_DATE_EPOCH="$epoch" \
  MKE2FS_CONFIG=/dev/null \
    misc/mke2fs \
      -q -F -t ext4 -b 4096 -I 256 -i 16384 \
      -U 00000000-0000-4000-8000-000000000004 \
      -L SHEJANE_SYSTEM \
      -m 0 \
      -O extents,64bit,flex_bg,metadata_csum,dir_nlink,extra_isize,^metadata_csum_seed,^orphan_file \
      -E lazy_itable_init=0,lazy_journal_init=0,root_owner=0:0,hash_seed=00000000-0000-4000-8000-000000000004 \
      -d "$root" "/work/guest-rootfs-$build.ext4" "$blocks"
done
cmp /work/guest-rootfs-1.ext4 /work/guest-rootfs-2.ext4
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--e2fs-source", type=Path, required=True)
    parser.add_argument("--e2fs-signature", type=Path, required=True)
    parser.add_argument("--e2fs-signing-key", type=Path, required=True)
    parser.add_argument("--runtime-packages", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--jobs", type=int, default=max(1, os.cpu_count() or 1))
    args = parser.parse_args()
    if args.output.exists() or args.output.is_symlink():
        parser.error("--output must not already exist")
    if not 1 <= args.jobs <= 64:
        parser.error("--jobs must be between 1 and 64")

    lock = load_lock()
    verify_locked_file(args.e2fs_source, lock["e2fsprogs"]["source"])
    verify_locked_file(args.e2fs_signature, lock["e2fsprogs"]["signature"])
    verify_locked_file(args.e2fs_signing_key, lock["e2fsprogs"]["signing_key"])
    rootfs = lock["rootfs"]
    runtime_packages = verify_runtime_packages(args.runtime_packages, rootfs["runtime_packages"])
    image = str(rootfs["oci_image"])
    run(["docker", "pull", "--platform", "linux/arm64", image])
    inspected = json.loads(
        run(
            ["docker", "image", "inspect", image, "--format", "{{json .}}"],
            capture=True,
        ).stdout
    )
    if inspected.get("Architecture") != "arm64" or inspected.get("Os") != "linux":
        raise SystemExit("guest rootfs OCI image architecture changed")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="shejane-guest-rootfs-", dir=args.output.parent
    ) as temporary:
        work = Path(temporary)
        frozen_packages = work / "runtime-packages"
        frozen_packages.mkdir()
        for package in runtime_packages:
            shutil.copyfile(package, frozen_packages / package.name)
        verify_runtime_packages(frozen_packages, rootfs["runtime_packages"])
        verify_e2fs_signature(
            args.e2fs_source,
            args.e2fs_signature,
            args.e2fs_signing_key,
            lock,
            work,
        )
        for build in (1, 2):
            container = run(
                [
                    "docker",
                    "create",
                    "--network",
                    "none",
                    "--platform",
                    "linux/arm64",
                    image,
                ],
                capture=True,
            ).stdout.strip()
            try:
                run(
                    [
                        "docker",
                        "export",
                        "--output",
                        str(work / f"rootfs-{build}.tar"),
                        container,
                    ]
                )
            finally:
                remove_container(container)

        builder = run(
            ["docker", "run", "--detach", "--platform", "linux/arm64", image, "sleep", "infinity"],
            capture=True,
        ).stdout.strip()
        try:
            run(
                [
                    "docker",
                    "exec",
                    builder,
                    "sh",
                    "-ceu",
                    "apt-get update >/dev/null && "
                    "apt-get install -y --no-install-recommends build-essential >/dev/null && "
                    "rm -rf /var/lib/apt/lists/* && mkdir /work",
                ],
                timeout=600,
            )
            run(["docker", "network", "disconnect", "bridge", builder])
            run(["docker", "cp", str(args.e2fs_source), f"{builder}:/work/e2fsprogs.tar.xz"])
            run(["docker", "cp", f"{frozen_packages}/.", f"{builder}:/work/runtime-packages"])
            for build in (1, 2):
                run(
                    [
                        "docker",
                        "cp",
                        str(work / f"rootfs-{build}.tar"),
                        f"{builder}:/work/rootfs-{build}.tar",
                    ]
                )
            run(
                [
                    "docker",
                    "exec",
                    builder,
                    "sh",
                    "-ceu",
                    _BUILD_SCRIPT,
                    "shejane-rootfs-builder",
                    str(args.jobs),
                    str(rootfs["source_date_epoch"]),
                    str(int(rootfs["image"]["size"]) // 4096),
                    str(rootfs["debian_version"]),
                    str(rootfs["base_package_manifest_sha256"]),
                    str(rootfs["package_manifest_sha256"]),
                ],
                timeout=1200,
            )
            candidate = work / "guest-rootfs.ext4"
            run(["docker", "cp", f"{builder}:/work/guest-rootfs-1.ext4", str(candidate)])
        finally:
            remove_container(builder)

        size, digest = file_identity(candidate)
        if size != int(rootfs["image"]["size"]) or digest != str(rootfs["image"]["sha256"]):
            raise SystemExit(
                f"guest rootfs reproducible identity changed: size={size} sha256={digest}"
            )
        os.chmod(candidate, 0o444)
        os.replace(candidate, args.output.resolve(strict=False))
    print(args.output.resolve())


def load_lock() -> dict[str, Any]:
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    rootfs = lock.get("rootfs", {})
    packages = rootfs.get("runtime_packages")
    if (
        lock.get("schema_version") != 1
        or rootfs.get("distribution") != "debian"
        or rootfs.get("architecture") != "arm64"
        or rootfs.get("filesystem") != "ext4"
        or rootfs.get("filesystem_uuid") != "00000000-0000-4000-8000-000000000004"
        or rootfs.get("label") != "SHEJANE_SYSTEM"
        or int(rootfs.get("image", {}).get("size", 0)) % 4096
        or not isinstance(packages, list)
        or not packages
        or len({item.get("filename") for item in packages if isinstance(item, dict)})
        != len(packages)
        or any(
            not isinstance(item, dict)
            or not str(item.get("filename", "")).endswith(".deb")
            or item.get("architecture") not in {"all", "arm64"}
            or not str(item.get("url", "")).startswith(
                "https://snapshot.debian.org/archive/debian/"
            )
            or int(item.get("size", 0)) <= 0
            or len(str(item.get("sha256", ""))) != 64
            for item in packages or []
        )
    ):
        raise SystemExit("unsupported Managed Worker guest rootfs lock")
    return lock


def verify_locked_file(path: Path, expected: dict[str, Any]) -> None:
    if path.is_symlink() or not path.is_file():
        raise SystemExit(f"locked input is not a regular file: {path}")
    size, digest = file_identity(path.resolve(strict=True))
    if size != int(expected["size"]) or digest != str(expected["sha256"]):
        raise SystemExit(f"locked input identity changed: {path.name}")


def verify_runtime_packages(directory: Path, expected: list[dict[str, Any]]) -> list[Path]:
    if directory.is_symlink() or not directory.is_dir():
        raise SystemExit(f"runtime package directory is invalid: {directory}")
    expected_names = {str(item["filename"]) for item in expected}
    actual_names = {path.name for path in directory.iterdir()}
    if actual_names != expected_names:
        raise SystemExit("runtime package set changed")
    packages = []
    for item in expected:
        package = directory / str(item["filename"])
        verify_locked_file(package, item)
        packages.append(package)
    return packages


def verify_e2fs_signature(
    source: Path,
    signature: Path,
    signing_key: Path,
    lock: dict[str, Any],
    work: Path,
) -> None:
    home = work / "gpg"
    home.mkdir(mode=0o700)
    run(["gpg", "--homedir", str(home), "--batch", "--import", str(signing_key)])
    expected = lock["e2fsprogs"]["signing_key"]
    fingerprints = run(
        ["gpg", "--homedir", str(home), "--batch", "--with-colons", "--fingerprint"],
        capture=True,
    ).stdout.splitlines()
    if expected["primary_fingerprint"] not in {
        line.split(":")[9] for line in fingerprints if line.startswith("fpr:")
    }:
        raise SystemExit("e2fsprogs signing key fingerprint changed")
    uncompressed = work / "e2fsprogs.tar"
    with lzma.open(source, "rb") as input_stream, uncompressed.open("wb") as output_stream:
        while chunk := input_stream.read(1024 * 1024):
            output_stream.write(chunk)
    verification = run(
        [
            "gpg",
            "--homedir",
            str(home),
            "--batch",
            "--status-fd",
            "1",
            "--verify",
            str(signature),
            str(uncompressed),
        ],
        capture=True,
    ).stdout
    if f"[GNUPG:] VALIDSIG {expected['signing_fingerprint']} " not in verification:
        raise SystemExit("e2fsprogs source signature is invalid")


def file_identity(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def remove_container(container: str) -> None:
    if container:
        subprocess.run(
            ["docker", "rm", "--force", container],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def run(
    command: list[str],
    *,
    capture: bool = False,
    timeout: int = 300,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=True,
        capture_output=capture,
        text=True,
        timeout=timeout,
    )


if __name__ == "__main__":
    main()
