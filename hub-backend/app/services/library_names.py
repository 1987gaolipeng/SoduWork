"""Personal-library destination names; immutable conversation revisions are separate."""
import re
import unicodedata

from fastapi import HTTPException
from sqlalchemy import select
from ..library_models import LibraryFolder, LibraryItem
from . import library_conversation_save

LOCK_KEY = "names/namespace"


def display_name(title, filename):
    title = str(title or filename or "").strip()
    suffix = re.search(r"(\.[^./\\]+)$", str(filename or ""))
    extension = suffix[1] if suffix else ""
    return title if not extension or title.lower().endswith(extension.lower()) else title + extension


def name_key(value):
    return unicodedata.normalize("NFC", str(value or "")).strip().lower()


async def ensure_available(session, owner, backend, folder_id, title, filename, exclude_id=None):
    # Updates already hold a conversation/item lock. PostgreSQL must also use
    # the upload namespace lock; SQLite callers already hold its writer lock.
    if session.bind.dialect.name != "sqlite":
        async with library_conversation_save.save_lock(session, owner, LOCK_KEY):
            pass  # The transaction lock lasts until commit/rollback.
    key = name_key(display_name(title, filename))
    rows = await session.execute(select(LibraryItem.id, LibraryItem.title, LibraryItem.filename).where(
        LibraryItem.owner_key == owner, LibraryItem.backend == backend,
        LibraryItem.folder_id == folder_id, LibraryItem.deleted_at.is_(None)))
    if any(row.id != exclude_id and name_key(display_name(row.title, row.filename)) == key for row in rows):
        raise HTTPException(409, {"code": "LIBRARY_NAME_CONFLICT",
            "message": "目标文件夹中已存在同名资料，请重命名后重试"})
    folders = await session.execute(select(LibraryFolder.id, LibraryFolder.name).where(
        LibraryFolder.owner_key == owner, LibraryFolder.backend == backend,
        LibraryFolder.parent_id == folder_id))
    if any(row.id != exclude_id and name_key(row.name) == key for row in folders):
        raise HTTPException(409, {"code": "LIBRARY_NAME_CONFLICT",
            "message": "当前文件夹下已有同名文件夹，请重命名后重试"})


async def ensure_folder_available(session, owner, backend, parent_id, name, exclude_id=None):
    await ensure_available(session, owner, backend, parent_id, name, "", exclude_id)
