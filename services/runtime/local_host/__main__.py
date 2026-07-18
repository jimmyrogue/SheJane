"""CLI entry point for the standalone SheJane Runtime."""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from pathlib import Path

import uvicorn

from .config import get_settings
from .observability import configure_logging
from .plugins.macos_vm import load_macos_vm_resources
from .server import create_app


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="shejane-runtime")
    parser.add_argument("--host", help="loopback listener address")
    parser.add_argument("--port", type=int, help="loopback listener port")
    parser.add_argument("--token", help="Desktop pairing token")
    parser.add_argument("--data-dir", type=Path, help="Runtime data directory")
    parser.add_argument(
        "--managed-worker-vm-assets",
        type=Path,
        help="bundled macOS Managed Worker VM asset manifest",
    )
    parser.add_argument(
        "--managed-worker-linux-assets",
        type=Path,
        help="bundled Linux Managed Worker asset manifest",
    )
    parser.add_argument(
        "--validate-managed-worker-vm-assets",
        action="store_true",
        help="validate the bundled macOS VM asset set and exit",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    configure_logging()
    settings = get_settings()
    args = _parse_args(argv)
    overrides = {
        key: value
        for key, value in {
            "host": args.host,
            "port": args.port,
            "pairing_token": args.token,
            "data_dir": args.data_dir,
            "managed_worker_vm_assets": args.managed_worker_vm_assets,
            "managed_worker_linux_assets": args.managed_worker_linux_assets,
        }.items()
        if value is not None
    }
    if overrides:
        settings = settings.model_copy(update=overrides)
        settings = type(settings).model_validate(settings.model_dump())
    if args.validate_managed_worker_vm_assets:
        if settings.managed_worker_vm_assets is None:
            raise SystemExit("--managed-worker-vm-assets is required for validation")
        load_macos_vm_resources(settings.managed_worker_vm_assets)
        return 0
    uvicorn.run(
        create_app(settings),
        host=settings.host,
        port=settings.port,
        log_level="info",
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
