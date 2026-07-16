from __future__ import annotations

import asyncio
import hashlib
import os
import sys
from pathlib import Path

import pytest

from local_host.plugins.executor import ManagedWorkerActionExecutor
from local_host.plugins.macos_vm import load_macos_vm_resources
from local_host.plugins.runtime_assets import RuntimeAssetHandle, RuntimeAssetStore

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER = REPO_ROOT / "plugins" / "pdf" / "worker" / "pdf_worker.py"
ASSET_ENV = "SHEJANE_MUPDF_RUNTIME_ASSET"


def real_executor(asset: RuntimeAssetHandle) -> ManagedWorkerActionExecutor:
    frozen = os.environ.get("SHEJANE_TEST_PDF_WORKER")
    command = (frozen,) if frozen else (sys.executable, str(WORKER))
    vm_manifest = os.environ.get("SHEJANE_TEST_MACOS_VM_ASSETS")
    return ManagedWorkerActionExecutor(
        command,
        runtime_assets=(asset,),
        vm_resources=(
            load_macos_vm_resources(Path(vm_manifest).resolve(strict=True)) if vm_manifest else None
        ),
        package_root=Path(command[0]).resolve(strict=True).parent if vm_manifest else None,
    )


def multipage_pdf(texts: tuple[str, ...]) -> bytes:
    page_numbers = [3 + index * 2 for index in range(len(texts))]
    font_number = 3 + len(texts) * 2
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        (
            b"<< /Type /Pages /Kids ["
            + b" ".join(f"{number} 0 R".encode("ascii") for number in page_numbers)
            + f"] /Count {len(texts)} >>".encode("ascii")
        ),
    ]
    for index, text in enumerate(texts):
        page_number = page_numbers[index]
        content_number = page_number + 1
        safe = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = f"BT /F1 12 Tf 72 720 Td ({safe}) Tj ET".encode("ascii")
        objects.extend(
            [
                (
                    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                    + f"/Resources << /Font << /F1 {font_number} 0 R >> >> ".encode("ascii")
                    + f"/Contents {content_number} 0 R >>".encode("ascii")
                ),
                (
                    b"<< /Length "
                    + str(len(stream)).encode("ascii")
                    + b" >>\nstream\n"
                    + stream
                    + b"\nendstream"
                ),
            ]
        )
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    document = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(document))
        document.extend(f"{number} 0 obj\n".encode("ascii"))
        document.extend(body)
        document.extend(b"\nendobj\n")
    xref_offset = len(document)
    document.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    document.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        document.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    document.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
    )
    return bytes(document)


def unicode_pdf(text: str) -> bytes:
    codes = "".join(f"{index:04X}" for index in range(1, len(text) + 1)).encode("ascii")
    stream = b"BT /F1 18 Tf 72 720 Td <" + codes + b"> Tj ET"
    mappings = "\n".join(
        f"<{index:04X}> <{character.encode('utf-16-be').hex().upper()}>"
        for index, character in enumerate(text, start=1)
    ).encode("ascii")
    to_unicode = (
        b"/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
        b"/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
        b"/CMapName /SheJaneUnicode def\n/CMapType 2 def\n"
        b"1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"
        + f"{len(text)} beginbfchar\n".encode("ascii")
        + mappings
        + b"\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend"
    )
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"
        ),
        b"<< /Length "
        + str(len(stream)).encode("ascii")
        + b" >>\nstream\n"
        + stream
        + b"\nendstream",
        (
            b"<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light "
            b"/Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>"
        ),
        (
            b"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light "
            b"/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
            b"/FontDescriptor 8 0 R >>"
        ),
        (
            b"<< /Length "
            + str(len(to_unicode)).encode("ascii")
            + b" >>\nstream\n"
            + to_unicode
            + b"\nendstream"
        ),
        (
            b"<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 "
            b"/FontBBox [-250 -250 1200 1000] /ItalicAngle 0 /Ascent 880 "
            b"/Descent -120 /CapHeight 880 /StemV 80 >>"
        ),
    ]
    document = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(document))
        document.extend(f"{number} 0 obj\n".encode("ascii"))
        document.extend(body)
        document.extend(b"\nendobj\n")
    xref_offset = len(document)
    document.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    document.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        document.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    document.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
    )
    return bytes(document)


def invocation(action_id: str, arguments: dict[str, object], source: Path) -> dict[str, object]:
    data = source.read_bytes()
    return {
        "schema_version": 1,
        "invocation_id": "923e4567-e89b-42d3-a456-426614174001",
        "operation_id": f"run_01:{action_id}:real-asset",
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
        "limits": {"timeout_ms": 30_000, "memory_mb": 512, "output_mb": 64},
        "environment": {"locale": "en-US", "timezone": "UTC"},
    }


