"""Trusted protocol fixture; not a production Office renderer or sandbox."""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path, PurePosixPath

from docx import Document

PLUGIN_ID = "dev.shejane.fixture.documents"
ACTION_ID = "document.render"


def _reply(request_id: int, result: object) -> None:
    print(
        json.dumps(
            {"jsonrpc": "2.0", "id": request_id, "result": result},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        flush=True,
    )


def _request(expected_method: str) -> dict[str, object]:
    payload = json.loads(sys.stdin.readline())
    if payload.get("jsonrpc") != "2.0" or payload.get("method") != expected_method:
        raise ValueError(f"expected {expected_method}")
    return payload


def _materialized_input(reference: dict[str, object]) -> Path:
    virtual = PurePosixPath(str(reference["path"]))
    relative = virtual.relative_to("/input")
    if not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        raise ValueError("unsafe input path")
    root = Path(os.environ["SHEJANE_PLUGIN_INPUT_ROOT"]).resolve(strict=True)
    source = root.joinpath(*relative.parts).resolve(strict=True)
    source.relative_to(root)
    data = source.read_bytes()
    if len(data) != reference["size_bytes"]:
        raise ValueError("input size mismatch")
    if hashlib.sha256(data).hexdigest() != reference["sha256"]:
        raise ValueError("input digest mismatch")
    return source


def _minimal_pdf(text: str) -> bytes:
    safe = text.encode("latin-1", errors="replace").decode("latin-1")
    safe = safe.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = f"BT /F1 12 Tf 72 720 Td ({safe[:2000]}) Tj ET".encode("latin-1")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    document = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(document))
        document.extend(f"{index} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(document)
    document.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    document.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        document.extend(f"{offset:010d} 00000 n \n".encode())
    document.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(document)


def _invoke(invocation: dict[str, object]) -> dict[str, object]:
    if invocation["action"]["plugin_id"] != PLUGIN_ID:  # type: ignore[index]
        raise ValueError("wrong plugin")
    if invocation["action"]["action_id"] != ACTION_ID:  # type: ignore[index]
        raise ValueError("wrong action")
    input_id = invocation["arguments"]["input_id"]  # type: ignore[index]
    reference = next(item for item in invocation["inputs"] if item["id"] == input_id)  # type: ignore[index,union-attr]
    source = _materialized_input(reference)
    text = " ".join(paragraph.text for paragraph in Document(source).paragraphs).strip()
    output_root = Path(os.environ["SHEJANE_PLUGIN_OUTPUT_ROOT"]).resolve(strict=True)
    (output_root / "document.pdf").write_bytes(_minimal_pdf(text or "Empty document"))
    return {
        "schema_version": 1,
        "invocation_id": invocation["invocation_id"],
        "operation_id": invocation["operation_id"],
        "status": "succeeded",
        "output": {"page_count": 1},
        "artifacts": [
            {
                "path": "/output/document.pdf",
                "media_type": "application/pdf",
                "name": "document.pdf",
            }
        ],
    }


def main() -> None:
    initialize = _request("initialize")
    params = initialize["params"]
    if params["protocol_version"] != 1 or params["plugin_id"] != PLUGIN_ID:  # type: ignore[index]
        raise ValueError("incompatible host")
    _reply(
        int(initialize["id"]),
        {
            "protocol_version": 1,
            "process_isolated": True,
            "access_isolated": os.environ.get("SHEJANE_PLUGIN_ACCESS_ISOLATED") == "1",
            "resource_isolated": os.environ.get("SHEJANE_PLUGIN_RESOURCE_ISOLATED") == "1",
            "sandboxed": os.environ.get("SHEJANE_PLUGIN_SANDBOXED") == "1",
        },
    )
    invoke = _request("invoke")
    _reply(int(invoke["id"]), _invoke(invoke["params"]))  # type: ignore[arg-type]
    shutdown = _request("shutdown")
    _reply(int(shutdown["id"]), {})


if __name__ == "__main__":
    main()
