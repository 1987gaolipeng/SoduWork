"""Administrator lifecycle controls for user-enrolled cloud hosts."""
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from ..db import get_session
from ..deps import require_perm
from ..services import cloud_runner_admin as service

router = APIRouter(prefix="/api/v1/admin/cloud-runners", tags=["runner"])
manager = require_perm("runner.manage")


class OwnerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expectedOwnerUserId: str = Field(min_length=1, max_length=36)


class AvailabilityRequest(OwnerRequest):
    enabled: StrictBool


class TransferRequest(OwnerRequest):
    targetUserId: str = Field(min_length=1, max_length=36)


class ProvisionRequest(OwnerRequest):
    hostResetConfirmed: Literal[True]
    hub: str = Field(default="", max_length=500)
    workRoot: str = Field(min_length=1, max_length=500)


@router.get("/assignees")
async def assignees(q: str = Query(default="", max_length=80),
                    user=Depends(manager), session=Depends(get_session)):
    return await service.assignees(session, user, q)


@router.post("/{runner_id}/availability")
async def availability(runner_id: str, body: AvailabilityRequest,
                       user=Depends(manager), session=Depends(get_session)):
    return await service.availability(session, user, runner_id, body.expectedOwnerUserId, body.enabled)


@router.post("/{runner_id}/reassign")
async def reassign(runner_id: str, body: TransferRequest,
                   user=Depends(manager), session=Depends(get_session)):
    return await service.transfer(session, user, runner_id, body.expectedOwnerUserId, body.targetUserId)


@router.post("/{runner_id}/provision")
async def provision(runner_id: str, body: ProvisionRequest, request: Request,
                    user=Depends(manager), session=Depends(get_session)):
    return await service.provision(session, user, runner_id, body.expectedOwnerUserId,
                                   body.model_dump(), str(request.base_url).rstrip("/"))
