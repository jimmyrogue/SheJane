from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

from shejane_runtime.plugins.manifest import PluginManifest, load_plugin_manifest
from shejane_runtime.plugins.package import extract_plugin_archive

REPO_ROOT = Path(__file__).resolve().parents[2]
ROOT = REPO_ROOT / "runtime" / "plugins" / "media-foundation"
BUILDER = ROOT / "build_package.py"


def test_media_foundation_manifest_and_action_schemas_are_strict() -> None:
    template = (ROOT / ".shejane-plugin" / "plugin.template.json").read_text(encoding="utf-8")
    manifest = PluginManifest.model_validate_json(
        template.replace("__PLUGIN_VERSION__", "0.1.0")
        .replace("__ENTRYPOINT__", "payload/media-foundation-worker")
        .replace("__PLATFORM__", "linux/arm64")
        .replace("__RUNTIME_ASSET_DIGEST__", "sha256:" + "a" * 64)
    )

    assert manifest.runtime.execution.kind == "managed_worker"
    assert manifest.runtime.execution.runtime_assets[0].id == "org.ffmpeg.runtime"
    assert {action.id for action in manifest.contributions.actions} == {
        "media.probe",
        "media.thumbnail",
        "media.extract_frames",
        "media.extract_audio",
    }
    for action in manifest.contributions.actions:
        for relative in (action.input_schema, action.output_schema):
            schema = json.loads((ROOT / relative).read_text(encoding="utf-8"))
            Draft202012Validator.check_schema(schema)
            assert schema["additionalProperties"] is False


def test_ffmpeg_source_lock_freezes_signed_lgpl_build_policy() -> None:
    lock = json.loads(
        (ROOT / "runtime-assets" / "ffmpeg-8.1.2.lock.json").read_text(encoding="utf-8")
    )

    assert lock["asset_id"] == "org.ffmpeg.runtime"
    assert lock["upstream"] == {
        "name": "FFmpeg",
        "version": "8.1.2",
        "license": "LGPL-2.1-or-later",
        "source_url": "https://www.ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz",
        "signature_url": "https://www.ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz.asc",
        "signing_key_url": "https://www.ffmpeg.org/ffmpeg-devel.asc",
        "signing_key_fingerprint": "FCF986EA15E6E293A5644F10B4322F04D67658D8",
        "source_size_bytes": 11710924,
        "source_sha256": "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c",
    }
    assert "--disable-network" in lock["configure_policy"]
    assert "--enable-zlib" in lock["configure_policy"]
    assert "--disable-decoders" in lock["configure_policy"]
    assert "--disable-demuxers" in lock["configure_policy"]
    assert "--disable-protocols" in lock["configure_policy"]
    assert "--enable-protocol=file,pipe" in lock["configure_policy"]
    assert set(lock["required_capabilities"]["encoders"]) == {
        "png",
        "pcm_s16le",
        "flac",
        "mjpeg",
    }
    assert set(lock["required_capabilities"]["protocols"]) == {"file", "pipe"}
    assert lock["system_dependencies"] == [
        {"name": "zlib", "license": "Zlib", "purpose": "PNG encoding and decoding"}
    ]
    assert lock["darwin_build"] == {
        "xcode_version": "26.6",
        "xcode_build": "17F113",
        "clang_version": "Apple clang version 21.0.0 (clang-2100.1.1.101)",
        "sdk_version": "26.5",
        "deployment_target": "11.0",
        "make_version": "GNU Make 3.81",
    }
    assert lock["linux_builder"]["oci_image"] == (
        "debian@sha256:9b67294679b30e5d6ab257b40594feeb4a4b81f7fcf4131f4decf0d6a212a9b0"
    )
    assert lock["linux_builder"]["package_manifest_sha256"] == (
        "5df3d5e6c7b95977f5c4115d31b6069bae233732dfbb649f147f995674538df0"
    )
    assert set(lock["forbidden_configuration"]) == {"--enable-gpl", "--enable-nonfree"}


def test_media_package_is_deterministic_and_preserves_onedir_worker(tmp_path: Path) -> None:
    worker = tmp_path / "media-foundation-worker"
    worker.mkdir()
    (worker / "media-foundation-worker").write_bytes(b"worker")
    (worker / "_internal").mkdir()
    (worker / "_internal" / "libpython.so").write_bytes(b"library")
    outputs = [tmp_path / "first.shejane-plugin", tmp_path / "second.shejane-plugin"]
    for output in outputs:
        subprocess.run(
            [
                sys.executable,
                str(BUILDER),
                "--platform",
                "linux/arm64",
                "--runtime-asset-digest",
                "sha256:" + "a" * 64,
                "--worker",
                str(worker),
                "--output",
                str(output),
            ],
            check=True,
        )

    assert outputs[0].read_bytes() == outputs[1].read_bytes()
    extracted = tmp_path / "extracted"
    extract_plugin_archive(outputs[0], extracted)
    manifest = load_plugin_manifest(extracted)
    assert manifest.runtime.execution.platforms == ["linux/arm64"]
    assert (extracted / "payload/media-foundation-worker").read_bytes() == b"worker"
    assert (extracted / "payload/_internal/libpython.so").read_bytes() == b"library"
