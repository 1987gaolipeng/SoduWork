"""Task collaboration comments and colleague mentions, delivered through the shared notification
channel.
"""
import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..realtime import hub
from .boxes import box_of_user

log = logging.getLogger("uvicorn.error")


def _now():
    # Use explicit microsecond timestamps; SQLite's default timestamp has only second precision.
    # This keeps comments created within one second deterministically ordered.
    return datetime.now(timezone.utc)


def comment_to_api(c: models.TaskComment) -> dict:
    from ..schemas import _ms
    return {
        "id": c.id, "taskId": c.task_id, "authorKind": c.author_kind,
        "authorId": c.author_id, "authorName": c.author_name, "body": c.body,
        "mentions": list(c.mentions or []), "at": _ms(c.created_at),
    }


async def list_comments(session: AsyncSession, task_id: str) -> list[dict]:
    rows = (await session.execute(
        select(models.TaskComment).where(models.TaskComment.task_id == task_id).order_by(models.TaskComment.created_at)
    )).scalars().all()
    return [comment_to_api(c) for c in rows]


async def add_comment(session: AsyncSession, task: models.Task, author_kind: str, author_id: str | None,
                      author_name: str, body: str, mentions: list) -> dict:
    """Record a comment and notify mentioned colleagues through their clients."""
    mentions = mentions or []
    c = models.TaskComment(task_id=task.id, author_kind=author_kind, author_id=author_id,
                           author_name=author_name or "", body=(body or "")[:4000], mentions=mentions,
                           created_at=_now())
    session.add(c)
    await session.commit()
    await session.refresh(c)
    api = comment_to_api(c)
    # Push the thread update to the client currently holding the task.
    if task.owner_client_id:
        await hub.publish(task.owner_client_id, {"type": "task.comment", "comment": api})
    snippet = (body or "").strip()[:40]
    mentioned = {m.get("id") for m in mentions if (m or {}).get("type") == "user" and m.get("id")}
    # Notify a mentioned task holder too; task.comment only updates open detail views.
    # A data update does not replace a visible mention notification.
    for uid in mentioned:
        if uid != author_id:
            box = await box_of_user(session, uid)
            if box:
                await hub.publish(box, {"type": "notice", "text": f"{author_name} 在「{task.title}」里 @了你：{snippet}"})
    # Notify the task holder of other people's comments even without a mention.
    # Avoid duplicate notifications when the holder was already mentioned.
    if task.owner_client_id:
        holder = (await session.execute(
            select(models.Client.user_ref).where(models.Client.id == task.owner_client_id)
        )).scalar_one_or_none()
        if holder and holder != author_id and holder not in mentioned:
            await hub.publish(task.owner_client_id,
                              {"type": "notice", "text": f"💬 {author_name} 在「{task.title}」留言：{snippet}"})
    return api
