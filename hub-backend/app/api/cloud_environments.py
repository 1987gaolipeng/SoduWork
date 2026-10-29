"""Cloud Runner management from an authenticated desktop device."""
from fastapi import APIRouter, Body, Depends, Request

from ..db import get_session
from ..deps import current_client
from ..services import cloud_environments as service

router = APIRouter(prefix="/api/v1/cloud-environments", tags=["cloud-environments"])


@router.get("")
async def list_environments(request: Request, client=Depends(current_client), session=Depends(get_session)):
    return await service.list_environments(session, client, str(request.base_url).rstrip("/"))


@router.post("")
async def create(request: Request, body: dict = Body(...), client=Depends(current_client), session=Depends(get_session)):
    return await service.create(session, client, body, str(request.base_url).rstrip("/"))


@router.patch("/{runner_id}")
async def update(runner_id: str, body: dict = Body(...), client=Depends(current_client), session=Depends(get_session)):
    return await service.update(session, client, runner_id, body)


@router.post("/{runner_id}/credentials")
async def rotate_credentials(runner_id: str, request: Request,
                             body: dict = Body(default_factory=dict),
                             client=Depends(current_client), session=Depends(get_session)):
    return await service.rotate_credentials(session, client, runner_id, body,
                                            str(request.base_url).rstrip("/"))


@router.delete("/{runner_id}")
async def delete(runner_id: str, client=Depends(current_client), session=Depends(get_session)):
    return await service.delete(session, client, runner_id)
