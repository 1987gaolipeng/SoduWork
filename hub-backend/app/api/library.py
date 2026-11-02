"""Independent personal material library API.

The library owns its metadata and object namespace. It shares only the existing
device authentication and SQLAlchemy session infrastructure with the rest of Hub.
"""
import asyncio
import mimetypes
import os
import re
import tempfile
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError

from ..config import get_settings
from ..db import get_session
from ..deps import current_client
from ..library_models import LibraryFolder, LibraryItem
from ..models import Client
from ..services import library_archive, library_conversation_save, library_formats, library_names, library_preview, library_storage

router = APIRouter(prefix="/api/v1/library", tags=["library"])
_KINDS = {"note", "image", "document", "spreadsheet", "presentation", "file"}
_SCOPES = {"recommended", "favorites", "folders", "images", "all", "trash"}
_SOURCE_TYPES = {"conversation", "upload", "library"}
_SOURCE_SESSION_ID = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
_REMOTE_QUOTA_BYTES = 1024 * 1024 * 1024


def _storage_http_error(exc):
    storage_error = exc if isinstance(exc, library_storage.LibraryStorageError) else library_storage.LibraryStorageError()
    return HTTPException(status_code=503, detail={
        "code": storage_error.code,
        "message": storage_error.message,
        "retryable": storage_error.retryable,
    })


def _select_storage(value=None, fallback=None):
    """Resolve a request's storage tab to a canonical backend name."""
    candidate = value if value is not None and str(value).strip() else fallback
    if candidate is None or not str(candidate).strip():
        return None
    try:
        return library_storage.resolve_backend(candidate)
    except library_storage.LibraryStorageError as exc:
        if str(candidate).strip().lower() in {"local", "remote", "minio", "nfs", "filesystem", "file", "fs", "s3"}:
            raise _storage_http_error(exc) from exc
        raise HTTPException(400, detail={
            "code": exc.code,
            "message": "存储位置仅支持 local、remote、minio 或 nfs",
            "retryable": False,
        }) from exc


def _item_backend(item):
    """Return a persisted backend only when it is a supported adapter.

    Older records and isolated test adapters may contain another marker. In
    that case the deployment default remains the compatible fallback.
    """
    value = str(getattr(item, "backend", "") or "").strip().lower()
    if value in {"local", "minio", "nfs"}:
        return value
    return None


def _storage_call(name, *args, backend=None):
    """Call an adapter method while keeping old injected test adapters working."""
    fn = getattr(library_storage, name)
    if backend is None:
        return fn(*args)
    try:
        return fn(*args, backend=backend)
    except TypeError as exc:
        # Existing deployments may inject a small adapter implementing the
        # original key-only signature. Only fall back for that exact mismatch;
        # errors raised by the adapter itself must still propagate.
        if "unexpected keyword argument 'backend'" not in str(exc):
            raise
        return fn(*args)


def _copy_storage_object(source_key, target_key, size, content_type, source_backend, target_backend):
    """Copy one immutable library object between storage adapters.

    The API normally receives editor text when a note is moved. Uploaded files
    do not have an editor payload, so migration must stream the already saved
    object instead of asking the client to download and re-upload it.
    """
    stream = _storage_call("open_stream", source_key, backend=source_backend)
    try:
        # NFS readers are forward-only streams while every writer rewinds the
        # input before uploading. Spool once so local, MinIO and NFS sources
        # all use the same copy path.
        declared_size = int(size or 0)
        with tempfile.TemporaryFile(mode="w+b") as buffered:
            copied = 0
            while copied < declared_size:
                chunk = stream.read(min(1024 * 1024, declared_size - copied))
                if not chunk:
                    raise library_storage.LibraryStorageError(
                        "LIBRARY_STORAGE_INCOMPLETE_READ",
                        "资料读取不完整，请重试迁移",
                        True,
                    )
                buffered.write(chunk)
                copied += len(chunk)
            if stream.read(1):
                raise library_storage.LibraryStorageError(
                    "LIBRARY_STORAGE_INCOMPLETE_READ",
                    "资料读取大小与记录不一致，请重试迁移",
                    True,
                )
            buffered.seek(0)
            return _storage_call("put_stream", target_key, buffered, declared_size,
                                 content_type or "application/octet-stream", backend=target_backend)
    finally:
        try:
            stream.close()
        finally:
            release = getattr(stream, "release_conn", None)
            if release:
                release()


async def _ensure_storage(backend=None):
    try:
        await asyncio.to_thread(_storage_call, "ensure_ready", backend=backend)
    except Exception as exc:
        raise _storage_http_error(exc) from exc


def _owner_key(client: Client) -> str:
    """One user can use multiple devices; an unbound device stays private."""
    return str(client.user_ref or client.id).strip()[:128]


