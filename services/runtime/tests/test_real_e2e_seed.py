from __future__ import annotations

import json
import sqlite3

import pytest

from local_host.eval.seed_provider import seed_provider
from local_host.store.sqlite import SCHEMA


def test_seed_provider_copies_only_the_selected_provider(tmp_path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    with sqlite3.connect(source / "local-host.db") as connection:
        connection.executescript(SCHEMA)
        connection.execute(
            "INSERT INTO local_model_providers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "local:owner",
                "provider",
                "Provider",
                "openai_compatible",
                "https://example.test/v1",
                1,
                "keyring:model-provider:provider:test",
                json.dumps([{"model_id": "model", "tool_calling": True, "streaming": True}]),
                1,
                3,
                "2026-01-01T00:00:00Z",
                "2026-01-01T00:00:00Z",
            ),
        )
        connection.execute(
            "INSERT INTO local_runs "
            "(id, graph_thread_id, goal, status, created_at, updated_at) "
            "VALUES ('private-run', 'thread', 'private', 'completed', 'now', 'now')"
        )

    seed_provider(source, destination, "local:provider:model")

    with sqlite3.connect(destination / "local-host.db") as connection:
        assert connection.execute("SELECT id FROM local_model_providers").fetchall() == [
            ("provider",)
        ]
        assert connection.execute("SELECT id FROM local_runs").fetchall() == []


def test_seed_provider_rejects_an_unconfigured_model(tmp_path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    with sqlite3.connect(source / "local-host.db") as connection:
        connection.executescript(SCHEMA)

    with pytest.raises(ValueError, match="enabled provider not found"):
        seed_provider(source, tmp_path / "destination", "local:missing:model")
