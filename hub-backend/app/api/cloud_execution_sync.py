"""Read cloud execution records without dispatching or settling work."""
from fastapi import APIRouter, Depends, Query

from ..db import get_session
from ..deps import current_client
from ..services import cloud_execution_sync as service

router = APIRouter(prefix="/api/v1/cloud-execution-sync", tags=["cloud-conversations"])


@router.get("")
async def directory(after: str = Query(default="", max_length=80),
                    limit: int = Query(default=50, ge=1, le=100),
                    client=Depends(current_client), session=Depends(get_session)):
    return await service.directory(session, client, after=after, limit=limit)


@router.get("/{handoff_id}")
async def detail(handoff_id: str, ref: str = Query(default="", max_length=180),
                 since: int = Query(default=0, ge=0),
                 limit: int = Query(default=400, ge=1, le=1000),
                 client=Depends(current_client), session=Depends(get_session)):
    return await service.detail(session, client, handoff_id, ref=ref, since=since, limit=limit)
