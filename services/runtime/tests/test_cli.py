from pathlib import Path

from local_host.__main__ import _parse_args


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
        ]
    )

    assert args.host == "127.0.0.1"
    assert args.port == 18080
    assert args.token == "pairing-token"
    assert args.data_dir == tmp_path
    assert args.managed_worker_vm_assets == tmp_path / "manifest.json"
    assert args.managed_worker_linux_assets == tmp_path / "linux" / "manifest.json"
