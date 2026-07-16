from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

from local_host.plugins.executor import ManagedWorkerActionExecutor
from local_host.plugins.runtime_assets import RuntimeAssetHandle

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER = REPO_ROOT / "plugins" / "pdf" / "worker" / "pdf_worker.py"


def executable(path: Path, source: str) -> None:
    path.write_text("#!/usr/bin/env python3\n" + source, encoding="utf-8")
    path.chmod(0o500)


def fake_asset(tmp_path: Path) -> RuntimeAssetHandle:
    root = tmp_path / "mupdf-asset"
    payload = root / "payload"
    binary = payload / "bin" / "mutool"
    binary.parent.mkdir(parents=True)
    executable(
        binary,
        """import pathlib, sys
args = sys.argv[1:]
if args[0] == "info":
    if args[-1].endswith("encrypted.pdf"):
        print("error: cannot authenticate password", file=sys.stderr)
        raise SystemExit(1)
    print("PDF-1.7\\nPages: 3\\nMedia boxes (3):")
elif args[0] == "draw" and "txt" in args:
    page = int(args[-1])
    print(f"page {page} text")
elif args[0] == "draw" and "png" in args:
    target = pathlib.Path(args[args.index("-o") + 1])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"\\x89PNG\\r\\n\\x1a\\nfixture")
else:
    raise SystemExit(2)
""",
    )
    sbom = root / "sbom.json"
    sbom.write_text("{}", encoding="utf-8")
    return RuntimeAssetHandle(
        asset_id="org.mupdf.runtime",
        version="1.27.2+shejane.1",
        platform="darwin/arm64",
        digest="sha256:" + "a" * 64,
        root=root,
        payload=payload,
        license="AGPL-3.0-only",
        source_url="https://mupdf.com/downloads/archive/mupdf-1.27.2-source.tar.gz",
        sbom=sbom,
    )


def invocation(action_id: str, arguments: dict[str, object], source: Path) -> dict[str, object]:
    data = source.read_bytes()
    return {
        "schema_version": 1,
        "invocation_id": "823e4567-e89b-42d3-a456-426614174001",
        "operation_id": f"run_01:{action_id}:001",
        "action": {
            "plugin_id": "org.shejane.pdf",
            "plugin_version": "0.1.0",
            "plugin_digest": "sha256:" + "b" * 64,
            "action_id": action_id,
        },
        "arguments": arguments,
        "inputs": [
            {
                "id": "source",
                "path": f"/input/source/{source.name}",
                "media_type": "application/pdf",
                "size_bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        ],
        "grants": {"capabilities": ["input.read", "artifact.write"]},
        "limits": {"timeout_ms": 5_000, "memory_mb": 512, "output_mb": 64},
        "environment": {"locale": "en-US", "timezone": "UTC"},
    }


def source_file(tmp_path: Path, name: str = "document.pdf") -> tuple[Path, Path, Path]:
    input_root = tmp_path / "input"
    output_root = tmp_path / "output"
    source = input_root / "source" / name
    source.parent.mkdir(parents=True)
    source.write_bytes(b"%PDF-1.7\n%%EOF\n")
    output_root.mkdir()
    return input_root, output_root, source


@pytest.mark.asyncio
async def test_pdf_worker_inspects_page_count_and_encryption(tmp_path: Path) -> None:
    input_root, output_root, source = source_file(tmp_path)
    executor = ManagedWorkerActionExecutor(
        (sys.executable, str(WORKER)), runtime_assets=(fake_asset(tmp_path),)
    )

    result = await executor.invoke(
        invocation("pdf.inspect", {"input_id": "source"}, source),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "succeeded", result
    assert result["output"] == {"page_count": 3, "encrypted": False}

    encrypted_input_root, encrypted_output_root, encrypted_source = source_file(
        tmp_path / "encrypted", "encrypted.pdf"
    )
    encrypted_result = await executor.invoke(
        invocation("pdf.inspect", {"input_id": "source"}, encrypted_source),
        input_root=encrypted_input_root,
        output_root=encrypted_output_root,
    )

    assert encrypted_result["status"] == "succeeded", encrypted_result
    assert encrypted_result["output"] == {"page_count": None, "encrypted": True}


@pytest.mark.asyncio
async def test_pdf_worker_rejects_encrypted_pdf_extraction(tmp_path: Path) -> None:
    input_root, output_root, source = source_file(tmp_path, "encrypted.pdf")
    executor = ManagedWorkerActionExecutor(
        (sys.executable, str(WORKER)), runtime_assets=(fake_asset(tmp_path),)
    )

    result = await executor.invoke(
        invocation(
            "pdf.extract_text",
            {
                "input_id": "source",
                "start_page": 1,
                "page_count": 1,
                "max_characters": 100,
                "include_artifact": False,
            },
            source,
        ),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "failed", result
    assert result["error"] == {
        "code": "encrypted_pdf",
        "message": "encrypted PDFs are not supported in v1",
        "retryable": False,
    }


@pytest.mark.asyncio
async def test_pdf_worker_extracts_explicit_bounded_page_window(tmp_path: Path) -> None:
    input_root, output_root, source = source_file(tmp_path)
    executor = ManagedWorkerActionExecutor(
        (sys.executable, str(WORKER)), runtime_assets=(fake_asset(tmp_path),)
    )

    result = await executor.invoke(
        invocation(
            "pdf.extract_text",
            {
                "input_id": "source",
                "start_page": 2,
                "page_count": 2,
                "max_characters": 100,
                "include_artifact": True,
            },
            source,
        ),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "succeeded", result
    assert result["output"]["pages"] == [
        {"page_number": 2, "text": "page 2 text", "truncated": False},
        {"page_number": 3, "text": "page 3 text", "truncated": False},
    ]
    assert result["output"]["ocr_required_pages"] == []
    assert (output_root / "pages-0002-0003.txt").is_file()


@pytest.mark.asyncio
async def test_pdf_worker_renders_only_selected_pages(tmp_path: Path) -> None:
    input_root, output_root, source = source_file(tmp_path)
    executor = ManagedWorkerActionExecutor(
        (sys.executable, str(WORKER)), runtime_assets=(fake_asset(tmp_path),)
    )

    result = await executor.invoke(
        invocation(
            "pdf.render_pages",
            {"input_id": "source", "pages": [3, 1], "dpi": 144},
            source,
        ),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "succeeded", result
    assert result["output"]["pages"] == [
        {"page_number": 3, "artifact_name": "page-0003.png"},
        {"page_number": 1, "artifact_name": "page-0001.png"},
    ]
    assert [artifact["name"] for artifact in result["artifacts"]] == [
        "page-0003.png",
        "page-0001.png",
    ]
