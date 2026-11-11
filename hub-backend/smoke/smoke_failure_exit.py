# -*- coding: utf-8 -*-
"""Regression checks for failure recovery and execution cleanup."""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-failexit.db")
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
from app.realtime import hub  # noqa: E402
from app.services import workflow_engine, workflow_runs  # noqa: E402

ok = fail = 0
pushed = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra) if extra else ""))


async def _fake_publish(client_id, payload, *, user_id=None):
    expected_accounts = {"c-fail": "u-fail", "c-anonymous": ""}
    assert client_id in expected_accounts and user_id == expected_accounts[client_id], \
        "Fixture notifications must carry their original explicit account fence."
    pushed.append((client_id, payload, user_id))


async def build(session, run_id, node_key, node_type, *, attempt=2, max_attempts=2, task_id="t-fail"):
    """Create a run with successful upstream dependencies and a failed target gate."""
    ver = am.PluginVersion(
        id="pv-" + run_id, plugin_id="p1", version=run_id, checksum=run_id,
        trust_state="approved", enabled=True,
        workflow={"nodes": [
            {"key": "prepare", "type": "condition"},
            {"key": node_key, "type": node_type, "name": "写代码", "dependsOn": ["prepare"],
             "retry": {"maxAttempts": max_attempts}},
        ]})
    run = am.WorkflowRun(id=run_id, task_id=task_id, plugin_id="p1",
                         plugin_version_id=ver.id, binding_id="b1",
                         state="failed", error="CLI 退出码 1")
    up = am.NodeRun(id="n-up-" + run_id, run_id=run_id, node_key="prepare",
                    node_type="condition", state="succeeded", attempt=1,
                    output={"commit": "abc"}, idempotency_key="up-" + run_id)
    bad = am.NodeRun(id="n-bad-" + run_id, run_id=run_id, node_key=node_key,
                     node_type=node_type, state="failed", attempt=attempt,
                     error="CLI 退出码 1", idempotency_key="bad-" + run_id)
    session.add_all([ver, run, up, bad])
    await session.commit()
    return run, up, bad


