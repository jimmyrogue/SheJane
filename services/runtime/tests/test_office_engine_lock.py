from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
LOCK = REPO_ROOT / "plugins" / "office" / "runtime-assets" / "libreoffice-25.8.7.lock.json"
TARGETS = {
    "darwin/arm64",
    "darwin/amd64",
    "linux/arm64",
    "linux/amd64",
    "windows/arm64",
    "windows/amd64",
}


def test_office_engine_lock_pins_every_managed_worker_platform() -> None:
    lock = json.loads(LOCK.read_text(encoding="utf-8"))

    assert lock["asset_id"] == "org.libreoffice.runtime"
    assert lock["asset_version"] == "25.8.7"
    assert set(lock["libreoffice"]["platforms"]) == TARGETS
    for artifact in lock["libreoffice"]["platforms"].values():
        assert artifact["url"].startswith("https://download.documentfoundation.org/")
        assert artifact["size_bytes"] > 64 * 1024 * 1024
        assert re.fullmatch(r"[0-9a-f]{64}", artifact["sha256"])

    source = lock["libreoffice"]["source"]
    assert source["size_bytes"] > 0
    assert re.fullmatch(r"[0-9a-f]{64}", source["sha256"])
    assert lock["pdf_renderer"]["version"] == "1.27.2"
    assert lock["pdf_renderer"]["source_size_bytes"] > 0
    assert re.fullmatch(r"[0-9a-f]{64}", lock["pdf_renderer"]["source_sha256"])
    assert lock["font_baseline"]["version"] == "2.004"
    assert lock["font_baseline"]["size_bytes"] > 0
    assert re.fullmatch(r"[0-9a-f]{64}", lock["font_baseline"]["sha256"])

    linux = lock["libreoffice"]["platforms"]["linux/arm64"]
    assert linux["signature"]["url"] == f"{linux['url']}.asc"
    assert linux["signature"]["signing_fingerprint"] == ("C2839ECAD9408FBE9531C3E9F434A1EFAFEEAEA3")
    signing_key = LOCK.parent / linux["signing_key"]["path"]
    assert signing_key.stat().st_size == linux["signing_key"]["size_bytes"]
    assert hashlib.sha256(signing_key.read_bytes()).hexdigest() == linux["signing_key"]["sha256"]

    builder = lock["linux_builder"]
    assert builder["oci_image"].startswith("debian@sha256:")
    assert re.fullmatch(r"[0-9a-f]{64}", builder["package_manifest_sha256"])
    assert re.fullmatch(r"\d{8}T\d{6}Z", builder["snapshot"])
