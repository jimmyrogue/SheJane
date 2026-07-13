"""PyInstaller entry point for the frozen local-agent daemon.

Dev runs `python -m local_host`, whose main() does
`uvicorn.run("local_host.server:app", ...)` — a STRING import. That string form
does NOT work inside a PyInstaller bundle (uvicorn can't resolve the module path
in a frozen app → "Could not import module local_host.server"). So the frozen
entry imports the app OBJECT directly and hands it to uvicorn — same runtime
behavior, but PyInstaller sees the import and uvicorn skips the string lookup.
We do not use uvicorn reload in production, which is the only thing passing the
object (instead of the string) gives up.
"""

from __future__ import annotations

import uvicorn

from local_host.config import get_settings
from local_host.observability import configure_logging
from local_host.server import app


def main() -> int:
    configure_logging()
    settings = get_settings()
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info", access_log=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
