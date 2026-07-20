#!/usr/bin/env python3
"""One-shot PDF Managed Worker using an exact MuPDF Runtime Asset."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path, PurePosixPath
from typing import Any

ASSET_ID = "org.mupdf.runtime"


class PdfActionError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def send(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def response(request_id: int, result: Any) -> None:
    send({"jsonrpc": "2.0", "id": request_id, "result": result})


class Progress:
    def __init__(self, invocation: dict[str, Any]) -> None:
        self.invocation = invocation
        self.sequence = 0

    def emit(
        self,
        phase: str,
        message: str,
        *,
        completed: int | None = None,
        total: int | None = None,
        unit: str | None = None,
    ) -> None:
        self.sequence += 1
        params: dict[str, Any] = {
            "schema_version": 1,
            "invocation_id": self.invocation["invocation_id"],
            "operation_id": self.invocation["operation_id"],
            "sequence": self.sequence,
            "phase": phase,
            "message": message,
        }
        if completed is not None:
            params["completed"] = completed
        if total is not None:
            params["total"] = total
        if unit is not None:
            params["unit"] = unit
        send({"jsonrpc": "2.0", "method": "notifications/progress", "params": params})


def contained_file(root: Path, virtual_path: str) -> Path:
    try:
        relative = PurePosixPath(virtual_path).relative_to("/input")
    except ValueError as exc:
        raise PdfActionError("invalid_input", "PDF input path is invalid") from exc
    if not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        raise PdfActionError("invalid_input", "PDF input path is invalid")
    candidate = root.joinpath(*relative.parts)
    if candidate.is_symlink() or not candidate.is_file():
        raise PdfActionError("invalid_input", "PDF input is unavailable")
    try:
        candidate.resolve(strict=True).relative_to(root.resolve(strict=True))
    except (OSError, ValueError) as exc:
        raise PdfActionError("invalid_input", "PDF input is unavailable") from exc
    return candidate


def selected_input(invocation: dict[str, Any]) -> Path:
    input_id = invocation["arguments"]["input_id"]
    reference = next(item for item in invocation["inputs"] if item["id"] == input_id)
    if reference["media_type"] != "application/pdf":
        raise PdfActionError("invalid_input", "selected input is not a PDF")
    return contained_file(Path(os.environ["SHEJANE_PLUGIN_INPUT_ROOT"]), str(reference["path"]))


def output_file(relative: str) -> Path:
    root = Path(os.environ["SHEJANE_PLUGIN_OUTPUT_ROOT"]).resolve(strict=True)
    destination = root / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.parent.resolve(strict=True).relative_to(root)
    return destination


def mutool() -> Path:
    try:
        assets = json.loads(os.environ["SHEJANE_PLUGIN_RUNTIME_ASSETS"])
        payload = Path(assets[ASSET_ID]).resolve(strict=True)
    except (KeyError, OSError, ValueError, json.JSONDecodeError) as exc:
        raise PdfActionError("runtime_unavailable", "MuPDF Runtime Asset is unavailable") from exc
    executable = payload / "bin" / ("mutool.exe" if os.name == "nt" else "mutool")
    if executable.is_symlink() or not executable.is_file():
        raise PdfActionError("runtime_unavailable", "mutool is unavailable")
    executable.resolve(strict=True).relative_to(payload)
    return executable


def engine_environment() -> dict[str, str]:
    output_root = Path(os.environ["SHEJANE_PLUGIN_OUTPUT_ROOT"]).resolve(strict=True)
    temporary = output_root / ".runtime-tmp"
    temporary.mkdir(mode=0o700, exist_ok=True)
    allowed = {
        key: value
        for key, value in os.environ.items()
        if key in {"PATH", "SystemRoot", "WINDIR"}
    }
    return allowed | {
        "HOME": str(temporary),
        "TMPDIR": str(temporary),
        "TMP": str(temporary),
        "TEMP": str(temporary),
        "LC_ALL": "C",
        "LANG": "C",
        "TZ": "UTC",
    }


def run_engine(
    command: list[str], *, stdout_limit: int = 4 * 1024 * 1024, stderr_limit: int = 64 * 1024
) -> subprocess.CompletedProcess[str]:
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=engine_environment(),
    )
    assert process.stdout is not None and process.stderr is not None
    chunks: dict[str, list[bytes]] = {"stdout": [], "stderr": []}
    overflow: list[str] = []

    def read_bounded(name: str, stream: Any, limit: int) -> None:
        size = 0
        while data := stream.read(64 * 1024):
            size += len(data)
            if size > limit:
                overflow.append(name)
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                return
            chunks[name].append(data)

    threads = [
        threading.Thread(target=read_bounded, args=("stdout", process.stdout, stdout_limit)),
        threading.Thread(target=read_bounded, args=("stderr", process.stderr, stderr_limit)),
    ]
    for thread in threads:
        thread.start()
    returncode = process.wait()
    for thread in threads:
        thread.join()
    if overflow:
        raise PdfActionError("resource_exhausted", f"MuPDF {overflow[0]} exceeded its limit")
    return subprocess.CompletedProcess(
        command,
        returncode,
        b"".join(chunks["stdout"]).decode("utf-8", errors="replace"),
        b"".join(chunks["stderr"]).decode("utf-8", errors="replace"),
    )


def inspect_source(source: Path) -> tuple[int | None, bool]:
    completed = run_engine([str(mutool()), "info", str(source)])
    if completed.returncode != 0:
        error = completed.stderr.casefold()
        if "password" in error or "authenticate" in error or "encrypted" in error:
            return None, True
        raise PdfActionError("invalid_pdf", "MuPDF could not inspect this PDF")
    match = re.search(r"(?:Pages|pages)\s*:\s*(\d+)", completed.stdout)
    if match is None:
        raise PdfActionError("invalid_pdf", "PDF page count is unavailable")
    page_count = int(match.group(1))
    if not 1 <= page_count <= 100_000:
        raise PdfActionError("resource_exhausted", "PDF page count exceeds the supported limit")
    return page_count, False


def inspect(
    invocation: dict[str, Any], progress: Progress
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    source = selected_input(invocation)
    progress.emit("inspect", "Inspecting PDF")
    page_count, encrypted = inspect_source(source)
    progress.emit("inspect", "PDF metadata ready", completed=1, total=1, unit="files")
    return {"page_count": page_count, "encrypted": encrypted}, []


def extract_text(
    invocation: dict[str, Any], progress: Progress
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    source = selected_input(invocation)
    arguments = invocation["arguments"]
    start_page = int(arguments["start_page"])
    requested_pages = int(arguments["page_count"])
    max_characters = int(arguments["max_characters"])
    page_count, encrypted = inspect_source(source)
    if encrypted:
        raise PdfActionError("encrypted_pdf", "encrypted PDFs are not supported in v1")
    assert page_count is not None
    end_page = start_page + requested_pages - 1
    if start_page < 1 or end_page > page_count:
        raise PdfActionError("invalid_page_range", "requested PDF page window is out of range")

    pages: list[dict[str, Any]] = []
    ocr_required_pages: list[int] = []
    remaining = max_characters
    for offset, page_number in enumerate(range(start_page, end_page + 1), start=1):
        progress.emit(
            "extract.text",
            f"Extracting page {page_number}",
            completed=offset - 1,
            total=requested_pages,
            unit="pages",
        )
        completed = run_engine(
            [str(mutool()), "draw", "-q", "-F", "txt", "-o", "-", str(source), str(page_number)],
            stdout_limit=min(4 * 1024 * 1024, max_characters * 4 + 1024),
        )
        if completed.returncode != 0:
            raise PdfActionError("text_extraction_failed", f"page {page_number} text extraction failed")
        original = completed.stdout.replace("\x00", "").replace("\r\n", "\n").strip()
        if not original:
            ocr_required_pages.append(page_number)
        text = original[:remaining]
        truncated = len(original) > len(text)
        remaining -= len(text)
        pages.append({"page_number": page_number, "text": text, "truncated": truncated})

    artifacts: list[dict[str, str]] = []
    artifact_name: str | None = None
    if bool(arguments["include_artifact"]):
        artifact_name = f"pages-{start_page:04d}-{end_page:04d}.txt"
        body = "\n\n".join(
            f"--- Page {page['page_number']} ---\n{page['text']}" for page in pages
        )
        output_file(artifact_name).write_text(body + "\n", encoding="utf-8")
        artifacts.append(
            {"path": f"/output/{artifact_name}", "media_type": "text/plain", "name": artifact_name}
        )
    progress.emit(
        "extract.text",
        "PDF text ready",
        completed=requested_pages,
        total=requested_pages,
        unit="pages",
    )
    return (
        {
            "page_count": page_count,
            "pages": pages,
            "ocr_required_pages": ocr_required_pages,
            "artifact_name": artifact_name,
        },
        artifacts,
    )


def render_pages(
    invocation: dict[str, Any], progress: Progress
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    source = selected_input(invocation)
    arguments = invocation["arguments"]
    pages = [int(value) for value in arguments["pages"]]
    dpi = int(arguments["dpi"])
    page_count, encrypted = inspect_source(source)
    if encrypted:
        raise PdfActionError("encrypted_pdf", "encrypted PDFs are not supported in v1")
    assert page_count is not None
    if any(page < 1 or page > page_count for page in pages):
        raise PdfActionError("invalid_page_range", "requested PDF page is out of range")

    rendered: list[dict[str, Any]] = []
    artifacts: list[dict[str, str]] = []
    for index, page_number in enumerate(pages, start=1):
        name = f"page-{page_number:04d}.png"
        destination = output_file(f"pages/{name}")
        progress.emit(
            "render.pages",
            f"Rendering page {page_number}",
            completed=index - 1,
            total=len(pages),
            unit="pages",
        )
        completed = run_engine(
            [
                str(mutool()),
                "draw",
                "-q",
                "-F",
                "png",
                "-r",
                str(dpi),
                "-o",
                str(destination),
                str(source),
                str(page_number),
            ],
            stdout_limit=64 * 1024,
        )
        signature = b""
        if destination.is_file():
            with destination.open("rb") as stream:
                signature = stream.read(8)
        if completed.returncode != 0 or signature != b"\x89PNG\r\n\x1a\n":
            raise PdfActionError("render_failed", f"page {page_number} rendering failed")
        rendered.append({"page_number": page_number, "artifact_name": name})
        artifacts.append(
            {"path": f"/output/pages/{name}", "media_type": "image/png", "name": name}
        )
    progress.emit(
        "render.pages",
        "PDF pages ready",
        completed=len(pages),
        total=len(pages),
        unit="pages",
    )
    return {"page_count": page_count, "dpi": dpi, "pages": rendered}, artifacts


ACTIONS = {
    "pdf.inspect": inspect,
    "pdf.extract_text": extract_text,
    "pdf.render_pages": render_pages,
}


def fail_result(invocation: dict[str, Any], code: str, message: str) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "invocation_id": invocation["invocation_id"],
        "operation_id": invocation["operation_id"],
        "status": "failed",
        "artifacts": [],
        "error": {"code": code, "message": message, "retryable": False},
    }


def invoke(invocation: dict[str, Any]) -> dict[str, Any]:
    output_root = Path(os.environ["SHEJANE_PLUGIN_OUTPUT_ROOT"])
    try:
        action_id = str(invocation["action"]["action_id"])
        output, artifacts = ACTIONS[action_id](invocation, Progress(invocation))
        return {
            "schema_version": 1,
            "invocation_id": invocation["invocation_id"],
            "operation_id": invocation["operation_id"],
            "status": "succeeded",
            "output": output,
            "artifacts": artifacts,
        }
    except PdfActionError as exc:
        return fail_result(invocation, exc.code, str(exc)[:500])
    except (KeyError, StopIteration, TypeError, ValueError, OSError):
        return fail_result(invocation, "pdf_processing_failed", "PDF processing failed")
    finally:
        shutil.rmtree(output_root / ".runtime-tmp", ignore_errors=True)


def main() -> None:
    initialize = json.loads(sys.stdin.readline())
    response(
        initialize["id"],
        {
            "protocol_version": 1,
            "process_isolated": True,
            "access_isolated": os.environ.get("SHEJANE_PLUGIN_ACCESS_ISOLATED") == "1",
            "resource_isolated": os.environ.get("SHEJANE_PLUGIN_RESOURCE_ISOLATED") == "1",
            "sandboxed": os.environ.get("SHEJANE_PLUGIN_SANDBOXED") == "1",
        },
    )
    request = json.loads(sys.stdin.readline())
    response(request["id"], invoke(request["params"]))
    shutdown = json.loads(sys.stdin.readline())
    response(shutdown["id"], {})


if __name__ == "__main__":
    main()
