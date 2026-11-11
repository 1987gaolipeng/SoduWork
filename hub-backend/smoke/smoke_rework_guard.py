# -*- coding: utf-8 -*-
"""Block onFailure rewinds for configuration, authorization, and infrastructure failures.

Exercise real engine tick, _execute_node, and _poll_node paths without stubbing the engine:
1. Missing deploy_chain configuration fails the node and run without rewinding.
2. After configuration is fixed, retry_failed_gate retries that gate directly.
3. Configuration revoked during deploy_chain polling also prevents rewinding.
4. Unavailable quality-gate RPCs prevent rewinding but still allow gate retries within maxAttempts.

Also verify the rework_forbidden/terminal_failure truth table and retain contract-failure
rewinds. Run offline with an isolated temporary database.
"""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-reworkgate.db")
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
from app.services import workflow_contracts, workflow_engine, workflow_runs  # noqa: E402

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
    {"key": "implement", "type": "ai", "name": "工程实现",
     "config": {}, "retry": {"maxAttempts": 3}},
    {"key": "releaseChain", "type": "deploy_chain", "name": "走完企业发布链",
     "dependsOn": ["implement"],
     "config": {"onFailure": {"retryFrom": "implement", "maxRounds": 2}},
     "retry": {"maxAttempts": 2}},
]
QNODES = [
    {"key": "implement", "type": "ai", "name": "工程实现",
     "config": {}, "retry": {"maxAttempts": 3}},
    {"key": "quality", "type": "quality", "name": "工程质量门禁",
     "dependsOn": ["implement"],
     "config": {"onFailure": {"retryFrom": "implement", "maxRounds": 2}},
     "retry": {"maxAttempts": 2}},
]


async def make_run(s, rid, tid, nodes, gate_key, gate_state, gate_extra=None):
    """Create a run with successful implementation and a gate in the requested state."""
    ver = am.PluginVersion(
        id="pv-" + rid, plugin_id="p1", version=rid, checksum=rid,
        trust_state="approved", enabled=True, workflow={"nodes": nodes})
    run = am.WorkflowRun(id=rid, task_id=tid, plugin_id="p1", plugin_version_id=ver.id,
                         binding_id="b1", state="running", current_nodes=[gate_key])
    impl = am.NodeRun(id="ni-" + rid, run_id=rid, node_key="implement", node_type="ai",
                      state="succeeded", attempt=1, idempotency_key=rid + ":implement:1",
                      output={"ref": "local:x", "gitHead": "abc"})
    gate = am.NodeRun(id="ng-" + rid, run_id=rid, node_key=gate_key,
                      node_type=next(n["type"] for n in nodes if n["key"] == gate_key),
                      state=gate_state, attempt=1, idempotency_key=rid + ":" + gate_key + ":1",
                      **(gate_extra or {}))
    s.add_all([ver, run, impl, gate])
    if gate_state == "queued":
        s.add(am.WorkflowOutbox(run_id=rid, node_run_id=gate.id, topic="node.execute",
                                payload={"nodeKey": gate_key, "attempt": 1}))
    await s.commit()
    return run, gate


async def rows_of(s, rid, key):
    return list((await s.execute(select(am.NodeRun).where(
        am.NodeRun.run_id == rid, am.NodeRun.node_key == key
    ).order_by(am.NodeRun.attempt))).scalars().all())


async def events_of(s, rid, kind):
    return list((await s.execute(select(am.WorkflowEvent).where(
        am.WorkflowEvent.run_id == rid, am.WorkflowEvent.kind == kind))).scalars().all())


