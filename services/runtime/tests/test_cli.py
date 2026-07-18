from pathlib import Path

from local_host.__main__ import _parse_args, main


def test_runtime_cli_accepts_desktop_owned_launch_values(tmp_path: Path) -> None:
    args = _parse_args(
        [
            "--host",
            "127.0.0.1",
            "--port",
            "18080",
            "--token",
            "pairing-token",
            "--data-dir",
            str(tmp_path),
            "--managed-worker-vm-assets",
            str(tmp_path / "manifest.json"),
            "--managed-worker-linux-assets",
            str(tmp_path / "linux" / "manifest.json"),
            "--validate-managed-worker-vm-assets",
        ]
    )

    assert args.host == "127.0.0.1"
    assert args.port == 18080
    assert args.token == "pairing-token"
    assert args.data_dir == tmp_path
    assert args.managed_worker_vm_assets == tmp_path / "manifest.json"
    assert args.managed_worker_linux_assets == tmp_path / "linux" / "manifest.json"
    assert args.validate_managed_worker_vm_assets is True


def test_runtime_cli_preflights_vm_assets_without_starting_server(
    tmp_path: Path,
    monkeypatch,
) -> None:
    manifest = tmp_path / "manifest.json"
    calls: list[Path] = []
    monkeypatch.setattr(
        "local_host.__main__.load_macos_vm_resources",
        lambda path: calls.append(path),
    )
    monkeypatch.setattr(
        "local_host.__main__.uvicorn.run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("server started")),
    )

    assert (
        main(
            [
                "--managed-worker-vm-assets",
                str(manifest),
                "--validate-managed-worker-vm-assets",
            ]
        )
        == 0
    )
    assert calls == [manifest]
