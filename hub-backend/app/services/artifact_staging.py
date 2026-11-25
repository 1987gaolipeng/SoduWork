"""Write-ahead object lists for reconciling interrupted delivery ingestion."""
import errno
import hashlib
import json
import logging
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from sqlalchemy import select, text

from ..models import Attachment
from . import file_io, storage

log = logging.getLogger("uvicorn.error")


def _lock(handle):
    if os.name == "nt":
        import msvcrt
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


class ObjectList:
    def __init__(self, session, task_id):
        bind = session.get_bind().engine
        database = str(bind.url)
        if bind.url.database in (":memory:", ""):
            database += str(id(bind))
        self.scope = hashlib.sha256((database + "\0" + task_id).encode()).hexdigest()
        self.directory = Path(storage._extended(os.path.join(storage._LOCAL_DIR, ".ingest"), directory=True))
        self.handle = None

    def store(self, write, key, *args):
        creating = self.handle is None
        if creating:
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            self.handle = (self.directory / (self.scope + "-" + uuid.uuid4().hex + ".objects")).open("x+b")
            _lock(self.handle)
            # Leave byte zero for the Windows mandatory lock.
            self.handle.write(b"\n")
        backend = storage.backend_name()
        self.handle.write((json.dumps([key, backend]) + "\n").encode())
        self.handle.flush()
        os.fsync(self.handle.fileno())
        if creating and os.name != "nt":
            # Make the new manifest and its directory discoverable after a power
            # loss before allowing the first object write to start.
            for directory in (self.directory, self.directory.parent):
                fd = os.open(directory, os.O_RDONLY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
        return write(key, *args)

    async def _fence(self, session, handle):
        if handle is not None and session.get_bind().dialect.name == "postgresql":
            # A disconnected writer's COMMIT might still be in flight. Wait for
            # its transaction before deciding which objects lack a durable row.
            name = Path(handle.name).name
            key = int.from_bytes(hashlib.sha256(name.encode()).digest()[:8], "big", signed=True)
            await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})

    async def before_insert(self, session):
        await self._fence(session, self.handle)

    async def _reconcile(self, session, handle):
        # An incomplete tail precedes its storage write and can be discarded.
        handle.seek(1)
        objects = dict(json.loads(line) for line in handle if line.endswith(b"\n"))
        if objects:
            await self._fence(session, handle)
            referenced = set(await session.scalars(select(Attachment.storage_key).where(
                Attachment.storage_key.in_(objects))))
            for key in objects.keys() - referenced:
                if await file_io.run(storage.delete, key, objects[key]) is False:
                    return False
        return True

    async def recover(self, session):
        for path in self.directory.glob(self.scope + "-*.objects"):
            try:
                if not path.stat().st_size:
                    continue  # Not published by its writer yet.
                with path.open("r+b") as handle:
                    _lock(handle)
                    finished = await self._reconcile(session, handle)
                if finished:
                    path.unlink(missing_ok=True)
            except FileNotFoundError:
                continue
            except ValueError:
                log.warning("Retained unreadable artifact staging manifest %s", path.name)
            except OSError as exc:
                if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                    raise

    async def finish(self, session):
        if self.handle is None:
            return
        path = Path(self.handle.name)
        try:
            finished = await self._reconcile(session, self.handle)
        finally:
            self.close()
        if finished:
            path.unlink(missing_ok=True)

    def close(self):
        if self.handle is not None:
            self.handle.close()
            self.handle = None


@asynccontextmanager
async def operation(session, task_id):
    objects = ObjectList(session, task_id)
    resolved = False
    try:
        await objects.recover(session)
        try:
            yield objects
        except BaseException:
            await session.rollback()
            resolved = True
            raise
        resolved = True
    finally:
        try:
            if resolved:
                await objects.finish(session)
        except Exception:
            log.warning("Artifact storage reconciliation deferred for task %s", task_id, exc_info=True)
        finally:
            objects.close()