def _safe_name(value: str, fallback: str = "未命名资料") -> str:
    name = str(value or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()
    return name[:240] or fallback


def _validate_metadata(body):
    if "favorite" in body and type(body["favorite"]) is not bool:
        raise HTTPException(400, "收藏状态必须为布尔值")
    if "extra" in body and not isinstance(body["extra"], dict):
        raise HTTPException(400, "资料扩展属性必须是对象")
    if isinstance(body.get("extra"), dict) and "soduWorkDelivery" in body["extra"]:
        raise HTTPException(400, "成果清单由交付服务验证，不能通过普通资料编辑修改")
    if isinstance(body.get("extra"), dict) and "soduWorkSource" in body["extra"]:
        raise HTTPException(400, "来源信息只在保存时登记，不能通过普通资料编辑修改")


def _clean_source(source_type, session_id, conversation_title, default="upload"):
    """Validate client-declared provenance before it enters `extra`."""
    source_type = str(source_type or "").strip().lower()
    if source_type and source_type not in _SOURCE_TYPES:
        raise HTTPException(400, "资料来源类型不支持")
    session_id = str(session_id or "").strip()
    if session_id and not _SOURCE_SESSION_ID.fullmatch(session_id):
        raise HTTPException(400, "会话标识格式无效")
    title = re.sub(r"[\x00-\x1f\x7f]", " ", str(conversation_title or "")).strip()[:240]
    if session_id and not source_type:
        source_type = "conversation"
    if source_type == "conversation" and not session_id:
        # A conversation tag without a session id cannot be opened later;
        # keep the record honestly labeled as a manual upload instead.
        source_type = "upload"
    return source_type or default, session_id, title


def _source_extra(source):
    """Build the reserved provenance entry (mirrors the soduWorkDelivery key)."""
    source_type, session_id, conversation_title = source
    entry = {"type": source_type, "savedAt": datetime.now(timezone.utc).isoformat()}
    if session_id:
        entry["sessionId"] = session_id
    if conversation_title:
        entry["conversationTitle"] = conversation_title
    return {"soduWorkSource": entry}


def _source_fields(item):
    """Derive the read-only provenance fields shown on library cards."""
    extra = item.extra or {}
    delivery = extra.get("soduWorkDelivery")
    delivery = delivery if isinstance(delivery, dict) else None
    source = extra.get("soduWorkSource")
    source = source if isinstance(source, dict) else {}
    session_id = str(source.get("sessionId") or "").strip()
    conversation_title = str(source.get("conversationTitle") or "").strip()
    raw_type = str(source.get("type") or "").strip().lower()
    if delivery:
        # Delivery snapshots are always born in a conversation; cloud handoffs
        # keep their dedicated label.  The manifest session id is authoritative.
        if delivery.get("source") == "cloud":
            source_type, source_label = "cloud_conversation", "云端会话成果"
        else:
            source_type, source_label = "conversation", "会话成果"
        session_id = str(delivery.get("sessionId") or "").strip() or session_id
    elif raw_type == "conversation":
        source_type, source_label = "conversation", "会话文件"
    elif raw_type == "library":
        source_type, source_label = "library", "资料库创建"
    else:
        source_type, source_label = "upload", "手动上传"
    return {"sourceType": source_type, "sourceLabel": source_label,
            "sessionId": session_id, "conversationTitle": conversation_title}


def _content_type(value):
    value = str(value or "application/octet-stream")
    if len(value) > 160 or any(ord(ch) < 32 or ord(ch) > 126 for ch in value):
        raise HTTPException(400, "文件类型无效")
    return value


async def _destination_backend(session, owner, folder_id, requested):
    folder = await _owned_folder(session, owner, folder_id, backend=requested)
    try:
        return requested or (folder.backend if folder else library_storage.storage_backend())
    except library_storage.LibraryStorageError as exc:
        raise _storage_http_error(exc) from exc


async def _commit_folder(session):
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(409, "当前文件夹下已有同名文件夹") from exc


def _kind_for_file(filename: str, content_type: str) -> str:
    mime = str(content_type or "").lower()
    ext = os.path.splitext(filename)[1].lower()
    if mime.startswith("image/") or ext in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}:
        return "image"
    if ext in {".xls", ".xlsx", ".csv", ".ods"} or "spreadsheet" in mime:
        return "spreadsheet"
    if ext in {".ppt", ".pptx", ".odp"} or "presentation" in mime:
        return "presentation"
    if mime.startswith("text/") or ext in {".md", ".doc", ".docx", ".pdf", ".rtf"}:
        return "document"
    return "file"


def _iso_timestamp(value):
    if value is None:
        return None
    # SQLite drops the timezone marker when reading UTC SQL defaults back.
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).isoformat()


def _folder_api(folder, item_count=None, child_count=None):
    payload = {"id": folder.id, "name": folder.name, "parentId": folder.parent_id,
            "backend": getattr(folder, "backend", "local") or "local",
            "favorite": bool(folder.favorite),
            "createdAt": _iso_timestamp(folder.created_at),
            "updatedAt": _iso_timestamp(folder.updated_at)}
    if item_count is not None:
        payload["itemCount"] = int(item_count or 0)
    if child_count is not None:
        payload["childCount"] = int(child_count or 0)
    return payload


def _item_api(item):
    return {"id": item.id, "folderId": item.folder_id, "kind": item.kind,
            "title": item.title, "filename": item.filename,
            "contentType": item.content_type, "size": int(item.size or 0),
            "backend": getattr(item, "backend", "local") or "local",
            "favorite": bool(item.favorite), "extra": item.extra or {},
            **_source_fields(item),
            "createdAt": _iso_timestamp(item.created_at),
            "updatedAt": _iso_timestamp(item.updated_at),
            "lastOpenedAt": _iso_timestamp(item.last_opened_at),
            "deletedAt": _iso_timestamp(item.deleted_at),
            "isDeleted": bool(item.deleted_at)}


async def _owned_folder(session, owner, folder_id, backend=None):
    if not folder_id:
        return None
    clauses = [LibraryFolder.id == str(folder_id), LibraryFolder.owner_key == owner]
    if backend:
        clauses.append(LibraryFolder.backend == backend)
    row = (await session.execute(select(LibraryFolder).where(and_(*clauses)))).scalar_one_or_none()
    if row is None:
        if backend:
            raise HTTPException(409, "文件夹不存在或不在当前存储中")
        raise HTTPException(404, "文件夹不存在")
    return row


async def _owned_item(session, owner, item_id, include_deleted: bool = False):
    clauses = [LibraryItem.id == str(item_id), LibraryItem.owner_key == owner]
    if not include_deleted:
        clauses.append(LibraryItem.deleted_at.is_(None))
    row = (await session.execute(select(LibraryItem).where(and_(*clauses))
                                 .execution_options(populate_existing=True))).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "资料不存在")
    return row


def _max_bytes():
    configured = int(get_settings().library_max_mb or 0)
    return configured * 1024 * 1024 if configured > 0 else None


def _document_text_format(body: dict) -> str:
    """Resolve the plain-text document extension requested by the client."""
    requested = str(body.get("format") or body.get("textFormat") or "").strip().lower()
    if requested in {"md", "markdown"}:
        return "md"
    if requested in {"txt", "text", "plain"}:
        return "txt"
    filename = str(body.get("filename") or "").strip().lower()
    return "md" if filename.endswith(".md") else "txt"


