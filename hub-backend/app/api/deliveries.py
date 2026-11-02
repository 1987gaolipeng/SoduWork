"""Cross-device delivery API; all actions use the existing device identity."""
import io
import json
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse

from ..db import get_session
from ..deps import current_client
from ..services import delivery_collections as collections, library_storage, resource_access

router = APIRouter(prefix="/api/v1/deliveries", tags=["deliveries"])


def _storage_error(exc):
    return HTTPException(503, {"code": exc.code, "message": exc.message,
                               "retryable": exc.retryable})


def _download(data, filename, content_type, preview=False):
    disposition = "inline" if preview and resource_access.is_inline_preview(content_type) else "attachment"
    return StreamingResponse(io.BytesIO(data), media_type=content_type, headers={
        "Content-Disposition": f"{disposition}; filename*=UTF-8''{quote(filename, safe='')}",
        "Content-Length": str(len(data)), "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "sandbox; default-src 'none'"})


@router.post("")
async def upload(manifest: str = Form(...), file: UploadFile = File(...),
                 client=Depends(current_client), session=Depends(get_session)):
    if len(manifest) > 512 * 1024:
        raise HTTPException(413, "成果清单过大")
    try:
        options = collections.clean_manifest(json.loads(manifest))
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "成果清单不是有效 JSON") from exc
    data = await file.read(collections.byte_limit() + 1)
    try:
        row, duplicate = await collections.persist(session, collections.owner_key(client), options, data)
    except library_storage.LibraryStorageError as exc:
        raise _storage_error(exc) from exc
    from .library import _item_api
    return {"ok": True, "delivery": collections.public(row), "duplicate": duplicate, "item": _item_api(row)}


@router.get("")
async def list_deliveries(session_id: str = Query("", alias="sessionId", max_length=160),
                          source: str = Query("", pattern="^(local|cloud)?$"),
                          revision: str = Query("", max_length=160, pattern="^[A-Za-z0-9._:-]*$"),
                          limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
                          client=Depends(current_client), session=Depends(get_session)):
    rows = await collections.list_items(session, collections.owner_key(client),
        session_id=session_id, source=source, revision=revision, limit=limit, offset=offset)
    return {"ok": True, "items": [collections.public(row) for row in rows],
            "limit": limit, "offset": offset}


@router.get("/from-task/{task_id}")
async def cloud_status(task_id: str, client=Depends(current_client), session=Depends(get_session)):
    from ..services import cloud_deliveries
    return await cloud_deliveries.status(session, client, task_id)


@router.post("/from-task/{task_id}")
async def cloud_retry(task_id: str, client=Depends(current_client), session=Depends(get_session)):
    from ..services import cloud_deliveries
    return await cloud_deliveries.retry(session, client, task_id)


@router.get("/{delivery_id}")
async def get_delivery(delivery_id: str, client=Depends(current_client), session=Depends(get_session)):
    row = await collections.get(session, collections.owner_key(client), delivery_id)
    return {"ok": True, "delivery": collections.public(row)}


@router.get("/{delivery_id}/download")
async def download(delivery_id: str, client=Depends(current_client), session=Depends(get_session)):
    row = await collections.get(session, collections.owner_key(client), delivery_id)
    try:
        data = await collections.read_payload(row)
    except library_storage.LibraryStorageError as exc:
        raise _storage_error(exc) from exc
    return _download(data, row.filename, row.content_type)


@router.get("/{delivery_id}/files/{path:path}")
async def download_file(delivery_id: str, path: str, preview: bool = Query(False),
                        client=Depends(current_client), session=Depends(get_session)):
    row = await collections.get(session, collections.owner_key(client), delivery_id)
    try:
        entry, data = await collections.read_file(row, path)
    except library_storage.LibraryStorageError as exc:
        raise _storage_error(exc) from exc
    return _download(data, entry["path"].rsplit("/", 1)[-1], entry["contentType"], preview)
