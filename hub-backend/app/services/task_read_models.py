"""Bounded SQL read models for the AI team; never fetch task transcripts to paginate."""
from sqlalchemy import func, select
from sqlalchemy.orm import load_only

from ..models import Attachment, Client, Task, TaskEvent
from . import task_access
from .ai_exec import KINDS_DISPATCHED


async def agent_task_page(session, client_id: str, agent: str, scope: str,
                          offset: int, limit: int, *, client: Client | None = None):
    # HTTP callers already authenticated and loaded this device. Reuse that
    # request's account snapshot instead of adding a redundant SQL query.
    if client is None:
        client = await session.get(Client, client_id)
    if client is None or client.id != client_id:
        return [], 0, {}
    conditions = [task_access.owner_clause(client)]
    if scope == "done":
        conditions.append(Task.status.in_(("done", "cancel")))
    elif scope == "live":
        conditions.append(Task.status.not_in(("done", "cancel")))
    # Rank ONLY this device's tasks, and ONLY dispatch events. Repeated dispatches
    # must not duplicate cards or accidentally match an earlier Agent assignment.
    ranked = select(
        TaskEvent.id.label("event_id"),
        func.row_number().over(
            partition_by=TaskEvent.task_id,
            order_by=(TaskEvent.at.desc(), TaskEvent.id.desc()),
        ).label("position"),
    ).join(Task, Task.id == TaskEvent.task_id).where(
        *conditions, TaskEvent.kind.in_(KINDS_DISPATCHED),
    ).subquery()
    latest = [ranked.c.position == 1]
    if agent:
        name = func.coalesce(func.nullif(func.trim(
            TaskEvent.detail["assigneeName"].as_string(), " \t\r\n"), ""), "未署名")
        latest.append(name == agent)
    joined = select(Task, TaskEvent).join(
        TaskEvent, TaskEvent.task_id == Task.id,
    ).join(ranked, ranked.c.event_id == TaskEvent.id).where(*latest)
    total = await session.scalar(select(func.count()).select_from(
        joined.with_only_columns(Task.id).subquery()))
    rows = (await session.execute(joined.options(load_only(
        Task.id, Task.title, Task.status, Task.reviewed_at,
        Task.reviewed_by_name, Task.artifact_url,
    )).order_by(TaskEvent.at.desc(), TaskEvent.id.desc(), Task.id.desc())
        .offset(offset).limit(limit))).all()
    counts = {}
    if rows:
        counts = dict((await session.execute(select(
            Attachment.task_id, func.count(Attachment.id),
        ).where(
            Attachment.task_id.in_([task.id for task, _ in rows]),
            Attachment.uploaded_by.startswith("agent:"),
        ).group_by(Attachment.task_id))).all())
    return rows, int(total or 0), counts