async def main():
    await init_db()
    hub.publish = _fake_publish          # Replace only notification transport while exercising real logic.

    async with SessionLocal() as s:
        s.add(models.User(id="u-fail", username="failure-owner"))
        s.add(models.User(id="u-next", username="next-device-account"))
        s.add(models.Client(id="c-fail", name="测试机", user_ref="u-fail"))
        s.add(models.Task(id="t-fail", title="做个官网", status="doing",
                          owner_client_id="c-fail"))
        await s.commit()

        # Retry a failed AI gate.
        run, up, bad = await build(s, "r-ai", "implement", "ai")
        node = await workflow_runs.retry_failed_gate(s, run, actor="张三")
        chk("★AI 关失败之后能重试", node is not None and node.node_type == "ai")
        chk("重试是新起一次尝试，不是改旧的", node.attempt == bad.attempt + 1 and node.state == "queued")
        chk("失败证据留着没被抹掉", bad.state == "failed" and bad.error == "CLI 退出码 1")
        chk("上游已交付的成果不重跑", up.state == "succeeded")
        chk("run 回到运行中并清掉错误", run.state == "running" and not run.error)
        box = (await s.execute(select(am.WorkflowOutbox).where(
            am.WorkflowOutbox.node_run_id == node.id))).scalar_one()
        chk("真的派出去了（outbox 有待办）", box.status == "pending")
        ev = (await s.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id == "t-fail",
            models.TaskEvent.kind == "plugin.gate_retry"))).scalars().all()
        chk("重试记进了任务时间线", len(ev) == 1, ev)

        # Retry a failed AI-review gate.
        run2, _, _ = await build(s, "r-review", "review", "ai_review")
        node2 = await workflow_runs.retry_failed_gate(s, run2, actor="张三")
        chk("★AI 审查关失败也能重试", node2 is not None and node2.node_type == "ai_review")

        # A deterministic specification gate must be retryable after its parser,
        # policy or configuration is repaired. Replaying the upstream AI analysis
        # would waste time and could replace already-audited requirements evidence.
        run_spec, up_spec, bad_spec = await build(
            s, "r-spec", "baseline", "spec", attempt=1)
        retried_spec = await workflow_runs.retry_failed_gate(
            s, run_spec, actor="tester", node_key="baseline")
        chk("spec gate retries in place after a platform fix",
            retried_spec.node_type == "spec" and retried_spec.attempt == 2
            and retried_spec.state == "queued")
        chk("spec retry preserves accepted upstream evidence",
            up_spec.state == "succeeded" and bad_spec.state == "failed")




        run3, _, _ = await build(s, "r-script", "gen", "condition")
        try:
            await workflow_runs.retry_failed_gate(s, run3, actor="张三")
            chk("白名单外的关卡仍旧挡住", False, "居然放行了")
        except ValueError as e:
            chk("白名单外的关卡仍旧挡住", "不允许" in str(e), str(e))

        # Reject retry when upstream dependencies have not succeeded.
        run4, up4, _ = await build(s, "r-updep", "implement", "ai")
        up4.state = "failed"
        await s.commit()
        try:
            await workflow_runs.retry_failed_gate(s, run4, actor="张三")
            chk("上游没交付时不许重试", False, "居然放行了")
        except ValueError as e:
            chk("上游没交付时不许重试", "上游" in str(e), str(e))

        # Exercise real engine settlement and verify task timeline and push evidence.
        pushed.clear()
        run5, _, bad5 = await build(s, "r-notice", "implement", "ai", attempt=2, max_attempts=2)
        run5.state = "running"
        await s.commit()
        await workflow_engine._schedule(s, run5)
        chk("引擎把这条 run 判成失败", run5.state == "failed", run5.state)
        evs = (await s.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id == "t-fail",
            models.TaskEvent.kind == "plugin.failed"))).scalars().all()
        chk("★失败记进了任务时间线", len(evs) == 1, [e.kind for e in evs])
        detail = (evs[0].detail or {}) if evs else {}
        chk("时间线上说清了卡在哪一关", detail.get("node") == "implement", detail)
        chk("时间线上说清了还能不能重试", detail.get("canRetry") is True, detail)
        # Failure also sends a task.updated state projection.
        # Assert payload meaning rather than a fragile exact notification count or order.
        notices = [msg for cid, msg, _uid in pushed
                   if cid == "c-fail" and msg.get("kind") == "flow_failed"]
        chk("★失败当场推给了人", len(notices) == 1, pushed)
        chk("失败通知和任务状态绑定原任务账号",
            any(msg.get("type") == "task.updated" for _cid, msg, _uid in pushed)
            and all(cid == "c-fail" and uid == "u-fail"
                    for cid, _msg, uid in pushed), pushed)
        text = (notices[0].get("text") if notices else "") or ""
        chk("推送里点明了下一步能点什么", "重试这一关" in text, text)
        chk("推送里带着任务名", "做个官网" in text, text)

        # Distinguish actionable retry guidance from non-retryable failures.
        pushed.clear()
        run6, _, _ = await build(s, "r-notice2", "gen", "condition", attempt=1, max_attempts=1)
        run6.state = "running"
        await s.commit()
        await workflow_engine._schedule(s, run6)
        text6 = next((msg.get("text") or "" for _cid, msg, _uid in pushed
                      if msg.get("kind") == "flow_failed"), "")
        chk("不能重试的关卡不许说「点重试」", "重试这一关" not in text6 and "人处理" in text6, text6)


        run7, up7, cur7 = await build(s, "r-live", "implement", "ai", attempt=1)
        run7.state, cur7.state, cur7.error = "running", "running", ""
        await s.commit()
        node7 = await workflow_runs.redispatch_running_gate(
            s, run7, actor="张三", execution={"agentKind": "local:claude"})
        chk("★运行中的 AI 关能重新派", node7 is not None and node7.state == "queued"
            and node7.attempt == 2, node7 and node7.state)
        chk("原尝试被判死且注明人工重派", cur7.state == "failed"
            and (cur7.output or {}).get("failureKind") == "manual_redispatch", cur7.output)
        chk("换的底座写进了 executionOverrides",
            ((run7.context or {}).get("executionOverrides") or {}).get("implement", {})
            .get("agentKind") == "local:claude", run7.context)
        chk("run 回到运行中", run7.state == "running", run7.state)
        ev7 = (await s.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id == "t-fail",
            models.TaskEvent.kind == "plugin.gate_redispatched"))).scalars().all()
        chk("重派记进了任务时间线", len(ev7) == 1, [e.kind for e in ev7])

        # Reject redispatch while another node is active without changing any state.
        run8, up8, cur8 = await build(s, "r-live2", "implement", "ai", attempt=1)
        run8.state, cur8.state, up8.state = "running", "running", "running"
        await s.commit()
        try:
            await workflow_runs.redispatch_running_gate(s, run8, actor="张三")
            chk("其它关卡在跑时拒绝重派", False, "居然放行了")
        except ValueError as e:
            chk("其它关卡在跑时拒绝重派", "其它关卡" in str(e), str(e))
        await s.refresh(run8)
        await s.refresh(cur8)
        chk("拒绝时状态原封不动", run8.state == "running" and cur8.state == "running",
            (run8.state, cur8.state))

        # Restrict running-node redispatch to AI gates.
        run9, _, cur9 = await build(s, "r-live3", "check", "quality", attempt=1)
        run9.state, cur9.state = "running", "running"
        await s.commit()
        try:
            await workflow_runs.redispatch_running_gate(s, run9, actor="张三")
            chk("非 AI 关不给重派", False, "居然放行了")
        except ValueError as e:
            chk("非 AI 关不给重派", "没有正在执行的 AI 关卡" in str(e), str(e))

        # The device's next login must not receive the original account's failure.
        device = await s.get(models.Client, "c-fail")
        device.user_ref = "u-next"
        await s.commit()
        pushed.clear()
        switched, _, _ = await build(s, "r-switched-account", "implement", "ai")
        switched.state = "running"
        await s.commit()
        await workflow_engine._schedule(s, switched)
        chk("切换账号后仍记录流程失败", switched.state == "failed")
        chk("切换账号后不向新账号泄露原任务失败", not pushed, pushed)

        # Preserve main's anonymous-device routing contract alongside the
        # released account-owner and changed-login regression above.
        s.add(models.Client(id="c-anonymous", name="Anonymous fixture"))
        s.add(models.Task(id="t-anonymous", title="Anonymous task", status="doing",
                          owner_client_id="c-anonymous"))
        await s.commit()
        pushed.clear()
        anonymous, _, _ = await build(s, "r-anonymous", "implement", "ai", task_id="t-anonymous")
        anonymous.state = "running"
        await s.commit()
        await workflow_engine._schedule(s, anonymous)
        chk("匿名设备失败仍发送原路由通知", anonymous.state == "failed" and
            any(message.get("kind") == "flow_failed" for _cid, message, _uid in pushed), pushed)
        chk("匿名通知保留显式空账号边界", bool(pushed) and
            all(cid == "c-anonymous" and uid == "" for cid, _message, uid in pushed), pushed)

    print("\nfailure exit smoke: %d passed, %d failed" % (ok, fail))
    return 1 if fail else 0


sys.exit(asyncio.run(main()))
