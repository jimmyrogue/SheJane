"""CLI entry point: `python -m local_host`."""

from __future__ import annotations

import uvicorn

from .config import get_settings
from .observability import configure_logging


def main() -> int:
    configure_logging()
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