async def main():
    await init_db()
    async with SessionLocal() as s:
        # Verify retry and rework classification truth tables.
        chk("configuration 禁回卷", workflow_contracts.rework_forbidden(
            {"failureKind": "configuration"}))
        chk("authorization 禁回卷", workflow_contracts.rework_forbidden(
            {"failureKind": "authorization"}))
        chk("infrastructure 禁回卷", workflow_contracts.rework_forbidden(
            {"failureKind": "infrastructure"}))
        chk("contract 允许回卷（重做上游正是解法）",
            not workflow_contracts.rework_forbidden({"failureKind": "contract"}))
        chk("无类别允许回卷（老行为不变）",
            not workflow_contracts.rework_forbidden({}) and
            not workflow_contracts.rework_forbidden(None))
        chk("infrastructure 不是终态（maxAttempts 内还能整关自动重试）",
            not workflow_contracts.terminal_failure({"failureKind": "infrastructure"}))
        chk("configuration 是终态（原样重试也不会好）",
            workflow_contracts.terminal_failure({"failureKind": "configuration"}))
        chk("异常类型携带类别", workflow_contracts.WorkflowConfigurationError.failure_kind
            == "configuration" and workflow_contracts.WorkflowContractError.failure_kind
            == "contract")

        # Prepare a repository without deployment targets.
        s.add(models.Client(id="c-rg", name="测试机"))
        s.add(models.Repo(id="r-rg", project_id="prj", name="仓库", git_url="http://x/y.git"))
        for tid in ("t-start", "t-poll", "t-contract", "t-q", "t-q-runner", "t-q-old"):
            s.add(models.Task(id=tid, title=tid, status="doing",
                              owner_client_id="c-rg", repo_id="r-rg"))
        await s.commit()

        # Classify missing configuration during node startup.
        run1, _ = await make_run(s, "r-start", "t-start", NODES, "releaseChain", "queued")
        await workflow_engine.tick(s)
        gate_rows = await rows_of(s, "r-start", "releaseChain")
        impl_rows = await rows_of(s, "r-start", "implement")
        run1 = await s.get(am.WorkflowRun, "r-start")
        chk("① releaseChain 失败且带 configuration 类别",
            gate_rows and gate_rows[-1].state == "failed" and
            (gate_rows[-1].output or {}).get("failureKind") == "configuration",
            [(x.state, x.output) for x in gate_rows])
        chk("① implement 没有被回卷重跑（还是那一条）",
            len(impl_rows) == 1 and impl_rows[0].state == "succeeded",
            [(x.attempt, x.state) for x in impl_rows])
        chk("① 时间线记了 rework.suppressed（不许闷声拦）",
            len(await events_of(s, "r-start", "rework.suppressed")) == 1)
        chk("① 没有发生过回卷（run.rework 为 0）",
            not await events_of(s, "r-start", "run.rework"))
        chk("① run 干净失败、错误话就是配置缺失",
            run1.state == "failed" and "部署目标" in (run1.error or ""),
            (run1.state, run1.error))
        pf = list((await s.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id == "t-start",
            models.TaskEvent.kind == "plugin.failed"))).scalars().all())
        chk("① 任务时间线有 plugin.failed 且标了可重试",
            len(pf) == 1 and (pf[0].detail or {}).get("canRetry") is True,
            [(e.kind, e.detail) for e in pf])

        # Retry the same gate after configuration repair without rerunning implementation.
        node2 = await workflow_runs.retry_failed_gate(s, run1, actor="tester")
        run1 = await s.get(am.WorkflowRun, "r-start")
        chk("② retry_failed_gate 给了新一次尝试（attempt=2, queued）",
            node2.node_key == "releaseChain" and node2.attempt == 2
            and node2.state == "queued", (node2.node_key, node2.attempt, node2.state))
        chk("② run 回到 running", run1.state == "running", run1.state)
        chk("② implement 仍然只有一条（重试不重写代码）",
            len(await rows_of(s, "r-start", "implement")) == 1)

        # Classify configuration removed while awaiting external execution.
        _, gate3 = await make_run(s, "r-poll", "t-poll", NODES, "releaseChain",
                                  "waiting_external", {"output": {"ok": True}})
        await workflow_engine.tick(s)
        gate3 = await s.get(am.NodeRun, "ng-r-poll")
        run3 = await s.get(am.WorkflowRun, "r-poll")
        chk("③ 轮询发现配置缺失：failed + configuration",
            gate3.state == "failed" and
            (gate3.output or {}).get("failureKind") == "configuration",
            (gate3.state, gate3.output))
        chk("③ implement 没有被回卷重跑",
            len(await rows_of(s, "r-poll", "implement")) == 1)
        chk("③ run 干净失败", run3.state == "failed", run3.state)

        # Allow contract or uncategorized failures to use real rework logic.
        _, gate4 = await make_run(s, "r-con", "t-contract", NODES, "releaseChain", "failed",
                                  {"output": workflow_contracts.failure_output(
                                      "contract", outputReceipt={}),
                                   "error": "AI 已完成，但没有交付节点约定的产出"})
        did = await workflow_engine._begin_rework(
            s, await s.get(am.WorkflowRun, "r-con"), gate4,
            {"retryFrom": "implement", "maxRounds": 2}, "缺产出，重做")
        await s.commit()
        impl4 = await rows_of(s, "r-con", "implement")
        chk("回归：contract 类失败仍会回卷（重做上游是解法）",
            did is True and impl4[0].state == "rework",
            (did, [(x.attempt, x.state) for x in impl4]))
        chk("回归：回卷记了 run.rework", len(await events_of(s, "r-con", "run.rework")) == 1)

        # Repeated missing quality status permits bounded gate retry, never implementation rework.
        _, gate5 = await make_run(s, "r-q", "t-q", QNODES, "quality", "waiting_external",
                                  {"output": {"statusMisses": 3},
                                   "executor": {"runnerId": "rx"}})
        real_get, real_call = workflow_engine.runner_hub.get, workflow_engine.runner_hub.call_sync
        try:
            workflow_engine.runner_hub.get = lambda rid: object() if rid == "rx" else None
            workflow_engine.runner_hub.call_sync = (
                lambda runner, method, params, timeout: {"ok": False, "error": "RPC 联系不上"})
            await workflow_engine.tick(s)
        finally:
            workflow_engine.runner_hub.get = real_get
            workflow_engine.runner_hub.call_sync = real_call
        qrows = await rows_of(s, "r-q", "quality")
        run5 = await s.get(am.WorkflowRun, "r-q")
        chk("④ 第 4 次读不到：failed + infrastructure",
            qrows[0].state == "failed" and
            (qrows[0].output or {}).get("failureKind") == "infrastructure",
            [(x.state, x.output) for x in qrows])
        chk("④ implement 没有被回卷重跑（不许拿代码给通道故障背锅）",
            len(await rows_of(s, "r-q", "implement")) == 1)
        chk("④ maxAttempts 内门禁自己整关重试了（attempt=2 已排队）",
            len(qrows) == 2 and qrows[1].attempt == 2 and qrows[1].state == "queued",
            [(x.attempt, x.state) for x in qrows])
        chk("④ run 还活着（没被判死也没回卷）", run5.state == "running", run5.state)
        chk("④ 拦截有痕（rework.suppressed）",
            len(await events_of(s, "r-q", "rework.suppressed")) == 1)

        # Prefer a Runner's explicit infrastructure category over heuristic text classification.
        _, gate6 = await make_run(
            s, "r-q-runner", "t-q-runner", QNODES, "quality", "waiting_external",
            {"output": {"statusMisses": 0}, "executor": {"runnerId": "rx"}})
        real_get, real_call = workflow_engine.runner_hub.get, workflow_engine.runner_hub.call_sync
        try:
            workflow_engine.runner_hub.get = lambda rid: object() if rid == "rx" else None
            workflow_engine.runner_hub.call_sync = lambda *_args, **_kwargs: {
                "ok": True, "state": "failed", "failureKind": "infrastructure",
                "failurePath": "runner", "error": "Maven 工程测试（Docker）未通过",
                "result": {"checks": [{"name": "Maven 工程测试（Docker）", "ok": False,
                                       "detail": "buildx component is missing"}],
                           "commit": "abc"},
                "log": "BuildKit is enabled but the buildx component is missing or broken",
            }
            await workflow_engine.tick(s)
        finally:
            workflow_engine.runner_hub.get = real_get
            workflow_engine.runner_hub.call_sync = real_call
        qrunner_rows = await rows_of(s, "r-q-runner", "quality")
        chk("⑤ Runner infrastructure 原样透传到节点证据",
            qrunner_rows[0].state == "failed"
            and (qrunner_rows[0].output or {}).get("failureKind") == "infrastructure"
            and (qrunner_rows[0].output or {}).get("failurePath") == "runner",
            [(x.state, x.output) for x in qrunner_rows])
        chk("⑤ 宿主故障只重试质量关，不创建新的实现尝试",
            len(qrunner_rows) == 2 and qrunner_rows[1].state == "queued"
            and len(await rows_of(s, "r-q-runner", "implement")) == 1,
            [(x.attempt, x.state) for x in qrunner_rows])

        # Recover fixed-commit evidence after historical incorrect rework and retry quality only.
        old_run, old_gate = await make_run(
            s, "r-q-old", "t-q-old", QNODES, "quality", "rework")
        commit = "a" * 40
        artifact = am.ArtifactVersion(
            id="av-q-old", task_id="t-q-old", seq=1, kind="code",
            source_ref="refs/changes/01/1/1", commit_sha=commit,
            branch="refs/changes/01/1/1", target="develop",
            checksum="b" * 64, state="candidate")
        original = (await rows_of(s, "r-q-old", "implement"))[0]
        original.state = "rework"
        original.output = {
            "gitHead": commit,
            "gitDelivery": {"artifactVersionId": artifact.id, "commit": commit,
                            "branch": artifact.branch, "target": artifact.target},
        }
        s.add(artifact)
        s.add(am.NodeRun(
            id="ni-r-q-old-3", run_id="r-q-old", node_key="implement",
            node_type="ai", attempt=3, state="failed",
            idempotency_key="r-q-old:implement:3",
            output={"failureKind": "execution_policy"},
            error="旧引擎把提交说明误判成执行命令"))
        old_run.state, old_run.error = "failed", "旧质量关基础设施故障"
        await s.commit()
        ambiguous = ""
        try:
            await workflow_runs.retry_failed_gate(s, old_run, actor="tester")
        except ValueError as exc:
            ambiguous = str(exc)
        chk("⑥ 通用重试遇到多个历史失败关时拒绝猜测",
            "多个可重试关卡" in ambiguous and old_run.state == "failed",
            (ambiguous, old_run.state))
        retried = await workflow_runs.retry_failed_quality(s, old_run, actor="tester")
        recovered_impl = await rows_of(s, "r-q-old", "implement")
        old_quality = await rows_of(s, "r-q-old", "quality")
        pending = list((await s.execute(select(am.WorkflowOutbox).where(
            am.WorkflowOutbox.run_id == "r-q-old",
            am.WorkflowOutbox.status == "pending"
        ))).scalars().all())
        chk("⑥ 固定 Gerrit 提交生成显式证据恢复节点，旧节点不被改写",
            len(recovered_impl) == 3
            and recovered_impl[-1].attempt == 4
            and recovered_impl[-1].state == "succeeded"
            and (recovered_impl[-1].output or {}).get("evidenceRecovery", {}).get(
                "artifactVersionId") == artifact.id
            and recovered_impl[0].state == "rework"
            and recovered_impl[1].state == "failed",
            [(x.attempt, x.state, x.output) for x in recovered_impl])
        chk("⑥ 只排队 quality#2，没有新的 AI 执行 outbox",
            retried.node_type == "quality" and retried.attempt == 2
            and old_quality[-1].state == "queued"
            and len(pending) == 1 and pending[0].node_run_id == retried.id,
            [(x.node_run_id, x.topic) for x in pending])
        chk("⑥ 流程恢复为 running，重试输入写明复用了哪个证据",
            old_run.state == "running"
            and bool((retried.input or {}).get("manualRetry", {}).get(
                "recoveredDependencies")), (old_run.state, retried.input))

    print("\nrework guard smoke: %d passed, %d failed" % (ok, fail))
    return 1 if fail else 0


sys.exit(asyncio.run(main()))
