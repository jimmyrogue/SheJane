"""Image generation / editing tools.

**Architecture**: image generation is a **platform-paid** capability — the
OpenAI key lives only on the cloud API and the daemon proxies through
`POST /api/v1/agent/tools/execute`. The same idempotency-keyed billing
ledger that backs `web.search` covers image bills. NO `OPENAI_API_KEY`
should ever exist in the daemon's environment; if you see one there, the
.env is misconfigured (it must live in the Go API's section E).

Why proxy:
  • the user has already paid for credits — the API debits them per
    image AFTER it succeeds, with reserve/settle for crash safety;
  • the OpenAI key would otherwise have to be in every user's local-host
    env, which leaks platform billing across users;
  • the API's `runImageGeneration` handles model selection, size
    validation, and S3 persistence — we'd be duplicating all of that
    here.

The tool's return shape mirrors `agentToolExecuteResult` from the API
(`tool_gateway.go:37`): `{ok, content, data?, errorCode?, recoverable?}`.
The LLM consumes `content` (a human-readable summary including URLs to
the saved images) and optionally inspects `data` for structured fields.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

import httpx  # re-exported so tests can monkeypatch via image_module.httpx
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import InjectedToolCallId, tool

from ._gateway import call_tool_gateway, run_id_from_config

log = logging.getLogger("local_host.tools.image")

# Re-export for tests that already monkeypatch `image_module.httpx.AsyncClient`.
_ = httpx


async def _invoke_image_tool(
    tool_name: str,
    arguments: dict[str, Any],
    *,
    run_id: str,
    tool_call_id: str,
) -> dict[str, Any]:
    """Test-friendly wrapper around the shared gateway helper.

    Kept distinct from `call_tool_gateway` only so tests can target a
    stable signature (`run_id` + `tool_call_id` as plain args) without
    having to construct a RunnableConfig.
    """
    return await call_tool_gateway(
        tool_name,
        arguments,
        run_id=run_id,
        tool_call_id=tool_call_id,
    )


@tool("image.generate")
async def image_generate(
    prompt: str,
    size: str = "1024x1024",
    n: int = 1,
    tool_call_id: Annotated[str, InjectedToolCallId] = "",
    config: RunnableConfig | None = None,
) -> dict[str, Any]:
    """Generate an image from a text prompt.

    Routes through the cloud Tool Gateway (`/api/v1/agent/tools/execute`).
    The user's credits cover the per-image fee; the API streams the
    base64 image to S3 and returns a URL the model can quote back to
    the user.

    Args:
        prompt: Text describing the image to create.
        size: One of "1024x1024", "1792x1024", "1024x1792"
              (model-dependent — the cloud API validates).
        n: Number of images. Cloud API clamps to [1, 4].

    Returns: `{ok, content, data?, errorCode?, recoverable?}` matching
    `agentToolExecuteResult`. On success `content` is a human-readable
    summary the agent quotes; `data.images` (when present) carries
    structured image references.
    """
    return await _invoke_image_tool(
        "image.generate",
        {"prompt": prompt, "size": size, "n": max(1, min(int(n), 4))},
        run_id=run_id_from_config(config),
        tool_call_id=tool_call_id,
    )


@tool("image.edit")
async def image_edit(
    prompt: str,
    image_url: str = "",
    mask_url: str = "",
    document_id: str = "",
    mask_document_id: str = "",
    size: str = "1024x1024",
    n: int = 1,
    tool_call_id: Annotated[str, InjectedToolCallId] = "",
    config: RunnableConfig | None = None,
) -> dict[str, Any]:
    """Edit an existing image according to a prompt.

    The cloud API accepts either a publicly-fetchable `image_url` OR a
    `document_id` referencing an artifact the user uploaded to the
    documents service. At least one is required. Same for the mask.

    Args:
        prompt: Description of the desired edit.
        image_url: HTTPS URL of the source image (cloud fetches it).
        mask_url: Optional HTTPS URL of a transparency mask PNG.
        document_id: Alternative to image_url — references an uploaded
                     document by id (preferred for user-uploaded files).
        mask_document_id: Same, for the mask.
        size: Output size.
        n: Number of variants. Cloud API clamps to [1, 4].
    """
    return await _invoke_image_tool(
        "image.edit",
        {
            "prompt": prompt,
            "image_url": image_url,
            "mask_url": mask_url,
            "document_id": document_id,
            "mask_document_id": mask_document_id,
            "size": size,
            "n": max(1, min(int(n), 4)),
        },
        run_id=run_id_from_config(config),
        tool_call_id=tool_call_id,
    )


IMAGE_TOOLS = [image_generate, image_edit]
