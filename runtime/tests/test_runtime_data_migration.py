from pathlib import Path

from shejane_runtime import config
from shejane_runtime.config import Settings


def test_default_data_directory_moves_to_runtime_name(monkeypatch, tmp_path: Path) -> None:
    old_dir = tmp_path / "local-host"
    new_dir = tmp_path / "runtime"
    old_dir.mkdir()
    (old_dir / "agent.db").write_text("checkpoint")
    (old_dir / "local-host.db").write_text("runtime state")

    monkeypatch.setattr(config, "LEGACY_RUNTIME_DATA_DIR", old_dir)
    monkeypatch.setattr(config, "DEFAULT_RUNTIME_DATA_DIR", new_dir)
    settings = Settings(data_dir=new_dir)

    assert settings.ensure_data_dir() == new_dir
    assert (new_dir / "agent.db").read_text() == "checkpoint"
    assert settings.runtime_db_path.read_text() == "runtime state"
    assert not old_dir.exists()
    assert not (new_dir / "local-host.db").exists()


def test_custom_data_directory_only_migrates_runtime_database(tmp_path: Path) -> None:
    data_dir = tmp_path / "custom"
    data_dir.mkdir()
    (data_dir / "local-host.db").write_text("runtime state")
    settings = Settings(data_dir=data_dir)

    settings.ensure_data_dir()

    assert settings.runtime_db_path.read_text() == "runtime state"
    assert not (data_dir / "local-host.db").exists()


def test_existing_runtime_database_wins_without_overwrite(tmp_path: Path) -> None:
    data_dir = tmp_path / "custom"
    data_dir.mkdir()
    (data_dir / "local-host.db").write_text("legacy")
    (data_dir / "runtime.db").write_text("current")
    settings = Settings(data_dir=data_dir)

    settings.ensure_data_dir()

    assert settings.runtime_db_path.read_text() == "current"
    assert (data_dir / "local-host.db").read_text() == "legacy"
