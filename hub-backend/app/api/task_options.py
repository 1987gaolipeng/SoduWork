"""Project, workflow, and executor choices for client task creation."""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_client
from ..models import Client
from ..services import task_execution_options

router = APIRouter(prefix="/api/v1", tags=["tasks"])


@router.post("/task-execution-options")
async def execution_options(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    try:
        return await task_execution_options.build(session, client, body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
