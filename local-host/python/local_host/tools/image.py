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

import httpx
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import InjectedToolCallId, tool

log = logging.getLogger("local_host.tools.image")

_REQUEST_TIMEOUT_S = 120.0  # image generation can take up to ~60s; budget 2x.


async def _call_tool_gateway(
    tool_name: str,
    arguments: dict[str, Any],
    *,
    tool_call_id: str,
    config: RunnableConfig | None,
) -> dict[str, Any]:
    """POST to `${cloud_base_url}/api/v1/agent/tools/execute`.

    Returns the unwrapped `agentToolExecuteResult` shape (matching the
    Go handler at `tool_gateway.go:37`) so the LLM gets the same
    `{ok, content, data?}` envelope regardless of which gateway tool
    was invoked.
    """
    from ..config import get_settings

    settings = get_settings()
    cloud_base_url = settings.cloud_base_url.rstrip("/")
    cloud_token = settings.cloud_token
    if not cloud_token:
        return {
            "ok": False,
            "content": (
                f"{tool_name} requires a paired cloud session. Please log "
                "in to the Electron app first, then retry."
            ),
            "errorCode": "cloud_session_missing",
            "recoverable": True,
        }

    # The cloud API needs `run_id` for billing attribution (so the
    # credit ledger entry can be reconciled with the agent run on
    # error). LangGraph injects `thread_id` via the configurable dict;
    # we set thread_id = run_id in RunCoordinator.start_run.
    run_id = ""
    if config is not None:
        configurable = config.get("configurable") or {}
        run_id = str(configurable.get("thread_id") or "")

    body = {
        "run_id": run_id,
        "tool_call_id": tool_call_id,
        "tool": tool_name,
        "arguments": arguments,
        # Idempotency key — reuse the tool_call_id so retries from the
        # agent loop don't double-bill. The API stores results keyed by
        # this and returns the cached completion on duplicate calls.
        "idempotency_key": tool_call_id or run_id,
    }

    url = f"{cloud_base_url}/api/v1/agent/tools/execute"
    try:
        async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_S) as client:
            resp = await client.post(
                url,
                headers={
                    "Authorization": f"Bearer {cloud_token}",
                    "Content-Type": "application/json",
                },
                json=body,
            )
    except httpx.HTTPError as exc:
        log.warning("%s: gateway transport error: %s", tool_name, exc)
        return {
            "ok": False,
            "content": f"{tool_name} unreachable: {exc}",
            "errorCode": "gateway_unreachable",
            "recoverable": True,
        }

    try:
        envelope = resp.json()
    except ValueError:
        return {
            "ok": False,
            "content": f"{tool_name}: gateway returned non-JSON ({resp.status_code})",
            "errorCode": "gateway_bad_response",
            "recoverable": False,
        }

    # The Go handler wraps results in `apiResponse<T>` = {code, message, data}.
    # Most error paths still include `data: agentToolExecuteResult`, so
    # we prefer unwrapping `data` and fall back to the outer message.
    data = envelope.get("data") if isinstance(envelope, dict) else None
    if not isinstance(data, dict):
        return {
            "ok": False,
            "content": str(envelope.get("message") if isinstance(envelope, dict) else envelope)
                       or f"{tool_name}: gateway HTTP {resp.status_code}",
            "errorCode": "gateway_envelope_missing",
            "recoverable": False,
        }
    return data


async def _invoke_image_tool(
    tool_name: str,
    arguments: dict[str, Any],
    *,
    run_id: str,
    tool_call_id: str,
) -> dict[str, Any]:
    """Pure-function gateway call with explicit run_id / tool_call_id.

    Split out from the `@tool`-decorated entry points so unit tests can
    exercise the gateway logic without LangChain's ToolMessage-wrapping
    + RunnableConfig auto-injection getting in the way. The decorated
    versions below are thin shells that pull run_id from RunnableConfig
    and forward here.
    """
    return await _call_tool_gateway(
        tool_name,
        arguments,
        tool_call_id=tool_call_id,
        config={"configurable": {"thread_id": run_id}},
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
    run_id = _run_id_from_config(config)
    return await _invoke_image_tool(
        "image.generate",
        {"prompt": prompt, "size": size, "n": max(1, min(int(n), 4))},
        run_id=run_id,
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
    run_id = _run_id_from_config(config)
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
        run_id=run_id,
        tool_call_id=tool_call_id,
    )


def _run_id_from_config(config: RunnableConfig | None) -> str:
    """LangGraph sets `configurable.thread_id` = run_id. Default to ""
    if absent so tools degrade gracefully when called outside an agent
    (e.g. ad-hoc curl)."""
    if config is None:
        return ""
    configurable = config.get("configurable") or {}
    return str(configurable.get("thread_id") or "")


IMAGE_TOOLS = [image_generate, image_edit]
