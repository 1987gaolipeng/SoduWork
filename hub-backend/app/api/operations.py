"""Health and authenticated platform operations endpoints."""
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import has_perm, require_perm
from ..models import User
from ..services import operations
from . import operations_approvals
from .scope import visible_clients


router = APIRouter(tags=["operations"])
router.include_router(operations_approvals.router)


@router.get("/readyz")
async def readyz(session: AsyncSession = Depends(get_session)):
    ok, detail = await operations.database_ready(session)
    body = {"ok": ok, "checks": {"database": {"ok": ok, "detail": detail}}}
    return JSONResponse(status_code=200 if ok else 503, content=body)


@router.get("/api/v1/admin/operations/overview")
async def operations_overview(session: AsyncSession = Depends(get_session),
                              user: User = Depends(require_perm("operations.view"))):
    can_view_failures = any(has_perm(user, key) for key in ("task.view", "plugin.run", "plugin.manage"))
    return await operations.overview(session, await visible_clients(session, user),
                                     can_view_failures=can_view_failures)


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
