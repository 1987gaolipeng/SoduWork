"""Recheck stored HTML component false negatives only during delivery writes."""
import asyncio
import hashlib

from minio.error import MinioException
from sqlalchemy import select
from urllib3.exceptions import HTTPError

from ..models import Attachment
from . import delivery_manifest, storage

HTML_STRUCTURE_ERROR = "HTML 缺少可识别的页面结构"


async def recheck_components(session, task_id, *, source_ref="", round_no=0):
    query = select(Attachment).where(Attachment.task_id == task_id, Attachment.role == "output")
    if source_ref:
        query = query.where(Attachment.source_ref == source_ref)
    repaired = set()
    for row in (await session.scalars(query)).all():
        meta = dict(row.evidence_meta or {})
        if round_no and int(meta.get("round") or 1) != round_no:
            continue
        previous = dict(meta.get("verification") or {})
        if previous.get("reason") != HTML_STRUCTURE_ERROR:
            if meta.get("componentValidation") == 1 and previous.get("state") == "passed":
                repaired.add(row.filename)
            continue
        category = delivery_manifest.classify_name(row.filename, role=row.role, meta=meta)
        if category != "supporting" or not row.filename.lower().endswith((".html", ".htm")):
            continue
        if not meta.get("sha256") or not 0 < row.size <= 8 * 1024 * 1024:
            continue

        def read():
            stream = storage.open_stream(row.storage_key, row.backend)
            try:
                return stream.read(8 * 1024 * 1024 + 1)
            finally:
                stream.close()
                if hasattr(stream, "release_conn"):
                    stream.release_conn()

        try:
            data = await asyncio.to_thread(read)
        except (OSError, ValueError, MinioException, HTTPError):
            continue
        if len(data) != row.size or hashlib.sha256(data).hexdigest() != meta["sha256"]:
            continue
        result = delivery_manifest.validate_bytes(row.filename, data, row.content_type, category=category)
        if result.get("state") == "passed":
            row.evidence_meta = {**meta, "verification": result,
                                 "previousVerification": previous, "componentValidation": 1}
            repaired.add(row.filename)
    return repaired
