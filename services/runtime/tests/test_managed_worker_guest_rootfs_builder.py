from __future__ import annotations

import hashlib
import importlib.util
import lzma
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).parents[3]
BUILDER = ROOT / "apps" / "desktop" / "vm-assets" / "build_guest_rootfs.py"


def _load_builder():
    spec = importlib.util.spec_from_file_location("managed_worker_guest_rootfs_builder", BUILDER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_guest_rootfs_builder_verifies_exact_runtime_package_set(tmp_path: Path) -> None:
    builder = _load_builder()
    package = tmp_path / "runtime.deb"
    package.write_bytes(b"locked package")
    expected = [
        {
            "filename": package.name,
            "size": package.stat().st_size,
            "sha256": hashlib.sha256(package.read_bytes()).hexdigest(),
        }
    ]

    assert builder.verify_runtime_packages(tmp_path, expected) == [package]

    package.write_bytes(b"tampered package")
    with pytest.raises(SystemExit, match="identity changed"):
        builder.verify_runtime_packages(tmp_path, expected)

    package.write_bytes(b"locked package")
    (tmp_path / "unexpected.deb").write_bytes(b"unexpected")
    with pytest.raises(SystemExit, match="set changed"):
        builder.verify_runtime_packages(tmp_path, expected)


def test_guest_rootfs_signature_uses_short_system_gpg_home(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    builder = _load_builder()
    source = tmp_path / "source.tar.xz"
    source.write_bytes(lzma.compress(b"source archive"))
    signature = tmp_path / "source.tar.sign"
    signature.write_bytes(b"signature")
    key = tmp_path / "key.asc"
    key.write_bytes(b"key")
    homes: list[Path] = []

    def fake_run(command, *, capture=False, timeout=None):
        del timeout
        home = Path(command[command.index("--homedir") + 1])
        homes.append(home)
        if "--fingerprint" in command:
            return SimpleNamespace(stdout="fpr:::::::::PRIMARY:\n")
        if "--verify" in command:
            return SimpleNamespace(stdout="[GNUPG:] VALIDSIG SIGNING rest\n")
        return SimpleNamespace(stdout="" if capture else None)

    monkeypatch.setattr(builder, "run", fake_run)
    work = tmp_path / ("deep-" * 20)
    work.mkdir()

    builder.verify_e2fs_signature(
        source,
        signature,
        key,
        {
            "e2fsprogs": {
                "signing_key": {
                    "primary_fingerprint": "PRIMARY",
                    "signing_fingerprint": "SIGNING",
                }
            }
        },
        work,
    )

    assert homes
    assert all(work not in home.parents for home in homes)
