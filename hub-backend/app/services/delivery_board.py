"""Single data source for the operations and delivery board. Prioritize blocked work, then running
work, then recent completions. Reuse task_trace.card so gate status and card semantics match
approvals and client task details.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from . import task_trace

# Bound the number of cards because the board is polled frequently and computes node state.
# Use the paginated task hub for older history.
LIMIT = 24
RECENT_HOURS = 24

_LIVE = {"pending", "running", "waiting"}
# Items requiring intervention include failed workflows and human gates.
_ATTENTION_RUN = {"failed"}
_ATTENTION_NODE = {"waiting_human", "failed", "rework"}


def _bucket(card: dict) -> str:
    """Assign each task to one group so it is not counted as both running and needing attention."""
    stage = dict(card.get("stage") or {})
    if card.get("runState") in _ATTENTION_RUN or stage.get("state") in _ATTENTION_NODE:
        return "attention"
    if card.get("runState") in _LIVE:
        return "running"
    return "recent"


async def board(session: AsyncSession, *, task_ids: set[str] | None = None,
                limit: int = LIMIT) -> dict:
    """Return three card groups and counts for the delivery board. task_ids=None means unrestricted
    scope; otherwise restrict to those tasks.
    """
    since = datetime.now(timezone.utc) - timedelta(hours=RECENT_HOURS)
    q = select(am.WorkflowRun).order_by(am.WorkflowRun.created_at.desc()).limit(200)
    if task_ids is not None:
        q = q.where(am.WorkflowRun.task_id.in_(task_ids or {"__none__"}))
    runs = list((await session.execute(q)).scalars().all())

    # Use only the latest workflow attempt per task.
    seen: set[str] = set()
    picked: list[am.WorkflowRun] = []
    for run in runs:
        if run.task_id in seen:
            continue
        finished = run.finished_at
        if finished is not None and finished.replace(tzinfo=finished.tzinfo or timezone.utc) < since \
                and run.state not in _LIVE:
            continue                      # Exclude workflows completed more than a day ago from this board.
        seen.add(run.task_id)
        picked.append(run)
        if len(picked) >= limit:
            break

    groups: dict[str, list[dict]] = {"attention": [], "running": [], "recent": []}
    for run in picked:
        task = await session.get(models.Task, run.task_id)
        if task is None:
            continue                      # Skip workflows whose task no longer exists.
        card = await task_trace.card(session, task)
        card["runId"] = card.get("runId") or run.id
        groups[_bucket(card)].append(card)

    done_today = sum(1 for x in groups["recent"] if x.get("runState") == "succeeded")
    return {
        "attention": groups["attention"],
        "running": groups["running"],
        "recent": groups["recent"][:8],
        "counts": {"attention": len(groups["attention"]),
                   "running": len(groups["running"]),
                   "doneToday": done_today},
        "windowHours": RECENT_HOURS,
    }