@pytest.mark.asyncio
@pytest.mark.skipif(not os.environ.get(ASSET_ENV), reason=f"{ASSET_ENV} is not set")
async def test_real_mupdf_asset_executes_all_pdf_actions(tmp_path: Path) -> None:
    archive = Path(os.environ[ASSET_ENV]).resolve(strict=True)
    asset = RuntimeAssetStore(tmp_path / "data").install(archive)
    executor = real_executor(asset)
    input_root = tmp_path / "input"
    source = input_root / "source" / "document.pdf"
    source.parent.mkdir(parents=True)
    source.write_bytes(multipage_pdf(("First page", "Second page", "Third page")))

    inspect_output = tmp_path / "inspect-output"
    inspect_output.mkdir()
    inspected = await executor.invoke(
        invocation("pdf.inspect", {"input_id": "source"}, source),
        input_root=input_root,
        output_root=inspect_output,
    )
    assert inspected["status"] == "succeeded", inspected
    assert inspected["output"] == {"page_count": 3, "encrypted": False}

    text_output = tmp_path / "text-output"
    text_output.mkdir()
    extracted = await executor.invoke(
        invocation(
            "pdf.extract_text",
            {
                "input_id": "source",
                "start_page": 2,
                "page_count": 2,
                "max_characters": 1_000,
                "include_artifact": True,
            },
            source,
        ),
        input_root=input_root,
        output_root=text_output,
    )
    assert extracted["status"] == "succeeded", extracted
    assert [page["page_number"] for page in extracted["output"]["pages"]] == [2, 3]
    assert "Second page" in extracted["output"]["pages"][0]["text"]
    assert "Third page" in extracted["output"]["pages"][1]["text"]
    assert (text_output / "pages-0002-0003.txt").is_file()

    render_output = tmp_path / "render-output"
    render_output.mkdir()
    rendered = await executor.invoke(
        invocation(
            "pdf.render_pages",
            {"input_id": "source", "pages": [3, 1], "dpi": 144},
            source,
        ),
        input_root=input_root,
        output_root=render_output,
    )
    assert rendered["status"] == "succeeded", rendered
    assert [page["page_number"] for page in rendered["output"]["pages"]] == [3, 1]
    golden_hashes = {
        "page-0001.png": "0cc0ad2e348f7c2c02c64348af96b3ca47ef77959a32572084095ed93b8c4e3b",
        "page-0003.png": "7ccb7ce635a76b71c9813bb302c19eb3a63e1daa628b98ec20f252a5c1c98fa4",
    }
    for name, expected in golden_hashes.items():
        rendered_page = (render_output / "pages" / name).read_bytes()
        assert rendered_page.startswith(b"\x89PNG\r\n\x1a\n")
        assert hashlib.sha256(rendered_page).hexdigest() == expected


@pytest.mark.asyncio
@pytest.mark.skipif(not os.environ.get(ASSET_ENV), reason=f"{ASSET_ENV} is not set")
async def test_real_mupdf_asset_preserves_unicode_and_marks_pages_without_text(
    tmp_path: Path,
) -> None:
    archive = Path(os.environ[ASSET_ENV]).resolve(strict=True)
    asset = RuntimeAssetStore(tmp_path / "data").install(archive)
    executor = real_executor(asset)
    input_root = tmp_path / "input"
    source = input_root / "source" / "unicode.pdf"
    source.parent.mkdir(parents=True)
    source.write_bytes(unicode_pdf("石间 PDF — café"))
    output_root = tmp_path / "unicode-output"
    output_root.mkdir()

    extracted = await executor.invoke(
        invocation(
            "pdf.extract_text",
            {
                "input_id": "source",
                "start_page": 1,
                "page_count": 1,
                "max_characters": 1_000,
                "include_artifact": True,
            },
            source,
        ),
        input_root=input_root,
        output_root=output_root,
    )

    assert extracted["status"] == "succeeded", extracted
    assert extracted["output"]["pages"][0]["text"] == "石间 PDF — café"
    assert extracted["output"]["ocr_required_pages"] == []
    assert (
        (output_root / "pages-0001-0001.txt")
        .read_text(encoding="utf-8")
        .endswith("石间 PDF — café\n")
    )

    blank = input_root / "source" / "blank.pdf"
    blank.write_bytes(multipage_pdf(("",)))
    blank_output = tmp_path / "blank-output"
    blank_output.mkdir()
    blank_result = await executor.invoke(
        invocation(
            "pdf.extract_text",
            {
                "input_id": "source",
                "start_page": 1,
                "page_count": 1,
                "max_characters": 1_000,
                "include_artifact": False,
            },
            blank,
        ),
        input_root=input_root,
        output_root=blank_output,
    )
    assert blank_result["status"] == "succeeded", blank_result
    assert blank_result["output"]["ocr_required_pages"] == [1]
    assert blank_result["artifacts"] == []


