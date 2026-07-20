from __future__ import annotations

import json
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from shejane_runtime.config import reset_settings_for_tests
from shejane_runtime.server import create_app
from tests.helpers import run_command

REPO_ROOT = Path(__file__).resolve().parents[2]
ARCHIVE_FIXTURE = REPO_ROOT / "runtime" / "plugins" / "fixtures" / "wasi-archive"
AUTH = {"Authorization": "Bearer tok"}


def _pack_fixture(
    source: Path,
    destination: Path,
    *,
    version: str = "0.1.0",
    with_command: bool = False,
) -> None:
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob("*")):
            if not path.is_file() or "target" in path.parts:
                continue
            relative = path.relative_to(source).as_posix()
            if relative == ".shejane-plugin/plugin.json":
                manifest = json.loads(path.read_text(encoding="utf-8"))
                manifest["version"] = version
                if with_command:
                    manifest["contributions"]["commands"] = [
                        {
                            "id": "extract",
                            "title": "Extract archive",
                            "description": "Extract the selected archive.",
                            "instructions": "README.md",
                            "required_actions": ["archive.extract"],
                        }
                    ]
                archive.writestr(relative, json.dumps(manifest))
            else:
                archive.write(path, relative)


def _install(
    client: TestClient,
    tmp_path: Path,
    *,
    version: str = "0.1.0",
    command_id: str = "cmd_install_plugin",
    with_command: bool = False,
) -> dict[str, object]:
    package = tmp_path / f"archive-{version}.shejane-plugin"
    _pack_fixture(ARCHIVE_FIXTURE, package, version=version, with_command=with_command)
    payload: dict[str, object] = {
        "type": "plugin.install" if version == "0.1.0" else "plugin.update",
        "command_id": command_id,
        "source_path": str(package),
        "allow_unsigned": True,
    }
    if version != "0.1.0":
        payload["plugin_id"] = "dev.shejane.fixture.archive"
    response = client.post(
        "/v1/commands",
        headers=AUTH,
        json=payload,
    )
    assert response.status_code == 200, response.text
    return response.json()


def _enable(client: TestClient, *, digest: str) -> None:
    response = client.post(
        "/v1/commands",
        headers=AUTH,
        json={
            "type": "plugin.enable",
            "command_id": "cmd_enable_plugin",
            "plugin_id": "dev.shejane.fixture.archive",
            "expected_digest": digest,
        },
    )
    assert response.status_code == 200, response.text


def _stream_to_terminal(client: TestClient, run_id: str) -> str:
    with client.stream(
        "GET",
        f"/v1/runs/{run_id}/stream",
        headers=AUTH,
    ) as response:
        assert response.status_code == 200
        return response.read().decode("utf-8")


def test_accept_run_freezes_enabled_plugin_digest_before_update(tmp_path: Path) -> None:
    settings = reset_settings_for_tests(
        SHEJANE_RUNTIME_TOKEN="tok",
        SHEJANE_FAKE_LLM=True,
        data_dir=tmp_path / "runtime",
    )
    with TestClient(create_app(settings)) as client:
        installed = _install(client, tmp_path)
        _enable(client, digest=str(installed["digest"]))

        accepted = client.post(
            "/v1/runs",
            headers=AUTH,
            json=run_command("use the enabled plugin"),
        )
        assert accepted.status_code == 200, accepted.text
        run_id = accepted.json()["id"]

        updated = _install(
            client,
            tmp_path,
            version="0.2.0",
            command_id="cmd_update_plugin",
        )
        bindings = client.portal.call(client.app.state.store.list_run_plugin_bindings, run_id)

        assert updated["digest"] != installed["digest"]
        assert bindings == [
            {
                "run_id": run_id,
                "plugin_id": "dev.shejane.fixture.archive",
                "version": "0.1.0",
                "digest": installed["digest"],
                "selection_source": "enabled",
                "required": False,
                "command_id": None,
                "action_catalog_hash": bindings[0]["action_catalog_hash"],
            }
        ]
        assert str(bindings[0]["action_catalog_hash"]).startswith("sha256:")


def test_explicit_reference_rejects_disabled_plugin_without_creating_run(
    tmp_path: Path,
) -> None:
    settings = reset_settings_for_tests(
        SHEJANE_RUNTIME_TOKEN="tok",
        data_dir=tmp_path / "runtime",
    )
    with TestClient(create_app(settings)) as client:
        _install(client, tmp_path)
        response = client.post(
            "/v1/runs",
            headers=AUTH,
            json=run_command(
                "use the selected plugin",
                plugin_refs=[
                    {
                        "plugin_id": "dev.shejane.fixture.archive",
                        "required": True,
                    }
                ],
            ),
        )

        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "plugin_disabled"
        assert client.get("/v1/runs", headers=AUTH).json()["runs"] == []


