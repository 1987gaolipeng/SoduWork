# -*- coding: utf-8 -*-
"""Smoke-test exclusive task claims, immediate inbox delivery, and preserved AI execution state."""
import asyncio
import os
import sys


DB = os.path.abspath(".smoke-task-transfer.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.realtime import hub  # noqa: E402
from app.services import ai_exec, inbox, team, task_notifications  # noqa: E402


ok = fail = 0
events = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:240] if extra else ""))


async def _publish(target, event, *, user_id=None):
    events.append((target, event))
    return True


async def main():
    await init_db()
    real_publish = hub.publish
    hub.publish = _publish
    try:
        async with SessionLocal() as session:
            session.add(models.OrgUnit(id="org-transfer", name="研发部"))
            session.add(models.OrgUnit(id="org-transfer-other", name="其他事业部"))
            session.add(models.Role(id="role-transfer-lead", name="团队负责人",
                                    permissions=["task.dispatch"]))
            session.add_all([
                models.User(id="user-a", username="transfer-a", display_name="甲", org_id="org-transfer"),
                models.User(id="user-b", username="transfer-b", display_name="乙", org_id="org-transfer"),
                models.User(id="user-c", username="transfer-c", display_name="丙",
                            org_id="org-transfer-other"),
                models.User(id="user-lead", username="transfer-lead", display_name="研发负责人",
                            org_id="org-transfer", role_id="role-transfer-lead"),
                models.Client(id="box-a", name="甲的 SoduWork", user_ref="user-a",
                              auth_state="active"),
                models.Client(id="box-b", name="乙的 SoduWork", user_ref="user-b",
                              auth_state="active"),
                models.Client(id="box-c", name="丙的 SoduWork", user_ref="user-c",
                              auth_state="active"),
                models.Task(id="task-transfer", title="认领后转交", status="todo", origin="dispatch",
                            owner_client_id=None, pool_org_id="org-transfer"),
                models.Task(id="task-manager-assign", title="负责人直接分配", status="todo",
                            origin="dispatch", owner_client_id=None, pool_org_id="org-transfer"),
                models.Task(id="task-out-of-scope", title="其他事业部任务", status="todo",
                            origin="dispatch", owner_client_id=None,
                            pool_org_id="org-transfer-other"),
            ])
            await session.commit()

        async with SessionLocal() as session:
            box_a = await session.get(models.Client, "box-a")
            claimed = await inbox.claim(session, box_a, "task-transfer")
        chk("认领成功直接返回最终任务", claimed.get("ok") and
            (claimed.get("task") or {}).get("id") == "task-transfer", claimed)
        chk("认领任务标明是本人主动领取，不制造重复提醒",
            (claimed.get("task") or {}).get("arrival") == "self", claimed)

        async with SessionLocal() as session:
            box_b = await session.get(models.Client, "box-b")
            second = await inbox.claim(session, box_b, "task-transfer")
            task = await session.get(models.Task, "task-transfer")
        chk("同一任务只能被一个人认领", not second.get("ok") and
            second.get("reason") == "already_claimed" and task.owner_client_id == "box-a",
            (second, task.owner_client_id))

        events.clear()
        async with SessionLocal() as session:
            lead = await session.get(models.User, "user-lead")
            ordinary = await session.get(models.User, "user-a")
            target = await session.get(models.User, "user-b")
            scope = await inbox.scope_for_user(session, lead)
            assigned = await inbox.assign_to_user(
                session, "task-manager-assign", target, scope,
                actor_name=lead.display_name, actor_id=lead.id)
            blocked = await inbox.assign_to_user(
                session, "task-out-of-scope", target, scope,
                actor_name=lead.display_name, actor_id=lead.id)
            lead_can_manage = await team._can_manage(session, lead)
            ordinary_can_manage = await team._can_manage(session, ordinary)
        chk("团队负责人能把池任务直接分配给成员",
            lead_can_manage and assigned.get("ok") and
            (assigned.get("task") or {}).get("arrival") == "assign" and
            (assigned.get("task") or {}).get("by") == "研发负责人", assigned)
        chk("普通成员不具备团队管理能力", not ordinary_can_manage)
        chk("团队负责人不能越过组织范围分配任务",
            not blocked.get("ok") and blocked.get("reason") == "out_of_scope", blocked)
        chk("负责人分配结果即时落到成员 SoduWork",
            any(target_id == "box-b" and event.get("type") == "task.created"
                and (event.get("task") or {}).get("id") == "task-manager-assign"
                for target_id, event in events), events)

        events.clear()
        async with SessionLocal() as session:
            box_a = await session.get(models.Client, "box-a")
            direct = await team.create_assigned_task(session, box_a, {
                "taskId": "task-direct-assigned",
                "title": "普通员工直接交办",
                "note": "只落接收人的执行设备",
                "assigneeUserId": "user-b",
            })
        async with SessionLocal() as session:
            box_a = await session.get(models.Client, "box-a")
            replay = await team.create_assigned_task(session, box_a, {
                "taskId": "task-direct-assigned",
                "title": "普通员工直接交办",
                "note": "重复提交不能重复创建",
                "assigneeUserId": "user-b",
            })
            direct_task = await session.get(models.Task, "task-direct-assigned")
        chk("普通员工无需管理权限即可直接交办",
            direct.get("ok") and direct.get("targetName") == "乙", direct)
        chk("直接交办原子地落到接收人设备",
            direct_task.owner_client_id == "box-b" and
            direct_task.assignee_user_id == "user-b" and
            direct_task.created_by == "user-a" and
            direct_task.origin == "dispatch", direct_task)
        chk("创建人只保留可追踪副本而不是待办",
            (direct.get("task") or {}).get("readOnly") is True and
            "creator" in (direct.get("task") or {}).get("myRoles", []) and
            "executor" not in (direct.get("task") or {}).get("myRoles", []),
            direct.get("task"))
        chk("交办保存及重放不等待后台通知",
            not any((event.get("task") or {}).get("id") == "task-direct-assigned"
                    for _, event in events), events)
        while await task_notifications.run_once(SessionLocal):
            pass
        chk("接收人收到可办理的实时任务",
            any(target_id == "box-b" and event.get("type") == "task.created"
                and (event.get("task") or {}).get("readOnly") is False
                and "executor" in (event.get("task") or {}).get("myRoles", [])
                for target_id, event in events), events)
        chk("创建人收到只读跟踪事件",
            any(target_id == "box-a" and event.get("type") == "task.created"
                and (event.get("task") or {}).get("readOnly") is True
                for target_id, event in events), events)
        chk("相同任务编号重试幂等且不重复发创建事件",
            replay.get("ok") and replay.get("reused") is True and
            sum(1 for _, event in events
                if (event.get("task") or {}).get("id") == "task-direct-assigned") == 2,
            (replay, events))

        async with SessionLocal() as session:
            task = await session.get(models.Task, "task-transfer")
            task.status = "doing"
            session.add(models.TaskEvent(
                task_id=task.id, kind=ai_exec.KINDS_DISPATCHED[0],
                detail={"assigneeName": "trial · Pi"}))
            await session.commit()

        events.clear()
        async with SessionLocal() as session:
            box_a = await session.get(models.Client, "box-a")
            moved = await team.handoff_my_task(
                session, box_a, "task-transfer", "user-c", "请继续盯住当前 AI 会话")
        chk("持有人可以把进行中的任务转给跨部门同事", moved.get("ok"), moved)
        chk("转交后的首屏保留 AI 执行中事实",
            (moved.get("task") or {}).get("ai") == {"state": "running", "name": "trial · Pi"},
            moved.get("task"))
        chk("转交原子地移出旧设备并落到新设备",
            any(target == "box-a" and event.get("type") == "task.deleted" for target, event in events)
            and any(target == "box-c" and event.get("type") == "task.updated"
                    and (event.get("task") or {}).get("ai", {}).get("state") == "running"
                    for target, event in events), events)

        async with SessionLocal() as session:
            task = await session.get(models.Task, "task-transfer")
        chk("数据库里的任务归属与响应一致",
            task.owner_client_id == "box-c" and task.assignee_user_id == "user-c"
            and task.status == "doing", (task.owner_client_id, task.assignee_user_id, task.status))
    finally:
        hub.publish = real_publish


if __name__ == "__main__":
    try:
        asyncio.run(main())
        print("\n%d PASS / %d FAIL" % (ok, fail))
    finally:
        asyncio.run(engine.dispose())
        for suffix in ("", "-shm", "-wal"):
            try:
                os.remove(DB + suffix)
            except FileNotFoundError:
                pass
    raise SystemExit(1 if fail else 0)
