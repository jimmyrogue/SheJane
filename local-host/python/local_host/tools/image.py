"""Image generation / editing tools.

Calls OpenAI's `images.generate` / `images.edit` endpoints directly (the
LangChain `OpenAIDALLEImageGenerationTool` is locked to DALL-E; we want
`gpt-image-1` which is the current production model).

Both tools return base64-encoded PNG by default; the agent receives a small
ack envelope with the artifact reference rather than the binary itself so
context tokens stay bounded.
"""

from __future__ import annotations

import base64
import logging
import os
from pathlib import Path
from typing import Any

from langchain_core.tools import tool

log = logging.getLogger("local_host.tools.image")


def _openai_client():
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return None
    try:
        from openai import AsyncOpenAI
    except ImportError:
        log.warning("openai sdk not installed; image tools disabled")
        return None
    return AsyncOpenAI(api_key=api_key)


@tool("image.generate")
async def image_generate(
    prompt: str,
    size: str = "1024x1024",
    n: int = 1,
    model: str = "gpt-image-1",
) -> dict[str, Any]:
    """Generate an image from a text prompt.

    Args:
        prompt: Text describing the image to create.
        size: One of "1024x1024", "1792x1024", "1024x1792" (model dependent).
        n: Number of images. Most providers cap this at 4.
        model: Image model name. Default `gpt-image-1`.

    Returns: dict with base64-encoded PNG bytes (truncated info for context
    safety; full bytes saved to the daemon's data dir).
    """
    client = _openai_client()
    if client is None:
        return {"ok": "false", "error": "OPENAI_API_KEY not set"}

    try:
        resp = await client.images.generate(
            model=model,
            prompt=prompt,
            size=size,
            n=max(1, min(n, 4)),
        )
    except Exception as exc:  # noqa: BLE001
        return {"ok": "false", "error": f"{type(exc).__name__}: {exc}"}

    images = []
    for i, datum in enumerate(resp.data or []):
        if not datum.b64_json:
            continue
        path = _persist_image(datum.b64_json, prefix=f"gen-{i}")
        images.append({"index": i, "path": str(path), "bytes": len(datum.b64_json)})

    return {"ok": "true", "images": images, "model": model}


@tool("image.edit")
async def image_edit(
    image_path: str,
    prompt: str,
    mask_path: str = "",
    size: str = "1024x1024",
    model: str = "gpt-image-1",
) -> dict[str, Any]:
    """Edit an existing image according to a prompt.

    Args:
        image_path: Path to the source image (must exist on disk).
        prompt: Description of the desired edit.
        mask_path: Optional path to a transparency mask (PNG with alpha).
        size: Output size.
        model: Edit-capable model. Default `gpt-image-1`.
    """
    if not Path(image_path).exists():
        return {"ok": "false", "error": f"image not found: {image_path}"}
    if mask_path and not Path(mask_path).exists():
        return {"ok": "false", "error": f"mask not found: {mask_path}"}

    client = _openai_client()
    if client is None:
        return {"ok": "false", "error": "OPENAI_API_KEY not set"}

    kwargs: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "size": size,
        "image": open(image_path, "rb"),  # noqa: SIM115 — closed by SDK
    }
    if mask_path:
        kwargs["mask"] = open(mask_path, "rb")  # noqa: SIM115

    try:
        resp = await client.images.edit(**kwargs)
    except Exception as exc:  # noqa: BLE001
        return {"ok": "false", "error": f"{type(exc).__name__}: {exc}"}

    images = []
    for i, datum in enumerate(resp.data or []):
        if not datum.b64_json:
            continue
        path = _persist_image(datum.b64_json, prefix=f"edit-{i}")
        images.append({"index": i, "path": str(path), "bytes": len(datum.b64_json)})

    return {"ok": "true", "images": images, "model": model}


def _persist_image(b64: str, *, prefix: str) -> Path:
    """Decode base64 PNG to a temp-ish path inside the daemon data dir."""
    from ..config import get_settings

    data_dir = get_settings().ensure_data_dir() / "images"
    data_dir.mkdir(parents=True, exist_ok=True)
    import uuid

    path = data_dir / f"{prefix}-{uuid.uuid4().hex[:8]}.png"
    path.write_bytes(base64.b64decode(b64))
    return path


IMAGE_TOOLS = [image_generate, image_edit]
