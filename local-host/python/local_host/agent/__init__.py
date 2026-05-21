"""Agent assembly — wires `create_agent` + middleware + checkpointer + tools.

`builder.build_agent()` is the single entry point. The HTTP layer calls it
per run (cheap; the expensive piece is the checkpointer, which is shared
across runs via the daemon-level `AsyncSqliteSaver`).
"""

from .builder import build_agent, open_checkpointer

__all__ = ["build_agent", "open_checkpointer"]
