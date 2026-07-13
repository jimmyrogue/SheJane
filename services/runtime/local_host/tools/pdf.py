"""pdf.inspect — agent-side helper for ad-hoc PDF operations.

This is a thin proxy to the cloud Tool Gateway. The actual Poppler
subprocesses (pdfinfo, pdfgrep) run inside the Go API container
where poppler-utils is installed and the user's PDFs already live
in S3. The daemon doesn't touch the bytes — it just hands the
gateway a `document_id` + operation name.

Layered design
==============

We don't need pdf.inspect for the common path — Layer A (the
documents service) already runs `pdfinfo` + `pdftotext` at upload
time and persists:

  • full extracted text (queryable via the existing documents.ask
    flow);
  • pdfinfo metadata (page count, author, title, encrypted flag,
    …) as `Document.metadata`.

pdf.inspect exists for the operations Layer A doesn't cover:

  • `search`: ad-hoc pdfgrep with page-number context. The text dump
    alone tells you WHAT was said; pdfgrep tells you WHERE.
  • `info`: re-runs pdfinfo on demand. Mostly redundant with
    Document.metadata but useful when the agent is reasoning
    purely from a document_id and doesn't have the row already.

Deferred (each adds meaningful surface area to the client too):

  • `rasterize_page`: pdftoppm → PNG. Needs a client-side render
    path beyond the code.execute inline-image flow.
  • `extract_images`: pdfimages. Same rendering concern.

Both can be added without changing the agent-facing tool signature
(`operation` is a string; just add new branches).
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from langchain_core.runnables import RunnableConfig
from langchain_core.runnables.config import ensure_config
from langchain_core.tools import InjectedToolCallId, tool

from ._gateway import call_tool_gateway, run_id_from_config

log = logging.getLogger("local_host.tools.pdf")


async def _pdf_inspect_impl(
    *,
    document_id: str,
    operation: str,
    query: str | None,
    tool_call_id: str,
    run_id: str,
) -> dict[str, Any]:
    """Test-friendly inner implementation. The @tool wrapper below
    handles RunnableConfig + InjectedToolCallId; this function only
    sees the resolved primitives so tests can exercise validation
    branches without constructing a full ToolCall envelope.
    """
    if not run_id:
        return {
            "ok": False,
            "content": (
                "pdf.inspect requires a conversation context. This usually "
                "means the tool was called outside an active agent run."
            ),
            "errorCode": "no_conversation_context",
            "recoverable": False,
        }
    document_id = (document_id or "").strip()
    if not document_id:
        return {
            "ok": False,
            "content": "pdf.inspect requires a document_id (the cloud id of an uploaded PDF).",
            "errorCode": "missing_document_id",
            "recoverable": True,
        }
    op = (operation or "info").strip().lower()
    if op not in ("info", "search"):
        return {
            "ok": False,
            "content": f"pdf.inspect: unknown operation {op!r}. Supported: info, search.",
            "errorCode": "unknown_operation",
            "recoverable": True,
        }
    arguments: dict[str, Any] = {
        "document_id": document_id,
        "operation": op,
    }
    if op == "search":
        q = (query or "").strip()
        if not q:
            return {
                "ok": False,
                "content": "pdf.inspect operation='search' requires a non-empty query string.",
                "errorCode": "missing_query",
                "recoverable": True,
            }
        arguments["query"] = q
    return await call_tool_gateway(
        "pdf.inspect",
        arguments,
        run_id=run_id,
        tool_call_id=tool_call_id,
    )


@tool("pdf.inspect")
async def pdf_inspect(
    document_id: str,
    operation: str = "info",
    query: str | None = None,
    tool_call_id: Annotated[str, InjectedToolCallId] = "",
    config: RunnableConfig | None = None,
) -> dict[str, Any]:
    """Inspect a previously-uploaded PDF beyond what the extracted
    text already tells you.

    Use this when:
      • You need to FIND something inside the PDF and report which
        page(s) it appears on. (`operation="search"`, `query="..."`)
      • You need the structured metadata (page count, author, title,
        encrypted flag) for a document_id without an extra fetch.
        (`operation="info"`)

    Don't use it when the user just asked "what's in this PDF" — the
    existing extracted-text path already answers that for free.

    Args:
        document_id: The cloud document id (returned when the user
                     uploaded the file, also visible on the
                     attachment chip in chat history).
        operation:   "info" (default) or "search".
        query:       For operation="search", the exact substring to
                     find. Plain text, not regex. Required when
                     operation="search".

    Returns: `{ok, content, data?, errorCode?, recoverable?}` matching
    the `agentToolExecuteResult` envelope. On search success,
    `data.matches` is a list of `{page, snippet}` records (max 20).
    On info success, `data.metadata` mirrors the persisted pdfinfo
    output.
    """
    # LangChain's RunnableConfig injection is inconsistent across
    # agent code paths (same as code.execute); fall back to the
    # contextvar if the kwarg arrived None.
    if config is None:
        try:
            config = ensure_config()
        except Exception as exc:  # pragma: no cover — defensive
            log.warning("pdf.inspect: ensure_config() failed: %s", exc)
            config = {}
    run_id = run_id_from_config(config)
    return await _pdf_inspect_impl(
        document_id=document_id,
        operation=operation,
        query=query,
        tool_call_id=tool_call_id,
        run_id=run_id,
    )


PDF_TOOLS = [pdf_inspect]
