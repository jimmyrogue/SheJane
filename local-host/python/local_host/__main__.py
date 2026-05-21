"""CLI entry point: `python -m local_host`."""

from __future__ import annotations

import logging
import sys

import uvicorn

from .config import get_settings


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,
    )
    settings = get_settings()
    uvicorn.run(
        "local_host.server:app",
        host=settings.host,
        port=settings.port,
        log_level="info",
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
