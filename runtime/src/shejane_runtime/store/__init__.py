"""Local persistent store (SQLite). Holds runs / events / permissions /
workspaces / artifacts / memory — the runtime's source of truth.

LangGraph's own checkpointer + Store databases live in separate files
(see config.checkpoint_db_path / store_db_path) so schema concerns stay
isolated.
"""

from .sqlite import LocalStore

__all__ = ["LocalStore"]
