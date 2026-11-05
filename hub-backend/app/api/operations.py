"""Health and authenticated platform operations endpoints."""
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import require_perm
from ..services import operations


router = APIRouter(tags=["operations"])


@router.get("/readyz")
async def readyz(session: AsyncSession = Depends(get_session)):
    ok, detail = await operations.database_ready(session)
    body = {"ok": ok, "checks": {"database": {"ok": ok, "detail": detail}}}
    return JSONResponse(status_code=200 if ok else 503, content=body)


@router.get("/api/v1/admin/operations/overview",
            dependencies=[Depends(require_perm("operations.view"))])
async def operations_overview(session: AsyncSession = Depends(get_session)):
    return await operations.overview(session)


@router.get("/api/v1/admin/operations/insights",
            dependencies=[Depends(require_perm("operations.view"))])
async def operations_insights(session: AsyncSession = Depends(get_session)):
    """Read-only operational analytics for adoption, plugin usage, automation health, and outputs.

    """
    from ..services.operations_insights_cache import get_insights
    bind = session.bind
    # Authentication already succeeded. Return its read connection before waiting
    # on another reader's build; the shared task owns a separate session.
    await session.rollback()
    return await get_insights(bind)
