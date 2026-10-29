"""Safe cleanup for exceptional tasks shown on the AI team workbench.

The workbench is a live operational view.  Cleaning an exceptional card must
therefore stop it from reappearing without deleting the task, execution trace,
or evidence that may be needed to diagnose the failure.  The cleanup operation
uses the canonical task status transition and records a timeline event.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from . import task_access, task_events, task_status
from .tasks import task_to_api_live


ABNORMAL_PHASES = frozenset(("failed",))


async def cleanup_abnormal(
    session: AsyncSession,
    client: models.Client,
    view: dict,
) -> dict:
    """Cancel failed AI-team tasks while preserving their complete history.

    The view is built immediately before this call, so phase detection uses the
    same durable execution facts the user just saw.  Only the owning client is
    queried again and terminal tasks are ignored.  Running, dispatching and
    human-review tasks are deliberately left alone; they are not failures and
    cancelling them would race an active runner or discard a pending decision.
    """
    items = list((view or {}).get("tasks") or [])
    candidate_ids = {
        str(item.get("id") or "")
        for item in items
        if item.get("phase") in ABNORMAL_PHASES and item.get("id")
    }
    if not candidate_ids:
        return {"ok": True, "cleaned": [], "skipped": [], "candidateCount": 0}

    rows = list((await session.execute(
        select(models.Task).where(
            task_access.owner_clause(client),
            models.Task.id.in_(candidate_ids),
        ).with_for_update()
    )).scalars().all())
    by_id = {row.id: row for row in rows}
    cleaned: list[str] = []
    skipped: list[str] = []
    phase_by_id = {
        str(item.get("id")): str(item.get("phase") or "")
        for item in items if item.get("id")
    }
    for tid in sorted(candidate_ids):
        task = by_id.get(tid)
        # A completed/cancelled task may have changed between the read view and
        # this write.  Never turn a terminal business result into a cancellation.
        if task is None or task.status in ("done", "cancel"):
            skipped.append(tid)
            continue
        previous = task.status
        if not await task_status.mark(
            session,
            task,
            "cancel",
            engine=True,
            why="ai_team_one_click_cleanup",
        ):
            skipped.append(tid)
            continue
        task_events.record(
            session,
            tid,
            "ai.cleanup_abnormal",
            {
                "phase": phase_by_id.get(tid, "failed"),
                "previousStatus": previous,
                "reason": "one_click_workbench_cleanup",
            },
            actor="SoduWork",
        )
        cleaned.append(tid)

    if cleaned:
        await session.commit()
        # Keep other windows and related participants in sync.  The live view
        # cache is invalidated by the API after this function returns.
        for tid in cleaned:
            task = by_id[tid]
            await task_access.publish_task(
                session,
                task,
                "task.updated",
                await task_to_api_live(session, task),
            )

    return {
        "ok": True,
        "cleaned": cleaned,
        "skipped": skipped,
        "candidateCount": len(candidate_ids),
    }
