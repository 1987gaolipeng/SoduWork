"""Centralized task status transitions and authorized writers."""
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models

log = logging.getLogger("uvicorn.error")

VALID = ("todo", "doing", "done", "cancel")


async def engine_owns(session: AsyncSession, task_ids: list[str]) -> set[str]:
    """Return tasks currently owned by active workflows using the workflow module's shared
    active-state definition.
    """
    ids = [x for x in set(task_ids or []) if x]
    if not ids:
        return set()
    try:
        from .. import automation_models as am
        from .workflow_runs import _ACTIVE_RUN_STATES
    except Exception:  # noqa: BLE001 - Treat an unavailable automation layer as having no active workflow ownership.
        return set()
    res = await session.execute(
        select(am.WorkflowRun.task_id).where(
            am.WorkflowRun.task_id.in_(ids),
            am.WorkflowRun.state.in_(tuple(_ACTIVE_RUN_STATES)),
        ))
    return set(res.scalars().all())


async def mark(session: AsyncSession, task: models.Task, status: str, *,
               engine: bool = False, why: str = "",
               allow_incomplete: bool = False, refresh_memory: bool = True) -> bool:
    """Change task state without committing, returning False for invalid or unauthorized
    transitions. Apply actual start and completion timestamps centrally.
    """
    if task is None or status not in VALID:
        return False
    if status == "doing" and getattr(task, "archived_at", None):
        return False
    if task.status == status and status != "done":
        return True
    if not engine and await engine_owns(session, [task.id]):
        log.info("task %s 状态由引擎接管，忽略 %s 来的 %s", task.id, why or "非引擎写入", status)
        return False
    if status == "done" and not allow_incomplete:
        # Process exit, uploaded files, and individual successful gates do not alone complete a task.
        # Every done transition must use the same delivery facts.
        from . import delivery_truth
        truth = await delivery_truth.evaluate(session, task)
        if not truth.get("canComplete"):
            codes = ",".join(str(x.get("code") or "") for x in truth.get("blockers") or [])
            log.info("task %s 交付事实尚不支持办结，忽略 %s（%s）", task.id, why or "状态写入", codes)
            return False
    if task.status == status:
        return True
    prev = task.status
    from . import requirement_edit_policy
    requirement_edit_policy.preserve_manual_history(session, task, prev, status)
    task.status = status
    from . import tasks as tsvc
    tsvc.stamp_actual(task, prev, status)
    if status == "done":
        await _close_batch_members(session, task, engine=engine)
        from . import project_context
        await project_context.accept_task_capsules(session, task)
    task.archived_at = None
    # State changes do not increment the requirements definition version.
    # requirement_version is a content optimistic lock, not an activity counter.
    # Content-edit paths increment it; execution updates must not create false edit conflicts.
    if refresh_memory:
        from . import task_requirements
        await task_requirements.refresh_memory(session, task)
    return True


async def rejection(session: AsyncSession, task: models.Task, status: str, *,
                    engine: bool = False) -> dict:
    """Explain a rejected transition without changing task state."""
    if task is None or status not in VALID:
        return {"code": "invalid_status", "message": "需求状态不正确"}
    if status == "doing" and getattr(task, "archived_at", None):
        return {"code": "requirement_archived", "message": "请先恢复已归档的需求，再安排执行"}
    if not engine and await engine_owns(session, [task.id]):
        return {
            "code": "engine_managed",
            "message": "需求正在由自动化流程推进，请在执行详情中处理或等待当前阶段完成",
        }
    if status == "done":
        from . import delivery_truth
        truth = await delivery_truth.evaluate(session, task)
        if not truth.get("canComplete"):
            blockers = list(truth.get("blockers") or [])
            labels = "、".join(str(x.get("title") or x.get("detail") or "交付条件未满足")
                              for x in blockers[:3])
            return {
                "code": "delivery_incomplete",
                "message": "需求还不能完成" + (("：" + labels) if labels else ""),
                "blockers": blockers[:5],
            }
    return {"code": "not_applied", "message": "需求状态没有改变，请刷新后重试"}


async def _close_batch_members(session: AsyncSession, batch: models.Task, *,
                               engine: bool) -> None:
    """Propagate batch-shell completion to unfinished source tasks through the shared state
    lifecycle. Stay in the caller's transaction; idempotent terminal checks prevent recursive
    cycles.
    """
    ms = (await session.execute(select(models.Milestone).where(
        models.Milestone.task_id == batch.id))).scalars().all()
    src_ids = [str(m.src_task_id or "").strip() for m in ms]
    src_ids = [x for x in src_ids if x and x != batch.id]
    if not src_ids:
        return
    from . import task_events
    for sid in src_ids:
        t = await session.get(models.Task, sid)
        if t is None or t.status in ("done", "cancel"):
            continue
        # The batch shell owns the one reviewed delivery for all source items. Requiring every
        # imported bug to manufacture a second artifact would leave them permanently open.
        # This bypass is deliberately scoped to immutable src_task_id members.
        if await mark(session, t, "done", engine=engine, why="批次办结回流",
                      allow_incomplete=True):
            task_events.record(session, sid, "ai.batch_done",
                               {"batchId": batch.id, "via": "batch_close"}, actor="SoduWork")
