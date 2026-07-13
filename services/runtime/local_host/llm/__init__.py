"""LLM adapter — talks to the cloud backend over SSE so credit reserve/
settle stays the only price gate. See `backend.BackendChatModel`."""

from .backend import BackendChatModel

__all__ = ["BackendChatModel"]
