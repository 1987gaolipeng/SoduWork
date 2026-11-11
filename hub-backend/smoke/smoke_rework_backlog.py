# -*- coding: utf-8 -*-
"""Offline rejection-destination tests: direct tasks may return to todo/backlog with cleared rework
markers and audit events; workflow-owned tasks retain engine rollback semantics. Preserve the
automatic-rework fallback for missing session refs.
"""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-rework-backlog.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import task_events, task_rework  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra) if extra else ""))


TID = "smoke-backlog-task"
WID = "smoke-backlog-workflow"
UID = "smoke-backlog-user"
CID = "smoke-backlog-client"


async def events_of(session, task_id, kind):
    res = await session.execute(select(models.TaskEvent).where(
        models.TaskEvent.task_id == task_id,
        models.TaskEvent.kind == kind))
    return list(res.scalars())


async def seed():
    from app.services import device_auth
    async with SessionLocal() as session:
        user = models.User(id=UID, username="smoke-backlog",
                           display_name="退回去向冒烟", is_active=True)
        box = models.Client(id=CID, name="退回去向冒烟 SoduWork")
        box.secret_hash = device_auth.hash_secret("smoke-secret")
        device_auth.activate(box, user)
        direct = models.Task(
            id=TID, title="退回待开始冒烟（直连 AI）", note="验收退回但不自动返修",
            owner_client_id=CID, created_by=UID, created_by_name="冒烟",
            requester_user_id=UID, assignee_user_id=UID, status="doing")
        routing = dict(direct.work_routing or {})
        routing["reworkPending"] = {"feedback": "上一轮返修没启动", "ref": "stale"}
        direct.work_routing = routing
        workflow = models.Task(
            id=WID, title="退回待开始冒烟（工作流接管）", note="引擎接管中不许强拽",
            owner_client_id=CID, created_by=UID, created_by_name="冒烟",
            requester_user_id=UID, assignee_user_id=UID, status="doing")
        session.add_all([user, box, direct, workflow])
        await session.flush()
        session.add(am.WorkflowRun(id="smoke-backlog-run", task_id=WID,
                                   plugin_id="smoke-plugin",
                                   plugin_version_id="smoke-ver",
                                   state="waiting_human"))
        await session.commit()


async def main() -> int:
    await init_db()
    await seed()

    # Return a direct AI task to unstarted backlog.
    async with SessionLocal() as session:
        task = await session.get(models.Task, TID)
        out = await task_rework.return_to_backlog(
            session, task, "方向不对，重新安排", request_id="req-1", actor="验收人")
        fresh = await session.get(models.Task, TID)
        chk("响应标记 mode=backlog 且 started", out.get("mode") == "backlog"
            and out.get("started") is True, out)
        chk("任务状态退回 todo", fresh.status == "todo", fresh.status)
        chk("回到需求池（triage_stage=ready）", fresh.triage_stage == "ready",
            fresh.triage_stage)
        routing = dict(fresh.work_routing or {})
        chk("清掉遗留的 reworkPending", "reworkPending" not in routing, routing)
        chk("留痕 review.returned_to_backlog（含退回说明）",
            any((e.detail or {}).get("feedback") == "方向不对，重新安排"
                for e in await events_of(session, TID, "review.returned_to_backlog")),
            [dict(e.detail or {}) for e in await events_of(session, TID, "review.returned_to_backlog")])

    # Preserve workflow ownership and record skipped backlog handling.
    async with SessionLocal() as session:
        task = await session.get(models.Task, WID)
        out = await task_rework.return_to_backlog(
            session, task, "退回待开始", request_id="req-2", actor="验收人")
        fresh = await session.get(models.Task, WID)
        chk("引擎接管时响应 mode=workflow 且未启动", out.get("mode") == "workflow"
            and out.get("started") is False, out)
        chk("引擎接管时状态未被强改（仍在 doing）", fresh.status == "doing", fresh.status)
        chk("引擎接管时记 review.backlog_skipped_engine 留痕",
            bool(await events_of(session, WID, "review.backlog_skipped_engine")),
            [e.kind for e in await events_of(session, WID, "review.backlog_skipped_engine")])

    # Missing refs still yield a manual fallback rather than crashing automatic rework.
    async with SessionLocal() as session:
        task = await session.get(models.Task, TID)
        out = await task_rework.resume_after_rejection(
            session, task, "改一下文案", request_id="req-3", actor="验收人")
        chk("自动返修旧路径行为不变（无 ref → 人工兜底）",
            out.get("started") is False and out.get("error"), out)

    try:
        os.remove(DB)
    except OSError:
        pass
    print("\nrework backlog smoke: %d passed, %d failed" % (ok, fail))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
