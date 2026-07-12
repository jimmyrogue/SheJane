"""Lease-fenced adapter for LangGraph's async checkpointer."""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import (
    BaseCheckpointSaver,
    ChannelVersions,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
)

from .sqlite import ExecutionLease, LeaseFenceError, LocalStore


class FencedCheckpointer(BaseCheckpointSaver):
    """Reject checkpoint writes after the bound execution loses its lease."""

    def __init__(
        self,
        delegate: BaseCheckpointSaver,
        store: LocalStore,
        lease: ExecutionLease | None = None,
    ) -> None:
        super().__init__(serde=delegate.serde)
        self._delegate = delegate
        self._store = store
        self._lease = lease

    def _active_lease(self) -> ExecutionLease:
        lease = self._lease or self._store.current_execution_lease()
        if lease is None:
            raise LeaseFenceError("checkpoint write is outside an execution lease")
        return lease

    @property
    def config_specs(self) -> list:
        return self._delegate.config_specs

    def get_next_version(self, current: Any, channel: None) -> Any:
        return self._delegate.get_next_version(current, channel)

    async def aget_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        return await self._delegate.aget_tuple(config)

    async def alist(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[CheckpointTuple]:
        async for item in self._delegate.alist(
            config,
            filter=filter,
            before=before,
            limit=limit,
        ):
            yield item

    async def aput(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        lease = self._active_lease()
        async with self._store.run_write_transaction(
            lease.run_id,
            lease=lease,
        ):
            return await self._delegate.aput(config, checkpoint, metadata, new_versions)

    async def aput_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        lease = self._active_lease()
        async with self._store.run_write_transaction(
            lease.run_id,
            lease=lease,
        ):
            await self._delegate.aput_writes(config, writes, task_id, task_path)
