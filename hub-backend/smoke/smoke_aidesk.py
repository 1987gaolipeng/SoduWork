# -*- coding: utf-8 -*-
"""Verify plugin executions appear in the AI workbench and query counts do not grow linearly with
task count.
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone

DB = os.path.abspath(".smoke-aidesk.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from sqlalchemy import event  # noqa: E402

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import ai_exec, aidesk_cleanup, aidesk_view  # noqa: E402

ok = fail = 0
lines = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        lines.append("  PASS  " + name)
    else:
        fail += 1
        lines.append("  FAIL  " + name + ("  << " + str(extra)[:260] if extra else ""))


async def main():
    await init_db()
    async with SessionLocal() as session:
        box = models.Client(id="c-aidesk", name="工作台冒烟 SoduWork")
        plain = models.Task(id="t-aidesk-plain", owner_client_id=box.id,
                            title="普通 AI 派活", status="doing")
        confirming = models.Task(id="t-aidesk-confirming", owner_client_id=box.id,
                                 title="等待 Runner 回执", status="doing")
        direct_failed = models.Task(id="t-aidesk-direct-failed", owner_client_id=box.id,
                                    title="直接派活失败", status="todo")
        plugin_task = models.Task(id="t-aidesk-plugin", owner_client_id=box.id,
                                  title="插件研发流程", status="doing")
        superseded = models.Task(id="t-aidesk-superseded", owner_client_id=box.id,
                                 title="重试后已经结束", status="doing")
        finished = models.Task(id="t-aidesk-finished", owner_client_id=box.id,
                               title="执行结束等待验收", status="doing")
        plugin = am.Plugin(id="p-aidesk", key="delivery", name="标准研发交付", enabled=True)
        version = am.PluginVersion(
            id="pv-aidesk", plugin_id=plugin.id, version="1.0.0", checksum="a" * 64,
            trust_state="approved", enabled=True,
            workflow={"nodes": [{"key": "baseline", "name": "需求基线审批",
                                  "type": "human_review"},
                                 {"key": "release", "name": "发布到企业环境",
                                  "type": "deploy_chain", "dependsOn": ["baseline"]}]})
        run = am.WorkflowRun(
            id="r-aidesk", task_id=plugin_task.id, plugin_id=plugin.id,
            plugin_version_id=version.id, state="failed", current_nodes=[] ,
            context={"pluginName": plugin.name}, error="需求说明没有回传")
        node = am.NodeRun(
            id="n-aidesk", run_id=run.id, node_key="baseline", node_type="human_review",
            attempt=3, state="failed", error="需求分析节点没有产出 requirements.md",
            idempotency_key="r-aidesk:baseline:3",
            executor={"kind": "ai", "ref": "runner-ref-aidesk", "provider": "runner",
                      "runnerId": "runner-aidesk", "host": "QA-PC", "assignee": "QA-PC · Pi"})
        session.add_all([box, plain, confirming, direct_failed,
                         plugin_task, superseded, finished,
                         plugin, version, run, node])
        session.add(models.TaskEvent(
            task_id=plain.id, kind=ai_exec.EV_DISPATCHED,
            detail={"ref": "plain-aidesk", "assigneeName": "本机 OpenCode",
                    "assigneeCli": "OpenCode", "provider": "local"}))
        session.add(models.TaskEvent(
            task_id=confirming.id, kind=ai_exec.EV_DISPATCH_UNCERTAIN,
            detail={"attemptId": "pending-attempt", "expectedRef": "pending-ref",
                    "requestedId": "runner:runner-pending:pi",
                    "assigneeName": "开发机 · Pi", "assigneeCli": "Pi",
                    "runnerId": "runner-pending", "host": "DEV-PC",
                    "phaseName": "确认执行机回执",
                    "summary": "执行机回执暂未确认，SoduWork 正在自动核对"}))
        session.add(models.TaskEvent(
            task_id=direct_failed.id, kind=ai_exec.EV_DISPATCH_FAILED,
            detail={"attemptId": "failed-attempt", "requestedId": "local:opencode",
                    "assigneeName": "本机 OpenCode", "assigneeCli": "OpenCode",
                    "phaseName": "准备工作目录", "summary": "准备工作目录失败：仓库不可达"}))
        base = datetime(2026, 8, 1, tzinfo=timezone.utc)
        for task, ref in ((superseded, "new-done"), (finished, "only-done")):
            session.add(models.TaskEvent(
                task_id=task.id, kind=ai_exec.EV_DISPATCHED,
                detail={"ref": ref, "assigneeName": "本机 OpenCode",
                        "assigneeCli": "OpenCode", "provider": "local"}))
        session.add_all([
            am.ExecutionSession(id="es-old-running", task_id=superseded.id,
                                ref="old-running", state="running", engine="opencode",
                                started_at=base),
            am.ExecutionSession(id="es-new-done", task_id=superseded.id,
                                ref="new-done", state="done", engine="opencode",
                                started_at=base + timedelta(minutes=5),
                                finished_at=base + timedelta(minutes=6)),
            am.ExecutionSession(id="es-only-done", task_id=finished.id,
                                ref="only-done", state="done", engine="opencode",
                                started_at=base + timedelta(minutes=10),
                                finished_at=base + timedelta(minutes=11)),
        ])
        await session.commit()

        queries = 0

        def count_sql(*_args):
            nonlocal queries
            queries += 1

        event.listen(engine.sync_engine, "before_cursor_execute", count_sql)
        original_can_stop = ai_exec.can_stop

        def forbid_runner_probe(*_args, **_kwargs):
            raise AssertionError("AI 工作台汇总页不应逐任务探测 Runner")

        ai_exec.can_stop = forbid_runner_probe
        try:
            view = await aidesk_view.build(
                session, box, {"name": "local", "cfg": {}},
                {"agents": [{"name": "本机 OpenCode", "cliName": "OpenCode", "online": True}],
                 "squads": []})
        finally:
            ai_exec.can_stop = original_can_stop
            event.remove(engine.sync_engine, "before_cursor_execute", count_sql)

        by_id = {x["id"]: x for x in view["tasks"]}
        flow_item = by_id.get(plugin_task.id) or {}
        chk("★★没有 ai.dispatched 的插件任务仍进入 AI 工作台", plugin_task.id in by_id, view)
        chk("插件失败态进入需要处理分组", flow_item.get("phase") == "failed"
            and flow_item.get("attention") is True, flow_item)
        chk("当前插件节点使用人能读懂的名称", (flow_item.get("workflow") or {}).get("nodeName") == "需求基线审批",
            flow_item.get("workflow"))
        flow_steps = (flow_item.get("workflow") or {}).get("steps") or []
        chk("工作台返回插件定义的完整节点序列", [x.get("name") for x in flow_steps] ==
            ["需求基线审批", "发布到企业环境"], flow_steps)
        chk("失败关卡和后续未开始关卡不会被画成全绿", [x.get("state") for x in flow_steps] ==
            ["failed", "pending"] and flow_steps[0].get("error") == node.error, flow_steps)
        chk("技术性失败的人工关卡在工作台提供安全续跑入口",
            (flow_item.get("workflow") or {}).get("canRetryGate") is True,
            flow_item.get("workflow"))
        chk("Runner、主机和执行者事实完整返回", flow_item.get("agent") == "QA-PC · Pi"
            and (flow_item.get("runner") or {}).get("host") == "QA-PC", flow_item)
        chk("普通派活仍保持可见", plain.id in by_id and by_id[plain.id].get("phase") == "running", by_id)
        pending_item = by_id.get(confirming.id) or {}
        chk("★★ACK 未确认的任务立即进入 AI 工作台",
            pending_item.get("phase") == "dispatching"
            and pending_item.get("confirmationPending") is True, pending_item)
        chk("确认态不冒充已运行会话且不开放停止",
            pending_item.get("running") is False and pending_item.get("canStop") is False
            and not pending_item.get("ref") and pending_item.get("expectedRef") == "pending-ref",
            pending_item)
        chk("确认态保留 Runner 与 Agent 归属",
            pending_item.get("agent") == "开发机 · Pi"
            and (pending_item.get("runner") or {}).get("id") == "runner-pending",
            pending_item)
        chk("直接派活失败也可见且不会冒充运行中",
            by_id.get(direct_failed.id, {}).get("phase") == "failed"
            and by_id.get(direct_failed.id, {}).get("running") is False,
            by_id.get(direct_failed.id))
        chk("★旧的运行中尝试不会压过更新的已结束尝试",
            by_id.get(superseded.id, {}).get("phase") == "waiting"
            and by_id.get(superseded.id, {}).get("canStop") is False,
            by_id.get(superseded.id))
        chk("★任务字段仍是进行中，但执行已结束时进入验收而不冒充运行中",
            by_id.get(finished.id, {}).get("phase") == "waiting",
            by_id.get(finished.id))
        chk("★★汇总不探测 Runner 也能按持久化来源显示停止能力",
            by_id[plain.id].get("canStop") is True, by_id[plain.id])
        chk("五类汇总数字按任务事实计算", view.get("summary", {}).get("failed") == 2
            and view.get("summary", {}).get("dispatching") == 1
            and view.get("summary", {}).get("running") == 1
            and view.get("summary", {}).get("waiting") == 2, view.get("summary"))
        chk("★★汇总是固定批量查询，不按任务逐条查询", queries <= 9, queries)

        cleanup = await aidesk_cleanup.cleanup_abnormal(session, box, view)
        after_cleanup = await aidesk_view.build(
            session, box, {"name": "local", "cfg": {}},
            {"agents": [], "squads": []})
        after_ids = {x["id"] for x in after_cleanup["tasks"]}
        chk("one-click cleanup only handles failed tasks", set(cleanup["cleaned"]) ==
            {direct_failed.id, plugin_task.id}, cleanup)
        chk("cleaned failures leave the live workbench", direct_failed.id not in after_ids and
            plugin_task.id not in after_ids, after_ids)
        chk("cleanup preserves the task record",
            (await session.get(models.Task, direct_failed.id)).status == "cancel")

    await engine.dispose()


try:
    asyncio.run(main())
finally:
    for suffix in ("", "-shm", "-wal"):
        try:
            os.remove(DB + suffix)
        except (FileNotFoundError, PermissionError):
            pass

print("\n".join(lines))
print("\n%d passed, %d failed" % (ok, fail))
raise SystemExit(1 if fail else 0)