def test_plugin_command_rejects_unknown_command(tmp_path: Path) -> None:
    settings = reset_settings_for_tests(
        SHEJANE_RUNTIME_TOKEN="tok",
        data_dir=tmp_path / "runtime",
    )
    with TestClient(create_app(settings)) as client:
        installed = _install(client, tmp_path)
        _enable(client, digest=str(installed["digest"]))
        response = client.post(
            "/v1/runs",
            headers=AUTH,
            json=run_command(
                "run a plugin command",
                plugin_command={
                    "plugin_id": "dev.shejane.fixture.archive",
                    "command_id": "missing.command",
                },
            ),
        )

        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "plugin_command_not_found"


def test_runtime_persists_canonical_plugin_selection_on_user_message(tmp_path: Path) -> None:
    settings = reset_settings_for_tests(
        SHEJANE_RUNTIME_TOKEN="tok",
        SHEJANE_FAKE_LLM=True,
        data_dir=tmp_path / "runtime",
    )
    with TestClient(create_app(settings)) as client:
        installed = _install(client, tmp_path, with_command=True)
        digest = str(installed["digest"])
        _enable(client, digest=digest)
        response = client.post(
            "/v1/runs",
            headers=AUTH,
            json=run_command(
                "process the archive",
                thread_id="thread_plugin_selection",
                user_item_metadata={
                    "attachments": [{"path": "/tmp/source.zip", "name": "source.zip"}],
                    "plugin_selection": {"references": [{"plugin_id": "spoofed"}]},
                },
                plugin_refs=[
                    {
                        "plugin_id": "dev.shejane.fixture.archive",
                        "expected_digest": digest,
                    }
                ],
                plugin_command={
                    "plugin_id": "dev.shejane.fixture.archive",
                    "command_id": "extract",
                    "expected_digest": digest,
                },
            ),
        )

        assert response.status_code == 200, response.text
        snapshot = client.get("/v1/threads/thread_plugin_selection", headers=AUTH).json()
        user = next(item for item in snapshot["items"] if item["item_type"] == "user_message")
        assert user["metadata"] == {
            "attachments": [{"path": "/tmp/source.zip", "name": "source.zip"}],
            "plugin_selection": {
                "references": [
                    {
                        "plugin_id": "dev.shejane.fixture.archive",
                        "name": "Archive fixture",
                        "digest": digest,
                    }
                ],
                "command": {
                    "plugin_id": "dev.shejane.fixture.archive",
                    "plugin_name": "Archive fixture",
                    "command_id": "extract",
                    "title": "Extract archive",
                    "digest": digest,
                },
            },
        }


def test_checkpoint_fork_keeps_source_binding_across_plugin_update(tmp_path: Path) -> None:
    settings = reset_settings_for_tests(
        SHEJANE_RUNTIME_TOKEN="tok",
        SHEJANE_FAKE_LLM=True,
        data_dir=tmp_path / "runtime",
    )
    with TestClient(create_app(settings)) as client:
        installed = _install(client, tmp_path)
        _enable(client, digest=str(installed["digest"]))
        source_response = client.post(
            "/v1/runs",
            headers=AUTH,
            json=run_command("create a checkpoint with plugin v0.1"),
        )
        assert source_response.status_code == 200, source_response.text
        source_run_id = source_response.json()["id"]
        source_stream = _stream_to_terminal(client, source_run_id)
        assert "run.completed" in source_stream
        source = client.portal.call(client.app.state.store.get_run, source_run_id)
        assert source is not None

        _install(
            client,
            tmp_path,
            version="0.2.0",
            command_id="cmd_update_before_fork",
        )
        fork_response = client.post(
            f"/v1/runs/{source_run_id}/fork",
            headers=AUTH,
            json={
                "command_id": "cmd_fork_plugin_binding",
                "client_message_id": "msg_fork_plugin_user",
                "assistant_message_id": "msg_fork_plugin_assistant",
                "thread_id": "thread_fork_plugin_binding",
                "protocol_version": 1,
                "required_capabilities": ["agent.run", "agent.stream", "hitl"],
                "checkpoint_id": source["graph_checkpoint_id"],
                "user_input": "continue from the exact plugin definition",
            },
        )
        assert fork_response.status_code == 200, fork_response.text
        fork_run_id = fork_response.json()["id"]
        fork_stream = _stream_to_terminal(client, fork_run_id)
        assert "run.completed" in fork_stream

        source_bindings = client.portal.call(
            client.app.state.store.list_run_plugin_bindings,
            source_run_id,
        )
        fork_bindings = client.portal.call(
            client.app.state.store.list_run_plugin_bindings,
            fork_run_id,
        )
        fork = client.portal.call(client.app.state.store.get_run, fork_run_id)
        assert fork is not None

        assert fork_bindings == [
            {
                **source_bindings[0],
                "run_id": fork_run_id,
            }
        ]
        assert fork_bindings[0]["digest"] == installed["digest"]
        assert fork["graph_definition_id"] == source["graph_definition_id"]
