"""Serialize and reuse exact conversation saves without deduplicating user uploads."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
import re
from weakref import WeakValueDictionary

from sqlalchemy import or_, select, text, update

from ..library_models import LibraryItem
from . import library_storage

DELIVERY_KEY = "soduWorkDelivery"
SOURCE_KEY = "soduWorkSource"
_sqlite_locks = WeakValueDictionary()


@asynccontextmanager
async def save_lock(session, owner, session_id):
    """Keep comparison and commit atomic across Hub workers, not just requests.

    SQLite's no-op UPDATE reserves its writer within an already-open transaction;
    BEGIN IMMEDIATE cannot be nested after a caller has read its destination.
    The in-process lock also accommodates isolated in-memory SQLite pools.
    PostgreSQL uses a transaction lock for this owner/conversation across nodes.
    """
    if session.bind.dialect.name == "sqlite":
        key = (id(asyncio.get_running_loop()), id(session.bind))
        lock = _sqlite_locks.setdefault(key, asyncio.Lock())
        async with lock:
            await session.execute(update(LibraryItem).where(False)
                                  .values(id=LibraryItem.id).execution_options(synchronize_session=False))
            yield
    else:
        key = hashlib.sha256(json.dumps(["library-conversation-save", owner, session_id],
                                       ensure_ascii=False).encode()).digest()[:8]
        await session.execute(text("SELECT pg_advisory_xact_lock(:key)"),
                              {"key": int.from_bytes(key, "big", signed=True)})
        yield


def stream_digest(handle):
    """Hash an upload without buffering it, preserving the caller's stream position."""
    position = handle.tell()
    digest = hashlib.sha256()
    try:
        handle.seek(0)
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    finally:
        handle.seek(position)
    return digest.hexdigest()


def _stored_digest(row):
    try:
        stream = library_storage.open_stream(row.storage_key, backend=row.backend)
    except TypeError as exc:
        if "unexpected keyword argument 'backend'" not in str(exc):
            raise
        stream = library_storage.open_stream(row.storage_key)
    try:
        digest, remaining = hashlib.sha256(), row.size
        while remaining:
            chunk = stream.read(min(remaining, 1024 * 1024))
            if not chunk:
                return None
            remaining -= len(chunk)
            digest.update(chunk)
        return None if stream.read(1) else digest.hexdigest()
    finally:
        stream.close()
        if hasattr(stream, "release_conn"):
            stream.release_conn()


async def find_exact(session, owner, backend, folder_id, session_id, filename, size,
                     digest, *, include_deliveries=True):
    """Verify bytes in a tightly scoped candidate set, including auto-renamed retries."""
    requested = str(filename or "")
    dot = requested.rfind(".")
    stem, extension = (requested[:dot], requested[dot:]) if dot > 0 else (requested, "")
    renamed = re.compile(r"^" + re.escape(stem) + r"（[0-9]+）" + re.escape(extension) + r"$",
                         re.IGNORECASE)
    query = select(LibraryItem).where(
        LibraryItem.owner_key == owner, LibraryItem.backend == backend,
        LibraryItem.folder_id == folder_id,
        LibraryItem.size == size, LibraryItem.deleted_at.is_(None),
        or_(LibraryItem.extra[DELIVERY_KEY]["sessionId"].as_string() == session_id,
            LibraryItem.extra[SOURCE_KEY]["sessionId"].as_string() == session_id),
    ).order_by(LibraryItem.created_at.desc(), LibraryItem.id)
    rows = (await session.scalars(query.execution_options(populate_existing=True))).all()
    # Prefer an already published immutable delivery over a legacy generic copy.
    rows = sorted(rows, key=lambda row: not isinstance((row.extra or {}).get(DELIVERY_KEY), dict))
    for row in rows:
        if row.filename != requested and not renamed.fullmatch(str(row.filename or "")):
            continue
        extra = row.extra or {}
        delivery, source = extra.get(DELIVERY_KEY), extra.get(SOURCE_KEY)
        if isinstance(delivery, dict):
            if (not include_deliveries or delivery.get("sessionId") != session_id
                    or delivery.get("objectSha256") != digest):
                continue
        elif not isinstance(source, dict) or source.get("type") != "conversation" or source.get("sessionId") != session_id:
            continue
        try:
            stored_digest = await asyncio.to_thread(_stored_digest, row)
        except FileNotFoundError:
            continue
        if stored_digest == digest:
            return row
    return None


def conversation_id(row):
    extra = row.extra or {}
    delivery, source = extra.get(DELIVERY_KEY), extra.get(SOURCE_KEY)
    if isinstance(delivery, dict):
        return str(delivery.get("sessionId") or "")
    if isinstance(source, dict) and source.get("type") == "conversation":
        return str(source.get("sessionId") or "")
    return ""


def enrich_source(row, source):
    """Merge display provenance while leaving the verified delivery manifest intact."""
    current = (row.extra or {}).get(SOURCE_KEY)
    current = dict(current) if isinstance(current, dict) else {}
    incoming = dict(source or {})
    if not incoming.get("conversationTitle"):
        incoming.pop("conversationTitle", None)
    if current.get("savedAt"):
        incoming.pop("savedAt", None)
    merged = {**current, **incoming}
    if merged != current:
        row.extra = {**(row.extra or {}), SOURCE_KEY: merged}
