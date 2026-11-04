"""File-only work for signed client uploads; database access stays on the event loop."""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import BinaryIO


from .file_io import run as disk_call

CHUNK_SIZE = 1024 * 1024
# Bounded process-local coordination. Other Hub replicas still rely on the
# exclusive-create, immutable-byte verification and database identity checks.
_WRITE_LOCKS = tuple(threading.Lock() for _ in range(64))


class UploadTooLarge(ValueError):
    pass


def artifact_lock(path: Path):
    return _WRITE_LOCKS[hash(str(path)) % len(_WRITE_LOCKS)]


def copy_upload(source: BinaryIO, incoming: Path, limit: int) -> None:
    """Stream Starlette's already-spooled multipart file without a second RAM copy."""
    incoming.parent.mkdir(parents=True, exist_ok=False)
    total = 0
    with open(incoming, "xb") as target:
        while block := source.read(CHUNK_SIZE):
            total += len(block)
            if total > limit:
                raise UploadTooLarge("客户端安装包超过上传上限")
            target.write(block)
        target.flush()
        os.fsync(target.fileno())


def remove_incoming(incoming: Path) -> None:
    incoming.unlink(missing_ok=True)
    try:
        incoming.parent.rmdir()
    except OSError:
        pass
