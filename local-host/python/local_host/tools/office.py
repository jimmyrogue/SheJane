"""office.* — read and outline tools for Word (.docx) and Excel (.xlsx).

Phase 1 surface is read-only. The agent uses `office.read` to get the full
content as LLM-ready markdown (via Microsoft's `markitdown` library, which
wraps `mammoth` for .docx and `pandas` for .xlsx). `office.outline` is the
cheap path — it lists headings / sheets without reading the body, so the
agent can decide whether to open the file at all before paying the read.

Phase 2 will add edit primitives (`office.find_replace`, `office.set_cells`,
…) backed by `python-docx` and `openpyxl`. They will live in this module
under a separate `OFFICE_WRITE_TOOLS` list so the registry can wire HITL
permission gating uniformly.

Path safety: the daemon trusts the agent to pass paths that came out of
`workspace.open` (downstream fs / shell tools rely on the same contract).
We do basic existence + extension checks here so a malformed call returns
a clean error instead of an exception, but we do NOT independently verify
the path is inside an authorized workspace — that's the FilesystemMiddleware's
job for fs.* and will move to a shared helper when Phase 2's write tools
land.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from docx import Document as DocxDocument
from langchain_core.tools import tool
from markitdown import MarkItDown
from openpyxl import load_workbook

# Module-level converter — MarkItDown is cheap to construct but creating it
# once is even cheaper, and it's thread-safe for the read API we use.
_md = MarkItDown()

# Hard cap on returned markdown size. A 50-page docx is typically ~30 KB
# of text; a 100-sheet xlsx ingested as markdown tables can blow past
# 200 KB. We truncate so the LLM context doesn't get nuked by one
# `office.read` call. The agent gets told upfront in the return shape.
_MARKDOWN_CHAR_CAP = 60_000

# Mapping from extension to the human-readable kind we surface to the
# client. Used by both office.read and office.outline so the frontend
# can pick the right preview component.
_EXTENSION_KIND = {
    ".docx": "word",
    ".xlsx": "excel",
}


def _validate_path(path: str) -> tuple[str | None, str | None, str | None]:
    """Resolve and validate the file path.

    Returns (resolved_path, kind, error). On success error is None; on
    failure resolved_path/kind are None and error describes what went wrong.
    """
    if not path:
        return None, None, "path required"
    resolved = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(resolved):
        return None, None, f"file not found: {resolved}"
    ext = Path(resolved).suffix.lower()
    kind = _EXTENSION_KIND.get(ext)
    if not kind:
        return (
            None,
            None,
            (
                f"unsupported extension {ext!r}; office.* only handles .docx and .xlsx "
                "(use read_file for plain text, image.* for images)"
            ),
        )
    return resolved, kind, None


@tool("office.read")
def office_read(path: str) -> dict[str, Any]:
    """Read a Word (.docx) or Excel (.xlsx) file as LLM-ready markdown.

    Prefer this over `read_file` for these extensions — `read_file` would
    return the raw ZIP/XML which is useless for analysis. This tool runs
    `markitdown` which converts headings, paragraphs, tables, and cells
    into clean markdown the LLM can reason about directly.

    The client also uses the SUCCESS of this call as the trigger to open
    the right-side document preview panel, so call it whenever the user
    asks you to look at or summarize an office file even if the markdown
    isn't strictly needed for your reply.

    Args:
        path: Absolute filesystem path to a .docx or .xlsx file. Must
              already exist. Use `workspace.open` first if the file
              lives in a directory the agent hasn't been authorized for.

    Returns:
        dict with keys:
          ok ("true" / "false")
          path (echoed back, absolute)
          kind ("word" or "excel")
          markdown (the converted markdown content, possibly truncated)
          truncated ("true" / "false") — set when content exceeded the cap
          error (only present when ok="false")
    """
    resolved, kind, err = _validate_path(path)
    if err is not None:
        return {"ok": "false", "error": err}
    assert resolved is not None and kind is not None  # for type checker
    try:
        result = _md.convert(resolved)
    except Exception as exc:
        return {
            "ok": "false",
            "path": resolved,
            "kind": kind,
            "error": f"failed to convert {kind}: {exc.__class__.__name__}: {exc}",
        }
    text = result.text_content or ""
    truncated = len(text) > _MARKDOWN_CHAR_CAP
    if truncated:
        text = (
            text[:_MARKDOWN_CHAR_CAP]
            + "\n\n…(truncated, full size = "
            + str(len(result.text_content))
            + " chars)"
        )
    return {
        "ok": "true",
        "path": resolved,
        "kind": kind,
        "markdown": text,
        "truncated": "true" if truncated else "false",
    }


def _outline_docx(path: str) -> dict[str, Any]:
    """Cheap structural summary of a .docx — heading text and paragraph count."""
    doc = DocxDocument(path)
    headings: list[dict[str, Any]] = []
    paragraph_count = 0
    table_count = len(doc.tables)
    for para in doc.paragraphs:
        paragraph_count += 1
        style_name = (para.style.name if para.style is not None else "") or ""
        if style_name.startswith("Heading"):
            # Style names are "Heading 1", "Heading 2", … so the trailing
            # digit is the level.
            level_str = style_name.split()[-1] if " " in style_name else "1"
            try:
                level = int(level_str)
            except ValueError:
                level = 1
            text = para.text.strip()
            if text:
                headings.append({"level": level, "text": text})
    return {
        "headings": headings,
        "paragraph_count": paragraph_count,
        "table_count": table_count,
    }


def _outline_xlsx(path: str) -> dict[str, Any]:
    """Cheap structural summary of a .xlsx — sheet names + dimensions."""
    wb = load_workbook(path, read_only=True, data_only=True)
    sheets: list[dict[str, Any]] = []
    try:
        for name in wb.sheetnames:
            ws = wb[name]
            sheets.append(
                {
                    "name": name,
                    "rows": ws.max_row or 0,
                    "columns": ws.max_column or 0,
                }
            )
    finally:
        wb.close()
    return {"sheets": sheets}


@tool("office.outline")
def office_outline(path: str) -> dict[str, Any]:
    """Return a cheap structural summary of a .docx or .xlsx file.

    Use this BEFORE `office.read` when the file is large and you only need
    to know what's in it — for example: "tell me what sheets are in
    Q4.xlsx" or "does report.docx have a section about pricing?".
    Reading the outline is O(metadata); reading the full markdown is
    O(file).

    Args:
        path: Absolute filesystem path to a .docx or .xlsx file.

    Returns:
        dict with keys:
          ok ("true" / "false")
          path (echoed back, absolute)
          kind ("word" or "excel")
          For .docx: headings (list of {level, text}), paragraph_count,
                     table_count.
          For .xlsx: sheets (list of {name, rows, columns}).
          error (only present when ok="false")
    """
    resolved, kind, err = _validate_path(path)
    if err is not None:
        return {"ok": "false", "error": err}
    assert resolved is not None and kind is not None
    try:
        details = _outline_docx(resolved) if kind == "word" else _outline_xlsx(resolved)
    except Exception as exc:
        return {
            "ok": "false",
            "path": resolved,
            "kind": kind,
            "error": f"failed to read {kind} outline: {exc.__class__.__name__}: {exc}",
        }
    return {
        "ok": "true",
        "path": resolved,
        "kind": kind,
        **details,
    }


# Phase 1 surface: read-only office tools. Phase 2 will introduce
# OFFICE_WRITE_TOOLS for find_replace / set_cells / add_slide etc., gated
# via HITL permission.
OFFICE_READ_TOOLS = [office_read, office_outline]
