"""Authenticated preparation, commit and cancellation of portable conversations."""
import json

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, UploadFile

from ..db import get_session
from ..deps import current_client
from ..services import conversation_handoffs as svc
from ..services.portable_workspace import MAX_ARCHIVE

router = APIRouter(prefix="/api/v1/conversation-handoffs", tags=["conversation-handoffs"])


@router.get("/targets")
async def targets(agent_id: str = Query(default="", alias="agentId", max_length=80),
                  client=Depends(current_client), session=Depends(get_session)):
    return await svc.target_catalog(session, client, agent_id)


@router.post("/{transfer_id}")
async def prepare(transfer_id: str, file: UploadFile = File(...), options: str = Form(...),
                  client=Depends(current_client), session=Depends(get_session)):
    if len(options) > 250000:
        raise HTTPException(413, "交接说明过长")
    try:
        raw = json.loads(options)
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "交接选项必须是 JSON 对象") from exc
    data = await file.read(MAX_ARCHIVE + 1)
    if len(data) > MAX_ARCHIVE:
        raise HTTPException(413, "工作包超过交接上限")
    return await svc.prepare(session, client, transfer_id, data, raw)


@router.get("/{transfer_id}")
async def status(transfer_id: str, client=Depends(current_client), session=Depends(get_session)):
    row = await svc.get(session, client, transfer_id)
    return svc.public(await svc.refresh(session, row))


@router.post("/{transfer_id}/commit")
async def commit(transfer_id: str, body: dict = Body(...),
                 client=Depends(current_client), session=Depends(get_session)):
    if set(body) != {"sha256"}:
        raise HTTPException(400, "确认交接只接受文件摘要")
    return await svc.commit(session, client, transfer_id, body["sha256"])


@router.post("/{transfer_id}/abort")
async def abort(transfer_id: str, client=Depends(current_client), session=Depends(get_session)):
    return await svc.abort(session, client, transfer_id)
