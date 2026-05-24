"""Unit tests for office.read and office.outline.

The fixtures here are built on-the-fly with python-docx / openpyxl so we
don't have to check binary files into the repo. Each test owns its own
tmp_path-scoped file.

Office tools don't proxy through any external service (markitdown +
python-docx + openpyxl all run in-process), so these are vanilla unit
tests — no MockTransport, no settings override needed.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from docx import Document
from openpyxl import Workbook

from local_host.tools.office import OFFICE_READ_TOOLS, office_outline, office_read


def _make_docx(tmp_path: Path) -> Path:
    """Build a tiny .docx with heading + paragraphs + a table."""
    p = tmp_path / "sample.docx"
    doc = Document()
    doc.add_heading("Executive Summary", level=1)
    doc.add_paragraph("First paragraph with some prose.")
    doc.add_heading("Methodology", level=2)
    doc.add_paragraph("Methodology details here.")
    doc.add_paragraph("Another methodology paragraph.")
    table = doc.add_table(rows=2, cols=2)
    table.rows[0].cells[0].text = "Year"
    table.rows[0].cells[1].text = "Value"
    table.rows[1].cells[0].text = "2025"
    table.rows[1].cells[1].text = "42"
    doc.save(p)
    return p


def _make_xlsx(tmp_path: Path) -> Path:
    """Build a tiny .xlsx with two sheets."""
    p = tmp_path / "sample.xlsx"
    wb = Workbook()
    ws1 = wb.active
    ws1.title = "Sales"
    ws1.append(["Quarter", "Revenue"])
    ws1.append(["Q1", 100])
    ws1.append(["Q2", 150])
    ws2 = wb.create_sheet("Costs")
    ws2.append(["Item", "Amount"])
    ws2.append(["Rent", 50])
    wb.save(p)
    return p


def test_office_read_docx_returns_markdown(tmp_path: Path) -> None:
    """office.read on a .docx → markdown with the headings preserved."""
    path = _make_docx(tmp_path)
    result = office_read.func(path=str(path))
    assert result["ok"] == "true"
    assert result["kind"] == "word"
    md = result["markdown"]
    # Heading text should survive in the markdown output. markitdown's
    # exact heading-level mapping varies; assert the text is there.
    assert "Executive Summary" in md
    assert "Methodology" in md
    # Table contents should also surface.
    assert "Year" in md and "Value" in md
    # Not truncated for a tiny doc.
    assert result["truncated"] == "false"


def test_office_read_xlsx_returns_markdown(tmp_path: Path) -> None:
    """office.read on a .xlsx → markdown with both sheets."""
    path = _make_xlsx(tmp_path)
    result = office_read.func(path=str(path))
    assert result["ok"] == "true"
    assert result["kind"] == "excel"
    md = result["markdown"]
    # Both sheet names should appear (markitdown sections by sheet).
    assert "Sales" in md
    assert "Costs" in md
    # Cell contents should surface.
    assert "Q1" in md and "100" in md


def test_office_read_missing_file_returns_error(tmp_path: Path) -> None:
    """office.read on a non-existent path → ok=false, no crash."""
    result = office_read.func(path=str(tmp_path / "missing.docx"))
    assert result["ok"] == "false"
    assert "not found" in result["error"]


def test_office_read_wrong_extension_returns_error(tmp_path: Path) -> None:
    """office.read on a .txt → ok=false steering the LLM to read_file."""
    txt = tmp_path / "note.txt"
    txt.write_text("plain text")
    result = office_read.func(path=str(txt))
    assert result["ok"] == "false"
    # Error message should mention the supported extensions so the LLM
    # can self-correct on the next call.
    assert ".docx" in result["error"] and ".xlsx" in result["error"]


def test_office_read_empty_path_returns_error() -> None:
    """office.read with empty path → ok=false (matches workspace.open's behavior)."""
    result = office_read.func(path="")
    assert result["ok"] == "false"
    assert result["error"] == "path required"


def test_office_outline_docx_lists_headings(tmp_path: Path) -> None:
    """office.outline on .docx surfaces heading text + paragraph/table counts."""
    path = _make_docx(tmp_path)
    result = office_outline.func(path=str(path))
    assert result["ok"] == "true"
    assert result["kind"] == "word"
    heading_texts = [h["text"] for h in result["headings"]]
    assert "Executive Summary" in heading_texts
    assert "Methodology" in heading_texts
    # Two top-level + one subsection means at least one heading per level.
    levels = {h["level"] for h in result["headings"]}
    assert 1 in levels and 2 in levels
    # Paragraphs: 2 headings + 3 body paragraphs (heading paragraphs count
    # too in python-docx's iteration); >= 5 is the safe bound.
    assert result["paragraph_count"] >= 5
    assert result["table_count"] == 1


def test_office_outline_xlsx_lists_sheets(tmp_path: Path) -> None:
    """office.outline on .xlsx surfaces sheet names + dimensions."""
    path = _make_xlsx(tmp_path)
    result = office_outline.func(path=str(path))
    assert result["ok"] == "true"
    assert result["kind"] == "excel"
    sheet_names = [s["name"] for s in result["sheets"]]
    assert sheet_names == ["Sales", "Costs"]
    sales = next(s for s in result["sheets"] if s["name"] == "Sales")
    assert sales["rows"] == 3  # header + 2 data rows
    assert sales["columns"] == 2


def test_office_outline_wrong_extension_returns_error(tmp_path: Path) -> None:
    """office.outline rejects non-office files just like office.read."""
    txt = tmp_path / "x.csv"
    txt.write_text("a,b\n1,2\n")
    result = office_outline.func(path=str(txt))
    assert result["ok"] == "false"
    assert "unsupported extension" in result["error"]


def test_office_tools_registered_under_canonical_names() -> None:
    """Sanity: OFFICE_READ_TOOLS exposes the two tools by their dotted names."""
    names = sorted(t.name for t in OFFICE_READ_TOOLS)
    assert names == ["office.outline", "office.read"]


def test_office_read_truncates_large_output(tmp_path: Path) -> None:
    """office.read above the 60_000 char cap → truncated="true" + the cap."""
    from local_host.tools import office as office_module

    # Build a .docx with way more than 60k chars of body text by repeating
    # a paragraph many times. Cheaper than the LLM cap test using fixtures.
    p = tmp_path / "big.docx"
    doc = Document()
    para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " * 50  # ~2900 chars/para
    for _ in range(25):  # ~72500 chars total before markdown overhead
        doc.add_paragraph(para)
    doc.save(p)
    result = office_read.func(path=str(p))
    assert result["ok"] == "true"
    assert result["truncated"] == "true"
    # The cap is enforced on the returned markdown; allow some slack for
    # the trailing "…(truncated, full size = N chars)" suffix.
    assert len(result["markdown"]) >= office_module._MARKDOWN_CHAR_CAP
    assert len(result["markdown"]) < office_module._MARKDOWN_CHAR_CAP + 200


@pytest.mark.parametrize("ext", [".doc", ".xls", ".pptx", ".pdf"])
def test_office_read_rejects_non_supported_office_extensions(tmp_path: Path, ext: str) -> None:
    """office.read explicitly rejects .doc / .xls / .pptx / .pdf — we only
    support OOXML formats in Phase 1. Phase 2 may revisit .doc/.xls (the
    legacy binary formats require a separate parser)."""
    p = tmp_path / f"x{ext}"
    p.write_bytes(b"\x00")  # dummy bytes, validation happens on extension first
    result = office_read.func(path=str(p))
    assert result["ok"] == "false"
    assert ext in result["error"] or "unsupported extension" in result["error"]
