"""Create a conversation directly on an authorized remote Runner."""
import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from ..db import get_session
from ..deps import current_ai_client
from ..services import cloud_conversations as svc

router = APIRouter(prefix="/api/v1/cloud-conversations", tags=["cloud-conversations"])


@router.post("/{request_id}")
async def create(request_id: str, options: str = Form(...),
                 files: list[UploadFile] = File(default=[]),
                 client=Depends(current_ai_client), session=Depends(get_session)):
    if len(options) > 250000:
        raise HTTPException(413, "云端会话说明过长")
    try:
        raw = json.loads(options)
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "云端会话选项必须是 JSON 对象") from exc
    return await svc.create(session, client, request_id, raw, files)
