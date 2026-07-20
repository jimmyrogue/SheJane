from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
LOCK = REPO_ROOT / "runtime" / "plugins" / "pdf" / "runtime-assets" / "mupdf-1.27.2.lock.json"


def test_mupdf_lock_freezes_source_components_and_minimal_features() -> None:
    lock = json.loads(LOCK.read_text(encoding="utf-8"))

    assert lock["asset_id"] == "org.mupdf.runtime"
    assert lock["upstream"]["source_size_bytes"] == 66968384
    assert lock["upstream"]["source_sha256"] == (
        "553867b135303dc4c25ab67c5f234d8e900a0e36e66e8484d99adc05fe1e8737"
    )
    assert lock["upstream"]["authentication"] == "pinned_sha256_from_official_https_source"
    assert {"mujs=no", "html=no", "tesseract=no", "barcode=no", "archive=no"}.issubset(
        lock["make_policy"]
    )
    assert {component["name"] for component in lock["compiled_components"]} == {
        "MuPDF",
        "FreeType",
        "jbig2dec",
        "Little CMS",
        "libjpeg",
        "OpenJPEG",
        "zlib",
    }
    assert lock["darwin_build"]["deployment_target"] == "11.0"
    assert lock["linux_builder"] == {
        "oci_image": (
            "debian@sha256:9b67294679b30e5d6ab257b40594feeb4a4b81f7fcf4131f4decf0d6a212a9b0"
        ),
        "snapshot": "20260713T000000Z",
        "build_essential_version": "12.9",
        "package_manifest_sha256": (
            "91549eddea4cd4c23194934b3d82ee4dc09b61297a70fe6a475d79c927f08ce0"
        ),
        "source_date_epoch": 1778491363,
        "gcc_version": "12.2.0-14+deb12u1",
        "make_version": "4.3-4.1",
        "binutils_version": "2.40-2",
        "pkg_config_version": "1.8.1-1",
    }
