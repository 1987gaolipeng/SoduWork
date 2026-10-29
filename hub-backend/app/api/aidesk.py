"""Public module behavior and service contracts."""
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from ..db import get_session
from ..deps import current_client
from ..models import Client, User
from ..services import agent_naming, execution_aliases

router = APIRouter(prefix="/api/v1", tags=["aidesk"])

@router.get("/ai-agent-tasks")
async def ai_agent_tasks(
    agent: str = Query(default="", description="agent 显示名；空=不限"),
    scope: str = Query(default="done", pattern="^(done|live|all)$"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """List this client's tasks by latest dispatch time. Match agents using the latest event's
    assigneeName, consistent with /ai-desks, and retain unidentified tasks under the unnamed
    group.
    """
    from ..services.task_read_models import agent_task_page

    want = (agent or "").strip()
    rows, total, art_n = await agent_task_page(
        session, client.id, want, scope, offset, limit, client=client)
    page = [(task, event.detail or {}, event.at.isoformat() if event.at else "")
            for task, event in rows]

    items = []
    for t, d, at in page:
        items.append({
            "id": t.id,
            "title": t.title,
            "status": t.status,
            "at": _iso_utc_str(at),
            "identifier": d.get("identifier", ""),
            "ref": d.get("ref") or d.get("issueId", ""),
            "agent": (d.get("assigneeName") or "").strip() or "未署名",
            "cli": d.get("assigneeCli") or "",
            "reviewed": bool(getattr(t, "reviewed_at", None)),
            "reviewedBy": getattr(t, "reviewed_by_name", "") or "",
            # Determine delivery from local output URLs and returned attachments without network probes.
            "delivered": bool((getattr(t, "artifact_url", "") or "").strip())
            or art_n.get(t.id, 0) > 0,
            "artifacts": art_n.get(t.id, 0),
            # Both local UUIDs and managed work-order IDs use ref to retrieve session state.
            # The ai-session endpoint reports whether the session can actually be retrieved.
            "hasSession": bool(d.get("ref") or d.get("issueId")),
        })
    return {"items": items, "total": total, "offset": offset, "limit": limit,
            "hasMore": offset + len(page) < total, "agent": want}


@router.get("/execution-names")
async def get_execution_names(
    client: Client = Depends(current_client),          # noqa: ARG001  Required for authentication only.
    session: AsyncSession = Depends(get_session),
):
    """Return custom machine and agent names for the rename form."""
    return await execution_aliases.load(session)


@router.put("/execution-names")
async def put_execution_name(
    body: dict = Body(default_factory=dict),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Behavior and constraints for this operation."""
    scope = str(body.get("scope") or "").strip()
    key = str(body.get("key") or "").strip()
    mkey = key.rsplit("|", 1)[0] if scope == "agent" else key
    await _guard_machine(session, client, mkey)
    try:
        data = await execution_aliases.set_name(session, scope, key, body.get("name") or "")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await session.commit()
    return {"ok": True, **data}


async def _guard_machine(session: AsyncSession, client: Client, machine_key: str) -> None:
    """Check whether the caller may rename this machine."""
    if not machine_key:
        raise HTTPException(status_code=422, detail="没说清要给哪台机器改名")
    rows = list((await session.execute(select(am.RunnerNode))).scalars().all())
    mine = [r for r in rows
            if agent_naming.machine_key(host=r.host or "", runner_id=r.id) == machine_key]
    if not mine:
        return                                  # Local executors and retired machines have no owner to check.
    if any(r.client_id == client.id for r in mine):
        return
    owner = await session.get(User, client.user_ref) if client.user_ref else None
    if owner and owner.is_super:
        return
    raise HTTPException(status_code=403, detail="只能给自己的执行机改名")


def _iso_utc_str(s: str) -> str:
    """Append +00:00 to naive UTC dispatch timestamps so JavaScript does not interpret them in the
    client's local timezone.
    """
    if not s:
        return ""
    if s.endswith("Z") or "+" in s[10:] or s[10:].count("-") > 0:
        return s                                        # An explicit timezone offset is already present.
    return s + "+00:00"
