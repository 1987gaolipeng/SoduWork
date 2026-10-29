# -*- coding: utf-8 -*-
"""Offline smoke tests for task evaluation and controlled evolution using disposable SQLite."""
import asyncio
from datetime import datetime, timezone
import os
import sys

DB = os.path.abspath(".smoke-task-evolution.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from sqlalchemy import func, select  # noqa: E402

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import task_evolution, task_trace  # noqa: E402
from app.services import tasks as task_service  # noqa: E402

passed = failed = 0


def chk(name, condition, extra=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:260] if extra else ""))


async def main():
    await init_db()
    async with SessionLocal() as session:
        session.add(models.Client(id="c-evo", name="验证客户端", user_ref="u-evo"))
        session.add(models.Task(id="t-evo", title="交付一份产品原型", status="done",
                                reviewed_at=datetime.now(timezone.utc),
                                origin="local", owner_client_id="c-evo", project_id="p-evo"))
        session.add(models.Task(id="t-live", title="还在执行", status="doing",
                                origin="local", owner_client_id="c-evo"))
        session.add(am.Plugin(id="pl-evo", key="prototype", name="产品原型工作流",
                              enabled=True))
        session.add(am.PluginVersion(id="pv-old", plugin_id="pl-evo", version="1.0.0",
                                     checksum="old", trust_state="approved", enabled=True))
        session.add(am.WorkflowRun(id="wr-evo", task_id="t-evo", plugin_id="pl-evo",
                                   plugin_version_id="pv-old", state="succeeded"))
        await session.commit()

    async with SessionLocal() as session:
        task = await session.get(models.Task, "t-evo")
        before = await task_trace.trace(session, task, {
            "actorId": "u-evo", "canEvaluate": True, "canReview": True,
        })
    evolve = next(item for item in before["phases"] if item["key"] == "evolve")
    chk("完成任务没有评价时明确等待人评价", before["evolution"]["state"] == "awaiting_evaluation"
        and evolve["state"] == "waiting_human", {"evolution": before["evolution"], "phase": evolve})
    chk("权限只随当前入口返回，不写进评价事实", before["evolution"]["access"] == {
        "canEvaluate": True, "canReview": True, "canApply": False})

    async with SessionLocal() as session:
        task = await session.get(models.Task, "t-live")
        try:
            await task_evolution.evaluate(session, task, {"outcome": "partial"},
                                          actor_id="u-evo", actor_name="验证人")
            blocked = False
        except ValueError as error:
            blocked = "完成后" in str(error)
    chk("未完成任务不能提前写评价", blocked)

    body = {
        "outcome": "partial", "score": 3, "summary": "交付可用，但首屏加载偏慢",
        "workedWell": "需求和验收证据完整", "improvement": "把性能预算加入预检",
        "reusableLesson": "原型交付前固定跑一次冷启动测速", "createProposal": True,
    }
    async with SessionLocal() as session:
        task = await session.get(models.Task, "t-evo")
        result = await task_evolution.evaluate(session, task, body,
                                               actor_id="u-evo", actor_name="验证人")
    proposal = result["proposal"]
    chk("评价与建议形成两份独立事实", result["evaluation"]["outcome"] == "partial"
        and proposal["evaluationId"] == result["evaluation"]["id"])
    chk("工作流任务的建议精确绑定来源插件版本", proposal["targetKind"] == "workflow"
        and proposal["pluginId"] == "pl-evo" and proposal["sourcePluginVersionId"] == "pv-old", proposal)
    chk("建议的证据快照包含任务、评价和工作流来源",
        set(proposal["evidence"]) == {"task", "evaluation", "workflow"}, proposal["evidence"])

    async with SessionLocal() as session:
        task = await session.get(models.Task, "t-evo")
        await task_evolution.evaluate(session, task, {**body, "summary": "第二版复盘"},
                                      actor_id="u-evo", actor_name="验证人")
        eval_count = await session.scalar(select(func.count()).select_from(am.TaskEvaluation))
        proposal_count = await session.scalar(select(func.count()).select_from(am.EvolutionProposal))
        evaluation = (await session.execute(select(am.TaskEvaluation))).scalar_one()
    chk("同一个人的评价按修订更新而不是制造重复行", eval_count == 1 and evaluation.revision == 2)
    chk("待审建议随评价修订更新而不是堆重复卡片", proposal_count == 1)

    async with SessionLocal() as session:
        task = await session.get(models.Task, "t-evo")
        accepted = await task_evolution.decide(
            session, task, proposal["id"], "accepted", "纳入下一版",
            actor_id="u-evo", actor_name="验证人")
    chk("采纳只改变建议状态，不修改来源插件版本", accepted["state"] == "accepted"
        and accepted["appliedPluginVersionId"] == "")

    async with SessionLocal() as session:
        task = await session.get(models.Task, "t-evo")
        try:
            await task_evolution.mark_applied(session, task, proposal["id"], "pv-old",
                                              actor_id="admin", actor_name="管理员")
            same_blocked = False
        except ValueError as error:
            same_blocked = "原版本" in str(error)
        session.add(am.PluginVersion(id="pv-new", plugin_id="pl-evo", version="1.1.0",
                                     checksum="new", trust_state="quarantined", enabled=False))
        await session.commit()
        try:
            await task_evolution.mark_applied(session, task, proposal["id"], "pv-new",
                                              actor_id="admin", actor_name="管理员")
            trust_blocked = False
        except ValueError as error:
            trust_blocked = "隔离审查" in str(error)
    chk("原版本不能冒充改进后的新版本", same_blocked)
    chk("未通过隔离审查的新版本不能标记应用", trust_blocked)

    async with SessionLocal() as session:
        version = await session.get(am.PluginVersion, "pv-new")
        version.trust_state, version.enabled = "approved", True
        await session.commit()
        task = await session.get(models.Task, "t-evo")
        applied = await task_evolution.mark_applied(session, task, proposal["id"], "pv-new",
                                                    actor_id="admin", actor_name="管理员")
        final = await task_trace.trace(session, task)
    final_phase = next(item for item in final["phases"] if item["key"] == "evolve")
    chk("只有独立获批的新版本才能完成应用", applied["state"] == "applied"
        and applied["appliedPluginVersionId"] == "pv-new", applied)
    chk("全链路第六阶段读取真实评价与应用事实", final["evolution"]["state"] == "applied"
        and final_phase["state"] == "succeeded" and final_phase["evidenceCount"] == 2,
        {"evolution": final["evolution"], "phase": final_phase})
    kinds = {item["kind"] for item in final["timeline"]}
    chk("评价、建议、决定和应用都进入任务审计时间线", {
        "task.evaluated", "evolution.proposed", "evolution.accepted", "evolution.applied"
    }.issubset(kinds), kinds)

    async with SessionLocal() as session:
        deleted = await task_service.delete_task(session, "c-evo", "t-evo")
        eval_count = await session.scalar(select(func.count()).select_from(am.TaskEvaluation))
        proposal_count = await session.scalar(select(func.count()).select_from(am.EvolutionProposal))
    chk("删任务时同步清理评价与改进建议，不留孤儿", deleted["ok"] and not eval_count and not proposal_count)

    print("\n%d PASS / %d FAIL" % (passed, failed))
    await engine.dispose()
    return failed


if __name__ == "__main__":
    try:
        code = asyncio.run(main())
    finally:
        for suffix in ("", "-shm", "-wal"):
            try:
                os.remove(DB + suffix)
            except FileNotFoundError:
                pass
    raise SystemExit(1 if code else 0)
