"""Task evaluation and controlled-evolution endpoints.

The client owns day-to-day task evaluation and may accept a proposal for its own task.  The
admin side uses the existing task scope and plugin-management permission.  Neither surface can
edit a live workflow through these endpoints.
"""
from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_client, require_perm
from ..models import Client, Task, User
from ..services import audit, task_access, task_evolution
from .scope import task_or_404

router = APIRouter(prefix="/api/v1", tags=["task-evolution"])
admin_router = APIRouter(prefix="/api/v1/admin", tags=["task-evolution"])


async def _my_task(session: AsyncSession, client: Client, tid: str) -> Task:
    return await task_access.require_owned_task(session, client, tid)


async def _client_actor(session: AsyncSession, client: Client) -> tuple[str, str]:
    user = await session.get(User, client.user_ref) if client.user_ref else None
    actor_id = user.id if user else "client:" + client.id
    actor_name = ((user.display_name or user.username) if user else (client.name or client.id))
    return actor_id, actor_name


def _bad(error: Exception) -> HTTPException:
    if isinstance(error, LookupError):
        return HTTPException(status_code=404, detail=str(error))
    return HTTPException(status_code=409, detail=str(error))


@router.put("/tasks/{tid}/evaluation")
async def save_my_evaluation(tid: str, body: dict = Body(default_factory=dict),
                             client: Client = Depends(current_client),
                             session: AsyncSession = Depends(get_session)):
    task = await _my_task(session, client, tid)
    actor_id, actor_name = await _client_actor(session, client)
    try:
        return await task_evolution.evaluate(
            session, task, body, actor_id=actor_id, actor_name=actor_name)
    except ValueError as error:
        raise _bad(error) from error


@router.post("/tasks/{tid}/evolution/{proposal_id}/decision")
async def decide_my_proposal(tid: str, proposal_id: str,
                             body: dict = Body(default_factory=dict),
                             client: Client = Depends(current_client),
                             session: AsyncSession = Depends(get_session)):
    task = await _my_task(session, client, tid)
    actor_id, actor_name = await _client_actor(session, client)
    try:
        return await task_evolution.decide(
            session, task, proposal_id, str(body.get("decision") or ""),
            str(body.get("note") or ""), actor_id=actor_id, actor_name=actor_name)
    except (ValueError, LookupError) as error:
        raise _bad(error) from error


@admin_router.put("/tasks/{tid}/evaluation")
async def save_admin_evaluation(tid: str, body: dict = Body(default_factory=dict),
                                user: User = Depends(require_perm("task.view")),
                                session: AsyncSession = Depends(get_session)):
    task = await task_or_404(session, user, tid)
    try:
        result = await task_evolution.evaluate(
            session, task, body, actor_id=user.id,
            actor_name=user.display_name or user.username)
    except ValueError as error:
        raise _bad(error) from error
    await audit.log(session, user, "task.evaluate", "task", task.id, task.title,
                    {"outcome": body.get("outcome"), "score": body.get("score")})
    return result


@admin_router.post("/tasks/{tid}/evolution/{proposal_id}/decision")
async def decide_admin_proposal(tid: str, proposal_id: str,
                                body: dict = Body(default_factory=dict),
                                user: User = Depends(require_perm("plugin.manage")),
                                session: AsyncSession = Depends(get_session)):
    task = await task_or_404(session, user, tid)
    try:
        result = await task_evolution.decide(
            session, task, proposal_id, str(body.get("decision") or ""),
            str(body.get("note") or ""), actor_id=user.id,
            actor_name=user.display_name or user.username)
    except (ValueError, LookupError) as error:
        raise _bad(error) from error
    await audit.log(session, user, "evolution." + str(body.get("decision") or ""),
                    "evolution_proposal", proposal_id, task.title,
                    {"taskId": task.id, "note": str(body.get("note") or "")[:300]})
    return result


@admin_router.post("/tasks/{tid}/evolution/{proposal_id}/apply")
async def apply_admin_proposal(tid: str, proposal_id: str,
                               body: dict = Body(default_factory=dict),
                               user: User = Depends(require_perm("plugin.manage")),
                               session: AsyncSession = Depends(get_session)):
    """Link a proposal to a separately imported, trusted new version; never edits one in place."""
    task = await task_or_404(session, user, tid)
    try:
        result = await task_evolution.mark_applied(
            session, task, proposal_id, str(body.get("pluginVersionId") or ""),
            actor_id=user.id, actor_name=user.display_name or user.username)
    except (ValueError, LookupError) as error:
        raise _bad(error) from error
    await audit.log(session, user, "evolution.applied", "evolution_proposal", proposal_id,
                    task.title, {"taskId": task.id,
                                 "pluginVersionId": body.get("pluginVersionId")})
    return result
