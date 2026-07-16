from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
ASSET_ROOT = REPO_ROOT / "plugins" / "speech" / "runtime-assets"
LOCK_PATH = ASSET_ROOT / "whisper-1.8.6.lock.json"
MODEL_REQUIREMENTS = ASSET_ROOT / "model-requirements-darwin-arm64.lock"


def load_builder():
    spec = importlib.util.spec_from_file_location(
        "speech_asset_builder", ASSET_ROOT / "build_darwin.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_whisper_asset_lock_freezes_source_model_and_cpu_policy() -> None:
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))

    assert lock["asset_id"] == "org.whisper.runtime"
    assert lock["asset_version"] == "1.8.6+large-v3-turbo-q5-0.shejane.1"
    assert lock["whisper_cpp"]["commit"] == ("23ee03506a91ac3d3f0071b40e66a430eebdfa1d")
    assert lock["checkpoint"]["sha256"] == (
        "aff26ae408abcba5fbf8813c21e62b0941638c5f6eebfb145be0c9839262a19a"
    )
    assert lock["model_build"]["quantization"] == "q5_0"
    assert lock["model_build"]["quantized_sha256"] == (
        "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"
    )
    assert {
        "-DGGML_METAL=OFF",
        "-DGGML_BLAS=OFF",
        "-DGGML_ACCELERATE=OFF",
        "-DGGML_RPC=OFF",
        "-DWHISPER_CURL=OFF",
        "-DWHISPER_COREML=OFF",
    }.issubset(lock["cmake_policy"])
    assert {item["name"] for item in lock["compiled_components"]} == {
        "whisper.cpp",
        "nlohmann JSON",
        "OpenAI Whisper model",
    }


def test_whisper_asset_builder_rejects_changed_model(tmp_path: Path) -> None:
    builder = load_builder()
    changed = tmp_path / "changed.bin"
    changed.write_bytes(b"changed")
    lock = {
        "model_build": {
            "quantized_size_bytes": 1,
            "quantized_sha256": "0" * 64,
        }
    }

    with pytest.raises(SystemExit, match="does not match"):
        builder.verify_model(changed, lock)


def test_whisper_model_builder_dependency_closure_is_hashed() -> None:
    text = MODEL_REQUIREMENTS.read_text(encoding="utf-8")
    packages = set(re.findall(r"(?m)^([a-z0-9-]+)==", text))
    hashes = re.findall(r"--hash=sha256:([0-9a-f]{64})", text)

    assert packages == {
        "cmake",
        "filelock",
        "fsspec",
        "jinja2",
        "markupsafe",
        "mpmath",
        "networkx",
        "numpy",
        "setuptools",
        "sympy",
        "torch",
        "typing-extensions",
    }
    assert len(hashes) == len(packages)
