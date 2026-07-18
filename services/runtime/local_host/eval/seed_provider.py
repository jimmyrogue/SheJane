"""Seed one configured BYOK provider into an isolated real-E2E Runtime."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

from local_host.store.sqlite import SCHEMA


def seed_provider(source_dir: Path, destination_dir: Path, model_spec: str) -> None:
    parts = model_spec.split(":", 2)
    if len(parts) != 3 or parts[0] != "local" or not parts[1] or not parts[2]:
        raise ValueError("model must be local:<provider>:<model>")
    provider_id, model_id = parts[1], parts[2]
    source_path = source_dir / "local-host.db"
    if not source_path.is_file():
        raise ValueError(f"configured Runtime database not found: {source_path}")

    with sqlite3.connect(source_path) as source:
        source.row_factory = sqlite3.Row
        row = source.execute(
            "SELECT * FROM local_model_providers "
            "WHERE principal_id = 'local:owner' AND id = ? AND enabled = 1",
            (provider_id,),
        ).fetchone()
    if row is None:
        raise ValueError(f"enabled provider not found: {provider_id}")
    models = json.loads(str(row["models_json"]))
    if not any(str(item.get("model_id")) == model_id for item in models):
        raise ValueError(f"enabled model not found: {model_spec}")

    destination_dir.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(destination_dir / "local-host.db") as destination:
        destination.executescript(SCHEMA)
        destination.execute(
            "INSERT INTO local_model_providers "
            "(principal_id, id, name, kind, base_url, requires_api_key, credential_ref, "
            "models_json, enabled, version, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            tuple(row),
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--destination-dir", type=Path, required=True)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    try:
        seed_provider(args.source_dir, args.destination_dir, args.model)
    except (ValueError, sqlite3.Error, json.JSONDecodeError) as exc:
        parser.error(str(exc))
    print(f"seeded isolated provider for {args.model}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
