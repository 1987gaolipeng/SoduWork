"""Employee daily/weekly reports and hierarchical team summaries for managers."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_ai_client, current_client
from ..models import Client, TeamDailyReport, User
from ..services import audit, rbac, team as team_service
from ..services import team_daily_report as team_reports
from ..services import work_report

router = APIRouter(prefix="/api/v1/reports", tags=["work-reports"])


async def _actor(session: AsyncSession, client: Client) -> User:
    user = await session.get(User, client.user_ref) if client.user_ref else None
    if user is None or not user.is_active:
        raise HTTPException(status_code=400, detail="本 SoduWork 尚未绑定有效员工，请让管理员分配归属")
    return user


def _period(kind: str, anchor: str) -> dict:
    try:
        return work_report.period_info(kind, anchor)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


async def _capability(session: AsyncSession, user: User) -> dict:
    return {
        "assigned": bool(user.org_id),
        "canManage": await team_service._can_manage(session, user),
        "meId": user.id,
        "meName": user.display_name or user.username,
        "orgId": user.org_id or "",
    }


async def _mine(session: AsyncSession, user: User, info: dict) -> dict:
    report = await work_report.find_report(
        session, user.id, info["type"], info["start"])
    material = await work_report.collect_period(
        session, user.id, info["type"], info["start"])
    return {
        "report": work_report.to_api(report) if report else None,
        "hasMaterial": bool(material["items"] or material.get("open")),
        "doneCount": len(material["done"]),
        "activeCount": len(material["items"]),
        "progressCount": int(material["progressCount"] or 0),
        "openCount": len(material.get("open") or []),
    }


@router.get("")
async def get_reports(
    period: str = "daily", anchor: str = "", scope: str = "mine",
    org_id: str = Query(default="", alias="orgId"),
    client: Client = Depends(current_client), session: AsyncSession = Depends(get_session),
):
    """Read the employee's personal report or team summaries within their management scope."""
    user = await _actor(session, client)
    info = _period(period, anchor)
    capability = await _capability(session, user)
    if scope == "mine":
        return {"scope": "mine", "period": info, "capability": capability,
                "personal": await _mine(session, user, info)}
    if scope != "team":
        raise HTTPException(status_code=400, detail="scope 只支持 mine 或 team")
    if not capability["canManage"]:
        raise HTTPException(status_code=403, detail="你当前没有团队简报查看权限")
    try:
        team = await team_reports.overview(
            session, user, info["start"], org_id, info["type"])
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    return {"scope": "team", "period": info, "capability": capability, "team": team}


@router.post("/generate")
async def generate_reports(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_ai_client), session: AsyncSession = Depends(get_session),
):
    """Refresh a personal report or the selected team's complete fact tree."""
    user = await _actor(session, client)
    info = _period(str(body.get("period") or "daily"), str(body.get("anchor") or ""))
    scope = str(body.get("scope") or "mine")
    if scope == "mine":
        report = await work_report.generate_for(
            session, user, info["start"], notify=False, period_type=info["type"])
        if report is None:
            raise HTTPException(status_code=400, detail="这个周期还没有需求事实，暂时无法生成简报")
        await audit.log(session, user, "report.generate", "personal_report", report.id,
                        info["label"], {"period": info["type"], "via": "client"})
        return {"ok": True, "report": work_report.to_api(report)}
    if scope != "team":
        raise HTTPException(status_code=400, detail="scope 只支持 mine 或 team")
    if not await team_service._can_manage(session, user):
        raise HTTPException(status_code=403, detail="你当前没有团队简报刷新权限")

    full_scope = await rbac.scope_org_ids(session, user)
    focus = str(body.get("orgId") or user.org_id or "")
    if focus and full_scope is not None and focus not in full_scope:
        raise HTTPException(status_code=403, detail="该团队不在你的管理范围内")
    target_scope = await rbac.subtree_org_ids(session, focus) if focus else full_scope
    if full_scope is not None:
        target_scope = set(target_scope or set()) & set(full_scope)
    query = select(User).where(User.is_active.is_(True))
    if target_scope is not None:
        query = query.where(User.org_id.in_(target_scope or {"__none__"}))
    targets = list((await session.execute(query)).scalars().all())

    made, skipped = 0, 0
    for target in targets:
        try:
            report = await work_report.generate_for(
                session, target, info["start"], notify=False, period_type=info["type"])
            made += int(report is not None)
            skipped += int(report is None)
        except Exception:  # noqa: BLE001  One member's failure must not abort the team refresh.
            await session.rollback()
            skipped += 1
    teams = await team_reports.generate_scope(
        session, info["start"], target_scope, force=True, period_type=info["type"])
    await audit.log(session, user, "report.generate", "team_report", focus or None,
                    info["label"], {"period": info["type"], "made": made,
                                    "skipped": skipped, "teams": len(teams), "via": "client"})
    return {"ok": True, "made": made, "skipped": skipped, "teamReports": len(teams)}


@router.post("/team/{report_id}/confirm")
async def confirm_team_report(
    report_id: str, body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client), session: AsyncSession = Depends(get_session),
):
    """Confirm a team fact snapshot; source changes invalidate the confirmation."""
    user = await _actor(session, client)
    if not await team_service._can_manage(session, user):
        raise HTTPException(status_code=403, detail="你当前没有团队简报确认权限")
    report = await session.get(TeamDailyReport, report_id)
    if report is None:
        raise HTTPException(status_code=404, detail="团队简报不存在")
    try:
        confirmed = await team_reports.confirm(
            session, user, report_id, str(body.get("note") or ""))
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    await audit.log(session, user, "report.team_confirm", "team_report", confirmed.id,
                    confirmed.org_name, {"period": confirmed.period_type,
                                         "date": confirmed.date, "via": "client"})
    return team_reports.to_api(confirmed)
