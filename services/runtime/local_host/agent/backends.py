"""Runtime-owned filesystem capability wrappers."""

from __future__ import annotations

from typing import Any

from deepagents.backends.protocol import (
    EditResult,
    FileDownloadResponse,
    FileInfo,
    FileUploadResponse,
    GrepMatch,
    WriteResult,
)


class ReadOnlyBackend:
    """Delegate reads while rejecting every mutating backend operation."""

    def __init__(self, delegate: Any) -> None:
        self._delegate = delegate

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)

    def write(self, _file_path: str, _content: str) -> WriteResult:
        return WriteResult(error="read-only source: writes are not allowed")

    async def awrite(self, file_path: str, content: str) -> WriteResult:
        return self.write(file_path, content)

    def edit(
        self,
        _file_path: str,
        _old_string: str,
        _new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        del replace_all
        return EditResult(error="read-only source: edits are not allowed")

    async def aedit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
    ) -> EditResult:
        return self.edit(file_path, old_string, new_string, replace_all)

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return [FileUploadResponse(path=path, error="permission_denied") for path, _ in files]

    async def aupload_files(
        self,
        files: list[tuple[str, bytes]],
    ) -> list[FileUploadResponse]:
        return self.upload_files(files)


class ReadOnlyFileBackend(ReadOnlyBackend):
    """Expose one source file at a CompositeBackend route."""

    def __init__(self, delegate: Any, file_name: str) -> None:
        super().__init__(delegate)
        self._file_name = file_name

    def _source_key(self, requested: str) -> str:
        return f"/{self._file_name}" if requested == "/" else "/__not_available__"

    def read(self, file_path: str, offset: int = 0, limit: int = 2000) -> str:
        return self._delegate.read(self._source_key(file_path), offset=offset, limit=limit)

    async def aread(self, file_path: str, offset: int = 0, limit: int = 2000) -> str:
        return await self._delegate.aread(
            self._source_key(file_path),
            offset=offset,
            limit=limit,
        )

    def ls_info(self, _path: str) -> list[FileInfo]:
        return []

    async def als_info(self, path: str) -> list[FileInfo]:
        return self.ls_info(path)

    def grep_raw(
        self,
        _pattern: str,
        _path: str | None = None,
        _glob: str | None = None,
    ) -> list[GrepMatch]:
        return []

    async def agrep_raw(
        self,
        pattern: str,
        path: str | None = None,
        glob: str | None = None,
    ) -> list[GrepMatch]:
        return self.grep_raw(pattern, path, glob)

    def glob_info(self, _pattern: str, _path: str = "/") -> list[FileInfo]:
        return []

    async def aglob_info(self, pattern: str, path: str = "/") -> list[FileInfo]:
        return self.glob_info(pattern, path)

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        responses: list[FileDownloadResponse] = []
        for path in paths:
            if path != "/":
                responses.append(FileDownloadResponse(path=path, error="permission_denied"))
                continue
            result = self._delegate.download_files([f"/{self._file_name}"])[0]
            responses.append(
                FileDownloadResponse(path=path, content=result.content, error=result.error)
            )
        return responses

    async def adownload_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        return self.download_files(paths)