@pytest.mark.asyncio
@pytest.mark.skipif(not os.environ.get(ASSET_ENV), reason=f"{ASSET_ENV} is not set")
async def test_real_mupdf_asset_rejects_malformed_pdf_without_artifacts(tmp_path: Path) -> None:
    archive = Path(os.environ[ASSET_ENV]).resolve(strict=True)
    asset = RuntimeAssetStore(tmp_path / "data").install(archive)
    executor = real_executor(asset)
    input_root = tmp_path / "input"
    source = input_root / "source" / "broken.pdf"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"%PDF-1.7\ntruncated")
    output_root = tmp_path / "output"
    output_root.mkdir()

    result = await executor.invoke(
        invocation("pdf.render_pages", {"input_id": "source", "pages": [1], "dpi": 72}, source),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "failed", result
    assert result["artifacts"] == []
    assert not any(path.is_file() for path in output_root.rglob("*"))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        b"",
        b"%PDF-1.7\n" + b"\x00" * 65_536,
        b"%PDF-1.7\n1 0 obj << /Length 2147483647 >> stream\n",
        b"%PDF-1.7\n1 0 obj << /Kids [1 0 R] >> endobj\n%%EOF\n",
    ],
    ids=("empty", "nul-body", "oversized-stream", "recursive-object"),
)
@pytest.mark.skipif(not os.environ.get(ASSET_ENV), reason=f"{ASSET_ENV} is not set")
async def test_real_mupdf_asset_hostile_corpus_fails_closed(tmp_path: Path, payload: bytes) -> None:
    archive = Path(os.environ[ASSET_ENV]).resolve(strict=True)
    asset = RuntimeAssetStore(tmp_path / "data").install(archive)
    executor = real_executor(asset)
    input_root = tmp_path / "input"
    source = input_root / "source" / "hostile.pdf"
    source.parent.mkdir(parents=True)
    source.write_bytes(payload)
    output_root = tmp_path / "output"
    output_root.mkdir()

    result = await executor.invoke(
        invocation("pdf.inspect", {"input_id": "source"}, source),
        input_root=input_root,
        output_root=output_root,
    )

    assert result["status"] == "failed", result
    assert result["artifacts"] == []
    assert not any(path.is_file() for path in output_root.rglob("*"))


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.environ.get(ASSET_ENV) or not os.environ.get("SHEJANE_TEST_MACOS_VM_ASSETS"),
    reason="real packaged VM assets are required",
)
async def test_real_mupdf_asset_cancellation_discards_partial_render(
    tmp_path: Path,
) -> None:
    archive = Path(os.environ[ASSET_ENV]).resolve(strict=True)
    asset = RuntimeAssetStore(tmp_path / "data").install(archive)
    executor = real_executor(asset)
    input_root = tmp_path / "input"
    source = input_root / "source" / "large.pdf"
    source.parent.mkdir(parents=True)
    source.write_bytes(multipage_pdf(tuple(f"Page {page}" for page in range(1, 101))))
    output_root = tmp_path / "output"
    output_root.mkdir()
    render_started = asyncio.Event()

    def on_progress(event: dict[str, object]) -> None:
        if event.get("phase") == "render.pages":
            render_started.set()

    task = asyncio.create_task(
        executor.invoke(
            invocation(
                "pdf.render_pages",
                {"input_id": "source", "pages": list(range(1, 17)), "dpi": 300},
                source,
            ),
            input_root=input_root,
            output_root=output_root,
            on_progress=on_progress,
        )
    )
    await asyncio.wait_for(render_started.wait(), timeout=30)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert not any(path.is_file() for path in output_root.rglob("*"))

    probe_output = tmp_path / "probe-output"
    probe_output.mkdir()
    probed = await executor.invoke(
        invocation("pdf.inspect", {"input_id": "source"}, source),
        input_root=input_root,
        output_root=probe_output,
    )
    assert probed["status"] == "succeeded", probed
    assert probed["output"]["page_count"] == 100
