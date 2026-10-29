# -*- coding: utf-8 -*-
"""Workflow evidence adoption: reuse audited gates, never replay or fake deployment."""
import asyncio
import os
import shutil
import sys

DB = os.path.abspath(".smoke-workflow-adoption.db")
DATA = os.path.abspath(".smoke-workflow-adoption-data")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
shutil.rmtree(DATA, ignore_errors=True)
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
os.environ["SODUWORK_DATA_ROOT"] = DATA
sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import delivery_truth, workflow_engine  # noqa: E402

passed = failed = 0
lines = []


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        lines.append("  PASS  " + name)
    else:
        failed += 1
        lines.append("  FAIL  " + name + ("  << " + str(detail)[:300] if detail else ""))


PREFIX = [
    {"key": "analyze", "type": "ai"},
    {"key": "baseline", "type": "spec", "dependsOn": ["analyze"]},
    {"key": "implement", "type": "ai", "dependsOn": ["baseline"]},
    {"key": "quality", "type": "quality", "dependsOn": ["implement"]},
    {"key": "review", "type": "human_review", "dependsOn": ["quality"]},
    {"key": "mergeApproval", "type": "approval", "dependsOn": ["review"]},
    {"key": "merge", "type": "merge", "dependsOn": ["mergeApproval"]},
]


