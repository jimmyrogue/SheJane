"""PyInstaller entry point for the frozen Runtime."""

from __future__ import annotations

from local_host.__main__ import main

if __name__ == "__main__":
    raise SystemExit(main())
