from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
ASSET_ROOT = REPO_ROOT / "plugins" / "vision" / "runtime-assets"
LOCK_PATH = ASSET_ROOT / "llama-mtmd-b10025.lock.json"


def load_builder():
    spec = importlib.util.spec_from_file_location(
        "vision_asset_builder", ASSET_ROOT / "build_darwin.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_vision_asset_lock_freezes_source_models_and_cpu_policy() -> None:
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))

    assert lock["asset_id"] == "org.llama-mtmd.runtime"
    assert lock["asset_version"] == "b10025+smolvlm2-500m-q8-0.shejane.1"
    assert lock["platform"] == "darwin/arm64"
    assert lock["llama_cpp"]["tag"] == "b10025"
    assert lock["llama_cpp"]["commit"] == ("a3e5b96ac5e278c390df429df0b68efcee3ee1b5")
    assert lock["llama_cpp"]["source_sha256"] == (
        "0c173562b6096f60fb8cc0b320d69e13ae27f4c31e34f9859d47658571e141b2"
    )
    assert lock["model"]["sha256"] == (
        "6f67b8036b2469fcd71728702720c6b51aebd759b78137a8120733b4d66438bc"
    )
    assert lock["projector"]["sha256"] == (
        "921dc7e259f308e5b027111fa185efcbf33db13f6e35749ddf7f5cdb60ef520b"
    )
    assert lock["inference_policy"] == {
        "network": False,
        "gpu": False,
        "threads": 1,
        "seed": 0,
        "context_tokens": 8192,
        "model_selection": "asset_fixed",
    }
    assert {
        "-DBUILD_SHARED_LIBS=OFF",
        "-DGGML_METAL=OFF",
        "-DGGML_BLAS=OFF",
        "-DGGML_ACCELERATE=OFF",
        "-DGGML_RPC=OFF",
        "-DLLAMA_CURL=OFF",
        "-DLLAMA_BUILD_SERVER=OFF",
        "-DLLAMA_BUILD_COMMON=OFF",
        "-DLLAMA_BUILD_TOOLS=OFF",
        "-DLLAMA_BUILD_MTMD=ON",
    }.issubset(lock["cmake_policy"])
    assert {item["name"] for item in lock["compiled_components"]} == {
        "llama.cpp",
        "libmtmd",
        "nlohmann JSON",
        "SmolVLM2-500M-Video-Instruct GGUF",
    }


def test_vision_asset_builder_rejects_changed_locked_input(tmp_path: Path) -> None:
    builder = load_builder()
    changed = tmp_path / "changed.gguf"
    changed.write_bytes(b"changed")
    expected = {"size_bytes": 7, "sha256": "0" * 64}

    with pytest.raises(SystemExit, match="does not match the lock"):
        builder.verify_file(changed, expected, "model")


def test_vision_engine_links_core_libraries_without_http_common_layer() -> None:
    cmake = (ASSET_ROOT / "CMakeLists.txt").read_text(encoding="utf-8")
    source = (ASSET_ROOT / "vision_engine.cpp").read_text(encoding="utf-8")

    assert "target_link_libraries(vision-engine PRIVATE llama mtmd)" in cmake
    assert "LLAMA_BUILD_COMMON OFF" in cmake
    assert "LLAMA_BUILD_TOOLS OFF" in cmake
    assert "MTMD_VIDEO OFF" in cmake
    assert "llama_backend_init()" in source
    assert "mtmd_init_from_file" in source
    assert "llama-common" not in cmake
    assert "common_init" not in source
    assert "system(" not in source
    assert "popen(" not in source
    assert "curl" not in source.casefold()