async def main():
    await init_db()
    async with SessionLocal() as session:
        user = models.User(id="u-adopt", username="adopt", display_name="验收人",
                           is_super=True, is_active=True)
        client = models.Client(id="c-adopt", user_ref=user.id, name="验收 SoduWork")
        project = models.Project(id="p-adopt", name="续接工程")
        repo = models.Repo(id="r-adopt", project_id=project.id, name="续接仓库",
                           git_url="https://example.invalid/repo.git", default_branch="develop")
        task = models.Task(id="t-adopt", owner_client_id=client.id, title="续接发布链",
                           project_id=project.id, repo_id=repo.id,
                           created_by=user.id, created_by_name=user.display_name, status="doing")
        plugin = am.Plugin(id="plugin-adopt", key="software-delivery", name="研发交付",
                           enabled=True)
        old_version = am.PluginVersion(
            id="version-old", plugin_id=plugin.id, version="1.0.0", checksum="old",
            manifest={}, workflow={"nodes": PREFIX + [
                {"key": "deployTest", "type": "deploy", "dependsOn": ["merge"]},
            ]}, trust_state="approved", enabled=True)
        new_version = am.PluginVersion(
            id="version-new", plugin_id=plugin.id, version="1.1.0", checksum="new",
            manifest={}, workflow={"nodes": PREFIX + [
                {"key": "releaseChain", "type": "deploy_chain", "dependsOn": ["merge"],
                 "config": {"onFailure": {"retryFrom": "implement", "maxRounds": 2}}},
                {"key": "publish", "type": "publish", "dependsOn": ["releaseChain"],
                 "config": {"message": "发布完成"}},
            ]}, trust_state="approved", enabled=True)
        binding = am.PluginBinding(id="binding-new", plugin_id=plugin.id,
                                   version_id=new_version.id, project_id=project.id,
                                   enabled=True)
        source_run = am.WorkflowRun(
            id="run-old", task_id=task.id, plugin_id=plugin.id,
            plugin_version_id=old_version.id, binding_id="binding-old", state="failed")
        race_task = models.Task(
            id="t-schedule-race", owner_client_id=client.id, title="并发调度保护",
            project_id=project.id, repo_id=repo.id, created_by=user.id,
            created_by_name=user.display_name, status="doing")
        race_run = am.WorkflowRun(
            id="run-schedule-race", task_id=race_task.id, plugin_id=plugin.id,
            plugin_version_id=new_version.id, binding_id=binding.id, state="running")
        session.add_all([user, client, project, repo, task, plugin, old_version,
                         new_version, binding, source_run, race_task, race_run])
        await session.flush()

        requirement = am.ArtifactVersion(
            id="artifact-requirement", task_id=task.id, seq=1, kind="requirement",
            checksum="requirement", state="baselined")
        artifact = am.ArtifactVersion(
            id="artifact-code", task_id=task.id, seq=2, kind="code", checksum="code",
            branch="feat/forum", target="develop", commit_sha="910840f", state="merged")
        baseline = am.ApprovalRequest(
            id="approval-baseline", task_id=task.id, artifact_version_id=requirement.id,
            action="baseline", status="approved")
        review = am.ApprovalRequest(
            id="approval-review", task_id=task.id, artifact_version_id=artifact.id,
            action="review", status="approved")
        merge = am.ApprovalRequest(
            id="approval-merge", task_id=task.id, artifact_version_id=artifact.id,
            action="merge", status="approved")
        session.add_all([requirement, artifact, baseline, review, merge])
        outputs = {
            "analyze": {"attachments": [{"filename": "requirements.md"}]},
            "baseline": {"requestId": baseline.id, "artifactVersionId": requirement.id},
            "implement": {"gitBranch": "feat/forum", "gitHead": "5dfb70b"},
            "quality": {"checks": [
                {"name": "后端测试", "ok": True}, {"name": "前端构建", "ok": True},
            ]},
            "review": {"requestId": review.id, "artifactVersionId": artifact.id},
            "mergeApproval": {"requestId": merge.id, "artifactVersionId": artifact.id},
            "merge": {"ok": True, "commit": "910840f", "target": "develop"},
        }
        for index, definition in enumerate(PREFIX, 1):
            session.add(am.NodeRun(
                id="source-node-" + definition["key"], run_id=source_run.id,
                node_key=definition["key"], node_type=definition["type"], attempt=1,
                state="succeeded", output=outputs[definition["key"]],
                idempotency_key=f"old:{index}"))
        await session.commit()

        async def schedule_race() -> None:
            async with SessionLocal() as isolated:
                isolated_run = await isolated.get(am.WorkflowRun, race_run.id)
                await workflow_engine._schedule(isolated, isolated_run)

        await asyncio.gather(schedule_race(), schedule_race())
        async with SessionLocal() as isolated:
            race_nodes = list((await isolated.execute(select(am.NodeRun).where(
                am.NodeRun.run_id == race_run.id,
                am.NodeRun.node_key == "analyze",
            ))).scalars().all())
            race_outboxes = list((await isolated.execute(select(am.WorkflowOutbox).where(
                am.WorkflowOutbox.run_id == race_run.id,
                am.WorkflowOutbox.status == "pending",
            ))).scalars().all())
        check("启动接口与后台轮询并发时只创建一个节点尝试",
              len(race_nodes) == 1 and race_nodes[0].attempt == 1, race_nodes)
        check("并发调度只留下一个待执行事件",
              len(race_outboxes) == 1
              and race_outboxes[0].node_run_id == race_nodes[0].id, race_outboxes)

        artifact.commit_sha = "different"
        await session.commit()
        mismatch_rejected = False
        try:
            await workflow_engine.start_from_evidence(
                session, task, binding, {}, source_run=source_run,
                target_key="releaseChain", actor_id=user.id)
        except ValueError as exc:
            mismatch_rejected = "不一致" in str(exc)
            await session.rollback()
        check("历史合并提交与当前产出不一致时拒绝续接", mismatch_rejected)
        artifact = await session.get(am.ArtifactVersion, "artifact-code")
        task = await session.get(models.Task, "t-adopt")
        binding = await session.get(am.PluginBinding, "binding-new")
        source_run = await session.get(am.WorkflowRun, "run-old")
        artifact.commit_sha = "910840f"
        await session.commit()

        old_queue = workflow_engine.deployments.queue_automatic
        old_chain = workflow_engine.deployments.chain_status
        chain_complete = False
        chain_failed = False

        async def fake_queue(*_args, **_kwargs):
            return {"ok": True, "runs": []}

        async def fake_chain(*_args, **_kwargs):
            return {"ok": not chain_failed, "complete": chain_complete,
                    "failed": chain_failed,
                    "error": "temporary deployment infrastructure failure" if chain_failed else "",
                    "environments": [{"name": "任意企业环境", "state": "succeeded"
                                      if chain_complete else "queued"}]}

        workflow_engine.deployments.queue_automatic = fake_queue
        workflow_engine.deployments.chain_status = fake_chain
        try:
            run = await workflow_engine.start_from_evidence(
                session, task, binding, {}, source_run=source_run,
                target_key="releaseChain", actor_id="u-adopt")
            detail = await workflow_engine.run_api(session, run)
            adopted = [node for node in detail["nodes"] if node["state"] == "succeeded"]
            check("新版流程完整复用七个同类型上游节点", len(adopted) == 7, detail["nodes"])
            check("续接清单固定来源运行、产出与提交",
                  run.context["adoption"]["sourceRunId"] == source_run.id
                  and run.context["adoption"]["artifactVersionId"] == artifact.id
                  and run.context["adoption"]["commit"] == "910840f", run.context)
            check("每个复用节点都指回不可变来源节点",
                  all((node["output"].get("adoptedFrom") or {}).get("runId") == source_run.id
                      for node in adopted), adopted)
            check("新版发布链自身仍排队真执行而非被伪造为成功",
                  any(node["key"] == "releaseChain" and node["state"] == "queued"
                      for node in detail["nodes"]), detail["nodes"])
            events = list((await session.execute(select(am.WorkflowEvent).where(
                am.WorkflowEvent.run_id == run.id))).scalars().all())
            check("续接动作留下逐节点审计事件",
                  sum(event.kind == "node.adopted" for event in events) == 7)

            await workflow_engine.tick(session)
            waiting = await workflow_engine.run_api(session, run)
            check("发布链等待真实环境证据",
                  any(node["key"] == "releaseChain" and node["state"] == "waiting_external"
                      for node in waiting["nodes"]), waiting)
            chain_failed = True
            await workflow_engine.tick(session)
            protected = await workflow_engine.run_api(session, run)
            adopted_after_failure = [node for node in protected["nodes"]
                                     if node["key"] in {item["key"] for item in PREFIX}]
            check("发布基础设施失败不回退已采信的开发链",
                  protected["state"] == "failed"
                  and all(node["state"] == "succeeded" for node in adopted_after_failure)
                  and sum(node["key"] == "implement" for node in protected["nodes"]) == 1,
                  protected)
            retried = await workflow_engine.retry_failed_gate(
                session, run, actor="u-adopt")
            check("发布链可在修复配置后原地重试",
                  retried.node_key == "releaseChain" and retried.attempt == 2
                  and run.state == "running", workflow_engine.node_api(retried))
            chain_failed = False
            await workflow_engine.tick(session)
            chain_complete = True
            await workflow_engine.tick(session)
            await workflow_engine.tick(session)
            completed = await workflow_engine.run_api(session, run)
            truth = await delivery_truth.evaluate(session, task)
            check("真实环境完成后才允许流程发布完成",
                  completed["state"] == "succeeded" and task.status == "done",
                  {"delivery": truth, "run": completed})
        finally:
            workflow_engine.deployments.queue_automatic = old_queue
            workflow_engine.deployments.chain_status = old_chain


async def run():
    try:
        await main()
    finally:
        await engine.dispose()


try:
    asyncio.run(run())
finally:
    for suffix in ("", "-shm", "-wal"):
        try:
            os.remove(DB + suffix)
        except FileNotFoundError:
            pass
    shutil.rmtree(DATA, ignore_errors=True)

print("\n".join(lines))
print(f"\nworkflow adoption smoke: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
