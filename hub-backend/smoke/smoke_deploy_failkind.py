# -*- coding: utf-8 -*-
"""Deployment connectivity or repository-access failures must not rewind implementation.

An unauthorized SSH connection can fail in prepare even when a release target exists.
Treat this as an environment or permission problem rather than rerunning implementation
through onFailure.retryFrom. Run offline with an isolated temporary database.
"""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-deploykind.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from types import SimpleNamespace  # noqa: E402

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import deployments, workflow_contracts, workflow_engine  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra) if extra else ""))


NODES = [
    {"key": "implement", "type": "ai", "name": "工程实现", "retry": {"maxAttempts": 3}},
    {"key": "releaseChain", "type": "deploy_chain", "name": "走完企业发布链",
     "dependsOn": ["implement"],
     "config": {"onFailure": {"retryFrom": "implement", "maxRounds": 2}},
     "retry": {"maxAttempts": 2}},
]


def run_row(state, stage, error="", logs="", result=None):
    payload = dict(result or {})
    if stage:
        payload["stage"] = stage
    return SimpleNamespace(state=state, result=payload, error=error, logs=logs)


async def main():
    await init_db()
    # Test failure classification directly.
    chk("prepare 段失败＝基础设施",
        deployments._failure_kind([run_row("failed", "prepare")]) == "infrastructure")
    chk("deploy 段失败不算基础设施（可能真是这版代码的问题）",
        deployments._failure_kind([run_row("failed", "deploy")]) == "")
    chk("missing deploy command is infrastructure, not implementation rework",
        deployments._failure_kind([
            run_row("failed", "deploy",
                    "bash: ops/deploy-example.sh: No such file or directory")
        ]) == "infrastructure")
    chk("broken external deploy adapter is retryable infrastructure",
        deployments._failure_kind([
            run_row("rollback_failed", "deploy",
                    "/opt/soduwork/deployers/app.sh: 141: CR: not found")
        ]) == "infrastructure")
    chk("missing application asset remains an implementation failure",
        deployments._failure_kind([
            run_row("failed", "deploy",
                    "cp: cannot stat 'dist/app.js': No such file or directory")
        ]) == "")
    chk("check 段失败不算基础设施（健康检查没过）",
        deployments._failure_kind([run_row("failed", "check")]) == "")
    chk("没报 stage 的老 runner 不误判",
        deployments._failure_kind([run_row("failed", "")]) == "")
    chk("成功的运行不参与判定",
        deployments._failure_kind([run_row("succeeded", "prepare")]) == "")
    chk("回滚过的失败也认 prepare",
        deployments._failure_kind([run_row("rolled_back", "prepare")]) == "infrastructure")
    chk("infrastructure 属于禁止回卷类",
        workflow_contracts.rework_forbidden({"failureKind": "infrastructure"}))
    chk("infrastructure 不是终态（配好后能原地重试）",
        not workflow_contracts.terminal_failure({"failureKind": "infrastructure"}))

    # Exercise the actual engine with a prepare-stage deployment failure.
    async with SessionLocal() as s:
        s.add(models.Client(id="c-dk", name="机"))
        s.add(models.Task(id="t-dk", title="发布", status="doing", owner_client_id="c-dk"))
        ver = am.PluginVersion(id="pv-dk", plugin_id="p1", version="1", checksum="x",
                               trust_state="approved", enabled=True,
                               workflow={"nodes": [
                                   NODES[0],
                                   {**NODES[1], "type": "deploy",
                                    "config": {"onFailure": {"retryFrom": "implement",
                                                             "maxRounds": 2},
                                               "environmentKey": "test"}}]})
        run = am.WorkflowRun(id="r-dk", task_id="t-dk", plugin_id="p1",
                             plugin_version_id="pv-dk", binding_id="b1", state="running")
        impl = am.NodeRun(id="ni-dk", run_id="r-dk", node_key="implement", node_type="ai",
                          state="succeeded", attempt=1, idempotency_key="k1")
        dep_run = am.DeploymentRun(id="dr-1", task_id="t-dk", artifact_version_id="a1",
                                   environment_id="env-system-test", target_id="tg1",
                                   state="failed", attempt=1, idempotency_key="d1",
                                   error="Permission denied (publickey)",
                                   result={"stage": "prepare"})
        gate = am.NodeRun(id="ng-dk", run_id="r-dk", node_key="releaseChain",
                          node_type="deploy", state="waiting_external", attempt=1,
                          idempotency_key="k2", output={"runs": [{"id": "dr-1"}]})
        s.add_all([ver, run, impl, dep_run, gate])
        await s.commit()

        await workflow_engine._poll_node(s, run, gate)
        await s.commit()
        gate = await s.get(am.NodeRun, "ng-dk")
        chk("★引擎：部署失败被标成 infrastructure",
            gate.state == "failed" and (gate.output or {}).get("failureKind") == "infrastructure",
            (gate.state, gate.output))
        rows = list((await s.execute(
            __import__("sqlalchemy").select(am.NodeRun).where(
                am.NodeRun.run_id == "r-dk", am.NodeRun.node_key == "implement"))).scalars().all())
        chk("★引擎：implement 没有被回卷重跑（还是那一条 succeeded）",
            len(rows) == 1 and rows[0].state == "succeeded",
            [(x.attempt, x.state) for x in rows])
        evs = list((await s.execute(
            __import__("sqlalchemy").select(am.WorkflowEvent).where(
                am.WorkflowEvent.run_id == "r-dk",
                am.WorkflowEvent.kind == "rework.suppressed"))).scalars().all())
        chk("★引擎：拦截有痕（rework.suppressed）", len(evs) == 1, len(evs))

        # Reconcile receipts even when a repeated deploy.start returns terminal state immediately.
        snapshot = SimpleNamespace(
            state="queued", logs="", error="", result={},
            started_at=None, finished_at=None)
        deployments._apply_runner_status(snapshot, {
            "state": "succeeded", "log": "health ok",
            "result": {"checks": [{"ok": True}]},
            "stage": "check", "startedAt": 1786450000000,
            "finishedAt": 1786450005000,
        })
        chk("部署快照·幂等 start 返回终态时完整带回日志、结果和完成时间",
            snapshot.state == "succeeded" and snapshot.finished_at is not None
            and snapshot.result.get("stage") == "check" and snapshot.logs == "health ok",
            snapshot.__dict__)

        real_get = deployments.runner_hub.get
        real_call = deployments.runner_hub.call_sync
        real_after = deployments._after_terminal
        finalized = []

        async def fake_after(sess, row):
            finalized.append(row.id)
            await sess.commit()

        deployments.runner_hub.get = lambda _rid: SimpleNamespace(id=_rid)
        deployments.runner_hub.call_sync = lambda *_args, **_kwargs: {
            "ok": True, "state": "succeeded", "log": "done",
            "result": {"checks": [{"ok": True}]},
            "startedAt": 1786450000000, "finishedAt": 1786450005000,
        }
        deployments._after_terminal = fake_after
        try:
            dep_run.state, dep_run.runner_id, dep_run.finished_at = "succeeded", "runner-old", None
            await s.commit()
            await deployments._poll(s, dep_run)
            chk("部署恢复·已写成功但缺完成回执的旧记录会重新执行终态收尾",
                finalized == [dep_run.id] and dep_run.finished_at is not None,
                (finalized, dep_run.finished_at))
        finally:
            deployments.runner_hub.get = real_get
            deployments.runner_hub.call_sync = real_call
            deployments._after_terminal = real_after

        real_poll = deployments._poll
        reconciled = []

        async def fake_poll(_session, row):
            reconciled.append(row.id)

        dep_run.finished_at = None
        await s.commit()
        deployments._poll = fake_poll
        try:
            await deployments.sweep(s)
            chk("部署恢复·扫描器会重新捞取终态但缺完成时间的记录",
                dep_run.id in reconciled, reconciled)
        finally:
            deployments._poll = real_poll

    print("\ndeploy failkind smoke: %d passed, %d failed" % (ok, fail))
    return 1 if fail else 0


sys.exit(asyncio.run(main()))
