"""Operational read model for enterprise plugin connector calls."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from ..db import get_session
from ..deps import require_perm
from ..models import User
from ..services import audit, rbac

router = APIRouter(prefix="/api/v1/admin/plugins", tags=["plugin-activity"])


@router.get("/{plugin_id}/activity")
async def plugin_activity(
    plugin_id: str,
    limit: int = 40,
    user: User = Depends(require_perm("plugin.manage")),
    session: AsyncSession = Depends(get_session),
):
    plugin = await session.get(am.Plugin, plugin_id)
    if plugin is None:
        raise HTTPException(status_code=404, detail="插件不存在")
    scope = await rbac.scope_org_ids(session, user)
    if scope is not None and plugin.org_id is not None and plugin.org_id not in scope:
        raise HTTPException(status_code=403, detail="这个插件不在你的组织范围内")
    binding_ids = list((await session.execute(select(am.PluginBinding.id).where(
        am.PluginBinding.plugin_id == plugin.id
    ))).scalars().all())
    version_ids = list((await session.execute(select(am.PluginVersion.id).where(
        am.PluginVersion.plugin_id == plugin.id
    ))).scalars().all())
    run_ids = list((await session.execute(select(am.WorkflowRun.id).where(
        am.WorkflowRun.plugin_id == plugin.id
    ).order_by(am.WorkflowRun.created_at.desc()).limit(2000))).scalars().all())
    calls = await audit.list_plugin_activity(
        session, user, binding_ids, limit, version_ids=version_ids)
    governance = await audit.list_plugin_governance_activity(
        session, user, plugin.id, version_ids=version_ids,
        binding_ids=binding_ids, run_ids=run_ids, limit=limit)
    return {**calls, "governance": governance}