@router.get("/storage/status")
async def library_storage_status(
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Return storage capability and the current user's remote space usage."""
    try:
        payload = await asyncio.to_thread(library_storage.status)
    except Exception as exc:  # noqa: BLE001 - keep a machine-readable boundary
        raise _storage_http_error(exc) from exc

    # The selected provider is the only remote storage the library can use for
    # new writes. Trashed rows still own remote objects until the recycle bin
    # is emptied, so they remain part of the physical space total.
    storage = payload.get("storage") if isinstance(payload, dict) else None
    storage = dict(storage) if isinstance(storage, dict) else {}
    remote = storage.get("remote") or (payload.get("remote") if isinstance(payload, dict) else None)
    if isinstance(remote, dict) and remote.get("available") and remote.get("connected"):
        backend = str(remote.get("backend") or "").strip().lower()
        if backend in {"minio", "nfs"}:
            try:
                used = await session.scalar(
                    select(func.coalesce(func.sum(LibraryItem.size), 0)).where(
                        LibraryItem.owner_key == _owner_key(client),
                        LibraryItem.backend == backend,
                    )
                )
            except Exception:  # noqa: BLE001 - storage health remains usable if quota read is temporarily unavailable
                used = None
            if used is None:
                return payload
            used_bytes = max(0, int(used or 0))
            remaining_bytes = max(0, _REMOTE_QUOTA_BYTES - used_bytes)
            remote = {
                **remote,
                "quotaBytes": _REMOTE_QUOTA_BYTES,
                "usedBytes": used_bytes,
                "remainingBytes": remaining_bytes,
            }
            storage["remote"] = remote
            payload = {**payload, "storage": storage, "remote": remote}
    return payload


@router.get("/share-members")
async def list_library_share_members(
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """List active users in the current user's organization for file sharing."""
    from ..services import library_sharing
    return await library_sharing.members(session, client)


@router.post("/items/{item_id}/share")
async def share_library_item(
    item_id: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Snapshot a library item into durable organization notifications."""
    recipients = body.get("recipientUserIds")
    if recipients is None:
        recipients = body.get("recipientIds")
    if not isinstance(recipients, list):
        raise HTTPException(400, "recipientUserIds must be a list")
    from ..services import library_sharing
    return await library_sharing.share(
        session, client, item_id, recipients, str(body.get("note") or "")
    )


@router.post("/share-local")
async def share_local_library_file(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Send a local file snapshot without creating a remote library entry."""
    from ..services import library_sharing
    return await library_sharing.share_local(session, client, body)


@router.post("/share-local-batch")
async def share_local_library_files(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    from ..services import library_sharing
    return await library_sharing.share_local_batch(session, client, body)


def _batch_ids(body: dict, limit: int = 100) -> list[str]:
    values = body.get("itemIds") if isinstance(body, dict) else None
    if not isinstance(values, list) or not values:
        raise HTTPException(400, "itemIds must be a non-empty list")
    ids = list(dict.fromkeys(str(value or "").strip() for value in values if str(value or "").strip()))
    if not ids or len(ids) > limit:
        raise HTTPException(400, f"一次最多处理 {limit} 个资料")
    return ids


@router.post("/items/batch-delete")
async def batch_delete_library_items(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Move several owned library items to the recycle bin in one transaction."""
    owner = _owner_key(client)
    ids = _batch_ids(body)
    rows = (await session.execute(select(LibraryItem).where(
        LibraryItem.owner_key == owner, LibraryItem.id.in_(ids)))).scalars().all()
    by_id = {str(row.id): row for row in rows}
    succeeded, failed = [], []
    stamp = datetime.now(timezone.utc)
    for item_id in ids:
        row = by_id.get(item_id)
        if row is None:
            failed.append({"id": item_id, "code": "LIBRARY_NOT_FOUND", "message": "资料不存在"})
        elif row.deleted_at is not None:
            failed.append({"id": item_id, "code": "LIBRARY_ALREADY_DELETED", "message": "资料已在回收站"})
        else:
            row.deleted_at = stamp
            row.favorite = False
            succeeded.append(item_id)
    await session.commit()
    return {"ok": True, "succeeded": succeeded, "failed": failed,
            "trashed": len(succeeded)}


@router.post("/items/batch-share")
async def batch_share_library_items(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Share selected remote and client-local items as one package per recipient."""
    from ..services import library_sharing
    raw_ids = body.get("itemIds") if isinstance(body, dict) else None
    if raw_ids is None: raw_ids = []
    if not isinstance(raw_ids, list): raise HTTPException(400, "itemIds must be a list")
    ids = list(dict.fromkeys(str(value or "").strip() for value in raw_ids if str(value or "").strip()))
    raw_folder_ids = body.get("folderIds") if isinstance(body, dict) else None
    if raw_folder_ids is None:
        raw_folder_ids = []
    if not isinstance(raw_folder_ids, list):
        raise HTTPException(400, "folderIds must be a list")
    folder_ids = list(dict.fromkeys(str(value or "").strip() for value in raw_folder_ids if str(value or "").strip()))
    if len(folder_ids) > library_sharing.MAX_ITEMS:
        raise HTTPException(400, f"一次最多选择 {library_sharing.MAX_ITEMS} 个文件夹")
    if folder_ids:
        folder_rows = await library_sharing.folder_items(session, client, folder_ids)
        ids.extend(str(row.id) for row in folder_rows)
    raw_local = body.get("localFiles") if isinstance(body, dict) else None
    snapshots, local_ids = (library_sharing.parse_local_snapshots(raw_local) if raw_local is not None else ([], []))
    all_ids = list(dict.fromkeys(ids + local_ids))
    if not all_ids: raise HTTPException(400, "itemIds must be a non-empty list")
    if len(all_ids) > library_sharing.MAX_ITEMS: raise HTTPException(400, f"一次最多分享 {library_sharing.MAX_ITEMS} 份资料")
    recipients = body.get("recipientUserIds")
    if recipients is None:
        recipients = body.get("recipientIds")
    if not isinstance(recipients, list):
        raise HTTPException(400, "recipientUserIds must be a list")
    note = str(body.get("note") or "")
    request_id = str(body.get("requestId") or "").strip(); request_key = ""
    if request_id:
        try: request_key = "library-batch-share:" + str(uuid.UUID(request_id))
        except ValueError as exc: raise HTTPException(400, "分享请求标识无效，请重新打开分享窗口") from exc
    # A local folder is expanded by the desktop client into ``localFiles``.
    # Keep the folder intent in the request so a one-file folder is still sent
    # as a ZIP instead of silently degrading to a normal file attachment.
    force_package = bool(folder_ids) or body.get("forcePackage") is True
    result = await library_sharing.share_items(session, client, all_ids, recipients, note,
        request_key=request_key, package=True, snapshots=snapshots or None,
        force_package=force_package)
    return {**result, "folderIds": folder_ids, "succeeded": [{"ids": all_ids, "folderIds": folder_ids, "result": result}], "failed": [],
            "shared": len(all_ids), "notifications": result.get("shared", 0)}


@router.post("/folders/{folder_id}/share")
async def share_library_folder(
    folder_id: str,
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Snapshot a folder (including nested files) as a ZIP notification."""
    recipients = body.get("recipientUserIds")
    if recipients is None:
        recipients = body.get("recipientIds")
    if not isinstance(recipients, list):
        raise HTTPException(400, "recipientUserIds must be a list")
    from ..services import library_sharing
    request_id = str(body.get("requestId") or "").strip()
    request_key = ""
    if request_id:
        try:
            request_key = "library-folder-share:" + str(uuid.UUID(request_id))
        except ValueError as exc:
            raise HTTPException(400, "分享请求标识无效，请重新打开分享窗口") from exc
    return await library_sharing.share_folders(
        session, client, [folder_id], recipients, str(body.get("note") or ""), request_key=request_key,
    )


@router.post("/folders/batch-share")
async def batch_share_library_folders(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Share several folders as one ZIP notification per recipient."""
    from ..services import library_sharing
    raw_ids = body.get("folderIds") if isinstance(body, dict) else None
    if not isinstance(raw_ids, list) or not raw_ids:
        raise HTTPException(400, "folderIds must be a non-empty list")
    folder_ids = list(dict.fromkeys(str(value or "").strip() for value in raw_ids if str(value or "").strip()))
    if not folder_ids or len(folder_ids) > library_sharing.MAX_ITEMS:
        raise HTTPException(400, f"一次最多选择 {library_sharing.MAX_ITEMS} 个文件夹")
    recipients = body.get("recipientUserIds")
    if recipients is None:
        recipients = body.get("recipientIds")
    if not isinstance(recipients, list):
        raise HTTPException(400, "recipientUserIds must be a list")
    request_id = str(body.get("requestId") or "").strip()
    request_key = ""
    if request_id:
        try:
            request_key = "library-folder-batch-share:" + str(uuid.UUID(request_id))
        except ValueError as exc:
            raise HTTPException(400, "分享请求标识无效，请重新打开分享窗口") from exc
    result = await library_sharing.share_folders(
        session, client, folder_ids, recipients, str(body.get("note") or ""), request_key=request_key,
    )
    return {**result, "folderIds": folder_ids}


@router.get("")
async def list_library(scope: str = Query("recommended"), query: str = Query(""),
                       folder_id: str = Query("", alias="folderId"),
                       storage: str = Query(""),
                       client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    # Viewing any library scope is also a storage health check.  Returning an
    # empty list while MinIO is missing makes an operational failure look like
    # a valid empty library and prevents the user from fixing the deployment.
    backend_filter = _select_storage(storage)
    await _ensure_storage(backend_filter)
    owner = _owner_key(client)
    scope = scope if scope in _SCOPES else "recommended"
    # Collection tabs span all folders. Only tree views use the current folder;
    # clients enter a folder by switching to the "all" scope.
    folder = await _owned_folder(session, owner, folder_id or None, backend=backend_filter) if scope in {"all", "folders"} else None
    text = str(query or "").strip()
    pattern = "%" + text[:120] + "%" if text else None
    folder_clauses = [LibraryFolder.owner_key == owner]
    if backend_filter:
        folder_clauses.append(LibraryFolder.backend == backend_filter)
    if scope == "favorites":
        folder_clauses.append(LibraryFolder.favorite.is_(True))
    else:
        folder_clauses.append(LibraryFolder.parent_id == (folder.id if folder else None))
    if pattern:
        folder_clauses.append(LibraryFolder.name.ilike(pattern))
    folders = []
    folder_api_rows = []
    if scope in {"all", "folders", "favorites"}:
        folders = (await session.execute(select(LibraryFolder).where(*folder_clauses)
                   .order_by(LibraryFolder.name.asc(), LibraryFolder.id.asc()).limit(500))).scalars().all()
        if folders:
            folder_ids = [row.id for row in folders]
            child_clauses = [LibraryFolder.owner_key == owner, LibraryFolder.parent_id.in_(folder_ids)]
            item_count_clauses = [LibraryItem.owner_key == owner, LibraryItem.folder_id.in_(folder_ids), LibraryItem.deleted_at.is_(None)]
            if backend_filter:
                child_clauses.append(LibraryFolder.backend == backend_filter)
                item_count_clauses.append(LibraryItem.backend == backend_filter)
            child_counts = {
                parent_id: int(count or 0)
                for parent_id, count in (await session.execute(
                    select(LibraryFolder.parent_id, func.count(LibraryFolder.id))
                    .where(*child_clauses).group_by(LibraryFolder.parent_id)
                )).all()
            }
            item_counts = {
                folder_id: int(count or 0)
                for folder_id, count in (await session.execute(
                    select(LibraryItem.folder_id, func.count(LibraryItem.id))
                    .where(*item_count_clauses).group_by(LibraryItem.folder_id)
                )).all()
            }
            folder_api_rows = [
                _folder_api(row, item_counts.get(row.id, 0), child_counts.get(row.id, 0))
                for row in folders
            ]
    clauses = [LibraryItem.owner_key == owner]
    if backend_filter:
        clauses.append(LibraryItem.backend == backend_filter)
    if scope == "trash":
        # Trash is deliberately flat: deleted items can reference a folder
        # that was subsequently removed, and restore will safely fall back to
        # the root in that case.
        clauses.append(LibraryItem.deleted_at.is_not(None))
    else:
        clauses.append(LibraryItem.deleted_at.is_(None))
        if scope in {"all", "folders"}:
            clauses.append(LibraryItem.folder_id == (folder.id if folder else None))
        if scope == "favorites":
            clauses.append(LibraryItem.favorite.is_(True))
        elif scope == "images":
            clauses.append(LibraryItem.kind == "image")
    if pattern:
        clauses.append(or_(LibraryItem.title.ilike(pattern), LibraryItem.filename.ilike(pattern)))
    if scope == "trash":
        order = (LibraryItem.deleted_at.desc(), LibraryItem.created_at.desc(), LibraryItem.id.desc())
    elif scope in {"recommended", "images"}:
        order = (LibraryItem.updated_at.desc(), LibraryItem.created_at.desc(), LibraryItem.id.desc())
    else:
        order = (LibraryItem.title.asc(), LibraryItem.id.asc())
    items = [] if scope == "folders" else (await session.execute(
        select(LibraryItem).where(and_(*clauses)).order_by(*order).limit(500))).scalars().all()
    trash_clauses = [LibraryItem.owner_key == owner, LibraryItem.deleted_at.is_not(None)]
    if backend_filter:
        trash_clauses.append(LibraryItem.backend == backend_filter)
    trash_count = (await session.execute(select(func.count(LibraryItem.id)).where(*trash_clauses))).scalar_one()
    return {"ok": True, "scope": scope, "folder": _folder_api(folder) if folder and scope != "trash" else None,
            "folders": folder_api_rows or [_folder_api(row) for row in folders],
            "items": [] if scope == "folders" else [_item_api(row) for row in items],
            "trashCount": int(trash_count or 0), "storage": backend_filter}


@router.post("/folders")
async def create_folder(body: dict = Body(default_factory=dict), client: Client = Depends(current_client),
                        session: AsyncSession = Depends(get_session)):
    async with library_conversation_save.save_lock(session, _owner_key(client), library_names.LOCK_KEY):
        return await _create_folder(body, client, session)


async def _create_folder(body, client, session):
    owner = _owner_key(client)
    selected_backend = _select_storage(body.get("storage") or body.get("backend"))
    name = _safe_name(body.get("name"), "新建文件夹")[:160]
    parent_id = str(body.get("parentId") or "").strip() or None
    selected_backend = await _destination_backend(session, owner, parent_id, selected_backend)
    await _ensure_storage(selected_backend)
    await library_names.ensure_folder_available(session, owner, selected_backend, parent_id, name)
    row = LibraryFolder(owner_key=owner, parent_id=parent_id, name=name,
                        **({"backend": selected_backend} if selected_backend else {}))
    session.add(row)
    await _commit_folder(session)
    await session.refresh(row)
    return {"ok": True, "folder": _folder_api(row)}


@router.patch("/folders/{folder_id}")
async def update_folder(folder_id: str, body: dict = Body(default_factory=dict),
                        client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    async with library_conversation_save.save_lock(session, _owner_key(client), library_names.LOCK_KEY):
        return await _update_folder(folder_id, body, client, session)


async def _update_folder(folder_id, body, client, session):
    selected_backend = _select_storage(body.get("storage") or body.get("backend"))
    owner = _owner_key(client)
    folder = await _owned_folder(session, owner, folder_id, backend=selected_backend)
    has_name = "name" in body
    has_favorite = "favorite" in body
    if not has_name and not has_favorite:
        raise HTTPException(400, "请提供文件夹名称或收藏状态")
    if has_name:
        raw_name = body.get("name")
        if not isinstance(raw_name, str) or not raw_name.strip():
            raise HTTPException(400, "文件夹名称不能为空")
        name = _safe_name(raw_name, "")[:160]
        if not name:
            raise HTTPException(400, "文件夹名称不能为空")
        await library_names.ensure_folder_available(session, owner, folder.backend, folder.parent_id, name, folder.id)
        folder.name = name
    if has_favorite:
        if type(body["favorite"]) is not bool:
            raise HTTPException(400, "收藏状态必须为布尔值")
        folder.favorite = body["favorite"]
    await _commit_folder(session)
    await session.refresh(folder)
    return {"ok": True, "folder": _folder_api(folder)}


@router.delete("/folders/{folder_id}")
async def delete_folder(folder_id: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    owner = _owner_key(client)
    folder = await _owned_folder(session, owner, folder_id)
    child = (await session.execute(select(func.count(LibraryFolder.id)).where(
        LibraryFolder.owner_key == owner, LibraryFolder.parent_id == folder.id))).scalar_one()
    item_count = (await session.execute(select(func.count(LibraryItem.id)).where(
        LibraryItem.owner_key == owner, LibraryItem.folder_id == folder.id,
        LibraryItem.deleted_at.is_(None)))).scalar_one()
    if child or item_count:
        raise HTTPException(409, "请先移除文件夹中的资料和子文件夹")
    await session.delete(folder)
    await session.commit()
    return {"ok": True}


async def _persist_item(session, owner, folder_id, kind, title, filename, content_type, data, extra=None, backend=None, reject_duplicate=True):
    async with library_conversation_save.save_lock(session, owner, library_names.LOCK_KEY):
        if reject_duplicate:
            await library_names.ensure_available(session, owner, backend, folder_id, title, filename)
        else:
            title, filename = await library_names.next_available(session, owner, backend, folder_id, title, filename)
        return await _write_item(session, owner, folder_id, kind, title, filename, content_type, data, extra, backend)


async def _write_item(session, owner, folder_id, kind, title, filename, content_type, data, extra=None, backend=None):
    item_id = str(uuid.uuid4())
    key = library_storage.object_key(owner, item_id, filename)
    selected_backend = backend
    try:
        backend = await asyncio.to_thread(_storage_call, "put_bytes", key, data, content_type,
                                          backend=selected_backend)
        if backend not in {"local", "minio", "nfs"}:
            backend = selected_backend or await asyncio.to_thread(library_storage.storage_backend)
        row = LibraryItem(id=item_id, owner_key=owner, folder_id=folder_id, kind=kind, title=title,
                          filename=filename, content_type=content_type, size=len(data), storage_key=key,
                          backend=backend, extra=dict(extra or {}))
        session.add(row)
        await session.commit()
    except Exception:
        await session.rollback()
        try:
            await asyncio.to_thread(_storage_call, "delete", key,
                                    backend=backend if backend in {"local", "minio", "nfs"} else selected_backend)
        except Exception:
            pass
        raise
    await session.refresh(row)
    return row


async def _persist_upload(session, owner, folder_id, kind, title, filename, content_type, handle, size, backend=None, extra=None, reject_duplicate=False):
    source = (extra or {}).get("soduWorkSource") or {}
    if not reject_duplicate and source.get("type") == "conversation" and source.get("sessionId"):
        digest = await asyncio.to_thread(library_conversation_save.stream_digest, handle)
        async with library_conversation_save.save_lock(session, owner, source["sessionId"]):
            existing = await library_conversation_save.find_exact(
                session, owner, backend, folder_id, source["sessionId"], filename, size, digest)
            if existing is not None:
                library_conversation_save.enrich_source(existing, source)
                await session.commit()
                await session.refresh(existing)
                return existing
            if session.bind.dialect.name == "sqlite":
                # SQLite's save_lock is already a process-wide writer lock.
                title, filename = await library_names.next_available(
                    session, owner, backend, folder_id, title, filename)
            else:
                # PostgreSQL needs the namespace lock as well as the
                # conversation lock so concurrent sessions cannot choose the
                # same suffix. The order is session -> namespace everywhere
                # this path is used, avoiding a lock inversion.
                async with library_conversation_save.save_lock(session, owner, library_names.LOCK_KEY):
                    title, filename = await library_names.next_available(
                        session, owner, backend, folder_id, title, filename)
            return await _write_upload(session, owner, folder_id, kind, title, filename,
                                       content_type, handle, size, backend, extra)
    async with library_conversation_save.save_lock(session, owner, library_names.LOCK_KEY):
        title, filename = await library_names.next_available(session, owner, backend, folder_id, title, filename)
        return await _write_upload(session, owner, folder_id, kind, title, filename,
                                   content_type, handle, size, backend, extra)


async def _write_upload(session, owner, folder_id, kind, title, filename, content_type, handle, size, backend=None, extra=None):
    item_id = str(uuid.uuid4())
    key = library_storage.object_key(owner, item_id, filename)
    selected_backend = backend
    try:
        backend = await asyncio.to_thread(_storage_call, "put_stream", key, handle, size, content_type,
                                          backend=selected_backend)
        if backend not in {"local", "minio", "nfs"}:
            backend = selected_backend or await asyncio.to_thread(library_storage.storage_backend)
        row = LibraryItem(id=item_id, owner_key=owner, folder_id=folder_id, kind=kind, title=title,
                          filename=filename, content_type=content_type, size=size, storage_key=key,
                          backend=backend, extra=dict(extra or {}))
        session.add(row)
        await session.commit()
    except Exception:
        await session.rollback()
        try:
            await asyncio.to_thread(_storage_call, "delete", key,
                                    backend=backend if backend in {"local", "minio", "nfs"} else selected_backend)
        except Exception:
            pass
        raise
    await session.refresh(row)
    return row


@router.post("/items")
async def create_library_item(body: dict = Body(default_factory=dict), client: Client = Depends(current_client),
                             session: AsyncSession = Depends(get_session)):
    owner = _owner_key(client)
    _validate_metadata(body)
    selected_backend = _select_storage(body.get("storage") or body.get("backend"))
    kind = str(body.get("kind") or "note").strip().lower()
    if kind not in _KINDS:
        raise HTTPException(400, "资料类型不支持")
    folder_id = str(body.get("folderId") or "").strip() or None
    selected_backend = await _destination_backend(session, owner, folder_id, selected_backend)
    await _ensure_storage(selected_backend)
    title = _safe_name(body.get("title"), "未命名资料")
    content = str(body.get("content") or "")
    source = _clean_source(body.get("sourceType"), body.get("sessionId"),
                           body.get("conversationTitle"), default="library")
    if kind in library_formats.FORMATS:
        try:
            text_format = _document_text_format(body) if kind == "document" else None
            data, suffix, content_type = await asyncio.to_thread(library_formats.export, kind, title, content, text_format)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    else:
        data, suffix, content_type = content.encode("utf-8"), ".bin", _content_type(body.get("contentType"))
    max_bytes = _max_bytes()
    if max_bytes is not None and len(data) > max_bytes:
        raise HTTPException(413, "资料内容超过大小限制")
    filename = _safe_name(body.get("filename"), title + suffix)
    extra = dict(body.get("extra") or {})
    extra.update(_source_extra(source))
    try:
        row = await _persist_item(session, owner, folder_id, kind, title, filename, content_type, data, extra, selected_backend,
                                  # Conversation saves are explicit version
                                  # saves; the duplicate-name option used by
                                  # older remote-copy clients must not turn a
                                  # same-name save into a user-visible 409.
                                  reject_duplicate=source[0] != "conversation")
    except library_storage.LibraryStorageError as exc:
        raise _storage_http_error(exc) from exc
    return {"ok": True, "item": _item_api(row)}


@router.post("/items/upload")
async def upload_library_item(file: UploadFile = File(...), folder_id: str = Form("", alias="folderId"),
                             storage: str = Form(""),
                             source_type: str = Form("", alias="sourceType"),
                             session_id: str = Form("", alias="sessionId"),
                             conversation_title: str = Form("", alias="conversationTitle"),
                             reject_duplicate_name: bool = Form(False, alias="rejectDuplicateName"),
                             client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    owner = _owner_key(client)
    selected_backend = _select_storage(storage)
    folder_id = str(folder_id or "").strip() or None
    selected_backend = await _destination_backend(session, owner, folder_id, selected_backend)
    await _ensure_storage(selected_backend)
    filename = _safe_name(file.filename, "上传资料")
    content_type = _content_type(file.content_type or mimetypes.guess_type(filename)[0])
    try:
        await file.seek(0)
        handle = file.file
        handle.seek(0, os.SEEK_END)
        size = int(handle.tell())
        handle.seek(0)
    except Exception as exc:
        raise HTTPException(400, "无法读取上传文件") from exc
    if size <= 0:
        raise HTTPException(400, "不能上传空文件")
    max_bytes = _max_bytes()
    if max_bytes is not None and size > max_bytes:
        raise HTTPException(413, f"文件超过 {get_settings().library_max_mb}MB 限制")
    source = _clean_source(source_type, session_id, conversation_title)
    try:
        row = await _persist_upload(session, owner, str(folder_id or "") or None,
                                    _kind_for_file(filename, content_type),
                                    os.path.splitext(filename)[0][:240] or "上传资料",
                                    filename, content_type, handle, size, selected_backend,
                                    extra=_source_extra(source), reject_duplicate=reject_duplicate_name)
    except library_storage.LibraryStorageError as exc:
        raise _storage_http_error(exc) from exc
    return {"ok": True, "item": _item_api(row)}


@router.patch("/items/{item_id}")
async def update_library_item(item_id: str, body: dict = Body(default_factory=dict), client: Client = Depends(current_client),
                             session: AsyncSession = Depends(get_session)):
    owner = _owner_key(client)
    row = await _owned_item(session, owner, item_id)
    session_id = library_conversation_save.conversation_id(row)
    # Serialize ordinary uploads too: an edit and a migration must not commit
    # a storage key, backend and size from different versions. '/' is excluded
    # from source session IDs, keeping item locks separate from save locks.
    async with library_conversation_save.save_lock(session, owner, session_id or "item/" + item_id):
        # Re-read after acquiring the lock, including a possible delivery
        # promotion or a completed migration in another Hub worker.
        return await _update_library_item(item_id, body, client, session)


async def _update_library_item(item_id, body, client, session):
    owner = _owner_key(client)
    row = await _owned_item(session, owner, item_id)
    _validate_metadata(body)
    if isinstance((row.extra or {}).get("soduWorkDelivery"), dict) and any(
            key in body for key in ("content", "extra", "storage", "backend")):
        raise HTTPException(409, "已保存的成果版本不能修改；请将更新后的成果保存为新版本")
    next_title = _safe_name(body.get("title"), row.title) if "title" in body else row.title
    replacement = None
    old_storage_key = None
    old_backend = _item_backend(row)
    target_backend = _select_storage(body.get("storage") or body.get("backend"), fallback=old_backend)
    if target_backend != old_backend and "content" not in body and not row.storage_key:
        raise HTTPException(409, "资料没有可迁移的存储对象")
    folder_id = str(body.get("folderId") or "").strip() or None if "folderId" in body else row.folder_id
    await _owned_folder(session, owner, folder_id, backend=target_backend)
    if next_title != row.title or target_backend != old_backend or folder_id != row.folder_id:
        await library_names.ensure_available(session, owner, target_backend, folder_id, next_title, row.filename, row.id)
    if target_backend != old_backend and "content" not in body:
        await _ensure_storage(target_backend)
        replacement = library_storage.object_key(owner, row.id, row.filename or "")
        try:
            new_backend = await asyncio.to_thread(
                _copy_storage_object, row.storage_key, replacement, row.size,
                row.content_type, old_backend, target_backend
            )
        except library_storage.LibraryStorageError as exc:
            raise _storage_http_error(exc) from exc
        except Exception as exc:
            raise _storage_http_error(exc) from exc
        old_storage_key = row.storage_key
        row.storage_key = replacement
        row.backend = new_backend if new_backend in {"local", "minio", "nfs"} else target_backend
    elif "content" in body:
        if row.kind not in library_formats.FORMATS:
            raise HTTPException(400, "此资料类型不支持在线编辑")
        try:
            export_kind, text_format = library_formats.editor_format(row.kind, row.filename, row.content_type)
            data, suffix, content_type = await asyncio.to_thread(
                library_formats.export, export_kind, next_title, str(body.get("content") or ""), text_format
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        max_bytes = _max_bytes()
        if max_bytes is not None and len(data) > max_bytes:
            raise HTTPException(413, "资料内容超过大小限制")
        await _ensure_storage(target_backend)
        replacement = library_storage.object_key(owner, row.id, row.filename or "")
        try:
            new_backend = await asyncio.to_thread(
                _storage_call, "put_bytes", replacement, data, content_type, backend=target_backend
            )
        except library_storage.LibraryStorageError as exc:
            raise _storage_http_error(exc) from exc
        old_storage_key = row.storage_key
        row.storage_key = replacement
        row.backend = new_backend if new_backend in {"local", "minio", "nfs"} else target_backend
        row.size = len(data)
        row.content_type = content_type
        row.filename = _safe_name(next_title + suffix) if row.kind == "note" else _safe_name(row.filename, next_title + suffix)
    row.title = next_title
    row.folder_id = folder_id
    if "favorite" in body:
        row.favorite = body["favorite"]
    if "extra" in body:
        replacement_extra = dict(body["extra"])
        # Provenance is registered at save time and stays read-only afterwards;
        # a whole-extra replacement must not silently drop it.
        if "soduWorkSource" in (row.extra or {}) and "soduWorkSource" not in replacement_extra:
            replacement_extra["soduWorkSource"] = row.extra["soduWorkSource"]
        row.extra = replacement_extra
    try:
        await session.commit()
    except Exception:
        await session.rollback()
        if replacement:
            try:
                await asyncio.to_thread(_storage_call, "delete", replacement,
                                        backend=target_backend)
            except Exception:
                pass
        raise
    if old_storage_key and old_storage_key != row.storage_key:
        # The metadata commit is authoritative. A failed cleanup leaves an
        # unreachable immutable object but does not make the saved edit fail.
        try:
            await asyncio.to_thread(_storage_call, "delete", old_storage_key,
                                    backend=old_backend)
        except Exception:
            pass
    await session.refresh(row)
    return {"ok": True, "item": _item_api(row)}


@router.post("/items/{item_id}/source")
async def attach_library_source(item_id: str, body: dict = Body(default_factory=dict),
                                client: Client = Depends(current_client),
                                session: AsyncSession = Depends(get_session)):
    """Register conversation provenance after the fact.

    Draft attachments are uploaded when the user picks them, before their
    conversation exists.  Once the conversation is created, the client calls
    this endpoint to link the saved items to it.  Idempotent: existing
    non-upload provenance always wins.
    """
    owner = _owner_key(client)
    row = await _owned_item(session, owner, item_id)
    source = _clean_source(body.get("sourceType"), body.get("sessionId"),
                           body.get("conversationTitle"), default="conversation")
    source_type, session_id, _title = source
    if source_type != "conversation" or not session_id:
        raise HTTPException(400, "会话来源需要提供有效的会话标识")
    async with library_conversation_save.save_lock(session, owner, session_id):
        # A delayed draft association must not overwrite delivery metadata
        # attached after the first ownership check.
        return await _attach_library_source(session, owner, item_id, source)


async def _attach_library_source(session, owner, item_id, source):
    row = await _owned_item(session, owner, item_id)
    extra = dict(row.extra or {})
    if isinstance(extra.get("soduWorkDelivery"), dict):
        # Delivery snapshots are born in a conversation; the manifest session
        # id is authoritative and must not be overwritten here.
        await session.commit()
        return {"ok": True, "item": _item_api(row), "updated": False}
    existing = extra.get("soduWorkSource")
    if isinstance(existing, dict) and str(existing.get("type") or "") not in ("", "upload"):
        await session.commit()
        return {"ok": True, "item": _item_api(row), "updated": False}
    extra.update(_source_extra(source))
    row.extra = extra
    await session.commit()
    await session.refresh(row)
    return {"ok": True, "item": _item_api(row), "updated": True}


@router.get("/items/{item_id}/content")
async def read_library_content(item_id: str, preview: bool = Query(False), client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    row = await _owned_item(session, _owner_key(client), item_id)
    try:
        result = await library_preview.read_item(row, _storage_call, _item_backend(row), preview=preview)
    except HTTPException:
        raise
    except library_storage.LibraryStorageError as exc:
        raise _storage_http_error(exc) from exc
    except (UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(415, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(404, "资料对象不存在") from exc
    return {"ok": True, "item": _item_api(row), **result}


@router.get("/items/{item_id}/archive")
async def list_library_archive(item_id: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    row = await _owned_item(session, _owner_key(client), item_id)
    try:
        archive = await library_archive.read_item(row, _storage_call, _item_backend(row))
    except library_storage.LibraryStorageError as exc:
        raise _storage_http_error(exc) from exc
    return {"ok": True, "archive": archive}


@router.get("/items/{item_id}/archive/file")
async def read_library_archive_file(item_id: str, path: str = Query(..., min_length=1, max_length=1024),
                                    preview: bool = Query(False), client: Client = Depends(current_client),
                                    session: AsyncSession = Depends(get_session)):
    row = await _owned_item(session, _owner_key(client), item_id)
    try:
        result = await library_archive.read_item(row, _storage_call, _item_backend(row), member=path, preview=preview)
    except library_storage.LibraryStorageError as exc:
        raise _storage_http_error(exc) from exc
    if preview:
        return {"ok": True, **result}
    from .deliveries import _download
    entry, content = result
    return _download(content, entry["filename"], entry["contentType"])


@router.get("/items/{item_id}/download")
async def download_library_item(item_id: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    row = await _owned_item(session, _owner_key(client), item_id)
    # Viewing a file must not change its content-modification timestamp.
    # The SQL self-assignment also preserves a concurrent editor's newer date.
    await session.execute(update(LibraryItem).where(
        LibraryItem.id == row.id, LibraryItem.owner_key == row.owner_key
    ).values(last_opened_at=datetime.now(timezone.utc), updated_at=LibraryItem.updated_at))
    await session.commit()
    if isinstance((row.extra or {}).get("soduWorkDelivery"), dict):
        from ..services import delivery_collections
        from .deliveries import _download
        try:
            data = await delivery_collections.read_payload(row)
        except library_storage.LibraryStorageError as exc:
            raise _storage_http_error(exc) from exc
        return _download(data, row.filename, row.content_type)
    try:
        stream = await asyncio.to_thread(_storage_call, "open_stream", row.storage_key,
                                         backend=_item_backend(row))
    except library_storage.LibraryStorageError as exc:
        raise _storage_http_error(exc) from exc
    except Exception as exc:
        raise HTTPException(404, "资料对象不存在") from exc
    from urllib.parse import quote
    return StreamingResponse(library_storage.iter_stream(stream), media_type=row.content_type or "application/octet-stream",
                             headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(row.filename or row.title)}",
                                      "Content-Length": str(max(0, int(row.size or 0))),
                                      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})


@router.delete("/items/{item_id}")
async def delete_library_item(item_id: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    row = await _owned_item(session, _owner_key(client), item_id)
    # Deletion first moves metadata to the user's recycle bin.  The object is
    # retained in its persisted backend until purge, making this action undoable.
    row.deleted_at = datetime.now(timezone.utc)
    row.favorite = False
    await session.commit()
    await session.refresh(row)
    return {"ok": True, "item": _item_api(row), "trashed": True}


@router.post("/items/{item_id}/restore")
async def restore_library_item(item_id: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    async with library_conversation_save.save_lock(session, _owner_key(client), library_names.LOCK_KEY):
        return await _restore_library_item(item_id, client, session)


async def _restore_library_item(item_id, client, session):
    owner = _owner_key(client)
    row = await _owned_item(session, owner, item_id, include_deleted=True)
    if row.deleted_at is None:
        raise HTTPException(409, "资料不在回收站中")
    # A folder can have been removed while an item was in trash.  In that case
    # restoring to the root is safer than reviving a dangling folder reference.
    if row.folder_id:
        folder_exists = (await session.execute(select(func.count(LibraryFolder.id)).where(
            LibraryFolder.id == row.folder_id, LibraryFolder.owner_key == owner,
            LibraryFolder.backend == row.backend))).scalar_one()
        if not folder_exists:
            row.folder_id = None
    # Conversation outputs are distinct retained revisions and may legitimately
    # share names. Restoring an older revision must not discard that capability.
    if not library_conversation_save.conversation_id(row):
        await library_names.ensure_available(session, owner, row.backend, row.folder_id, row.title, row.filename, row.id)
    row.deleted_at = None
    await session.commit()
    await session.refresh(row)
    return {"ok": True, "item": _item_api(row), "restored": True}


@router.delete("/items/{item_id}/purge")
async def purge_library_item(item_id: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)):
    row = await _owned_item(session, _owner_key(client), item_id, include_deleted=True)
    if row.deleted_at is None:
        raise HTTPException(409, "只能彻底删除回收站中的资料")
    try:
        await asyncio.to_thread(_storage_call, "delete", row.storage_key,
                                backend=_item_backend(row))
    except library_storage.LibraryStorageError as exc:
        raise _storage_http_error(exc) from exc
    await session.delete(row)
    await session.commit()
    return {"ok": True, "purged": True}


@router.delete("/trash")
async def empty_library_trash(storage: str = Query(""), client: Client = Depends(current_client),
                              session: AsyncSession = Depends(get_session)):
    owner = _owner_key(client)
    selected_backend = _select_storage(storage)
    clauses = [LibraryItem.owner_key == owner, LibraryItem.deleted_at.is_not(None)]
    if selected_backend:
        clauses.append(LibraryItem.backend == selected_backend)
    rows = (await session.execute(select(LibraryItem).where(*clauses))).scalars().all()
    purged = 0
    last_error = None
    for row in rows:
        try:
            await asyncio.to_thread(_storage_call, "delete", row.storage_key,
                                    backend=_item_backend(row))
        except Exception as exc:
            # Keep metadata if the object backend is temporarily unavailable;
            # the user can retry emptying trash without losing the record.
            last_error = exc
            continue
        await session.delete(row)
        purged += 1
    if rows and not purged and last_error:
        raise _storage_http_error(last_error) from last_error
    await session.commit()
    return {"ok": True, "purged": purged, "remaining": len(rows) - purged,
            "partial": bool(last_error)}
