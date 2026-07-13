from __future__ import annotations

from itertools import count
from typing import Any

_RUN_COMMAND_IDS = count(1)


def run_command(goal: str, **fields: Any) -> dict[str, Any]:
    request_id = next(_RUN_COMMAND_IDS)
    return {
        "command_id": f"cmd_test_{request_id}",
        "client_message_id": f"msg_test_{request_id}",
        "protocol_version": 1,
        "required_capabilities": ["agent.run", "agent.stream"],
        "goal": goal,
        "model": "local:test:model",
        **fields,
    }
