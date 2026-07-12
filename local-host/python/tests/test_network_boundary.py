from __future__ import annotations

import pytest
from pydantic import ValidationError

from local_host.config import Settings


def test_runtime_listener_accepts_only_explicit_loopback_hosts() -> None:
    assert Settings(SHEJANE_LOCAL_HOST_ADDR="localhost").host == "localhost"
    assert Settings(SHEJANE_LOCAL_HOST_ADDR="127.0.0.2").host == "127.0.0.2"
    assert Settings(SHEJANE_LOCAL_HOST_ADDR="::1").host == "::1"

    for unsafe_host in ("0.0.0.0", "::", "192.168.1.10", "runtime.example.com"):
        with pytest.raises(ValidationError, match="loopback"):
            Settings(SHEJANE_LOCAL_HOST_ADDR=unsafe_host)
