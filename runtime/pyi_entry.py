"""PyInstaller entry point for the frozen Runtime."""

from __future__ import annotations

from shejane_runtime.__main__ import main

if __name__ == "__main__":
    raise SystemExit(main())
