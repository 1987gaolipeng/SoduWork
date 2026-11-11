# -*- coding: utf-8 -*-
"""Internal golden path: task -> AI review -> Runner merge -> deploy -> human UAT -> done."""
from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timezone

from sqlalchemy import select


DB = os.path.abspath(".smoke-golden-delivery.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import (ai_remote, code_delivery, deployments, environment_service,  # noqa: E402
                          preflight_evidence, release_control, task_trace, workflow_engine)


passed = failed = 0


def check(name: str, condition, detail="") -> None:
    global passed, failed
    if condition:
        passed += 1
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name + ("  << " + str(detail)[:500] if detail else ""))


async def main() -> None:
    await init_db()
    async with SessionLocal() as session:
        await release_control.bootstrap(session)
        org = models.OrgUnit(id="org-golden", name="黄金交付事业部")
        release_role = models.Role(id="role-golden-release", name="发布授权人",
                                   permissions=["delivery.deploy"])
        acceptance_role = models.Role(id="role-golden-accept", name="业务验收人",
                                      permissions=["delivery.accept"])
        requester = models.User(id="u-golden-requester", username="requester",
                                display_name="需求提出人", org_id=org.id, is_active=True)
        task_owner = models.User(id="u-golden-owner", username="owner",
                                 display_name="任务承接人", org_id=org.id, is_active=True)
        project_owner = models.User(id="u-golden-project", username="project-owner",
                                    display_name="项目负责人", org_id=org.id, is_active=True)
        release_authorizer = models.User(
            id="u-golden-release", username="release-authorizer", display_name="发布授权人",
            org_id=org.id, role_id=release_role.id, is_active=True)
        business_acceptor = models.User(
            id="u-golden-accept", username="business-acceptor", display_name="业务验收人",
            org_id=org.id, role_id=acceptance_role.id, is_active=True)
        outsider = models.User(id="u-golden-outsider", username="outsider",
                               display_name="无关人员", org_id=org.id, is_active=True)
        client = models.Client(id="c-golden", name="承接人电脑", user_ref=task_owner.id,
                               git_creds={"type": "token", "username": "golden", "token": "x"})
        project = models.Project(id="p-golden", name="内部黄金项目", org_id=org.id,
                                 owner_user_id=project_owner.id, created_by=requester.id)
        repo = models.Repo(id="repo-golden", project_id=project.id, name="应用",
                           org_id=org.id,
                           git_url="https://git.example/golden.git", default_branch="main",
                           merge_branch="main")
        deploy_policy = am.ApprovalPolicy(
            id="policy-golden-deploy", org_id=org.id, key="golden-deploy",
            name="发布授权职责", enabled=True, rules={
                "actions": ["deploy"], "mode": "any", "required": 1,
                "approvers": [{"type": "permission", "key": "delivery.deploy",
                               "label": "发布授权人"}],
                "invalidateOnNewVersion": True, "separationOfDuties": True})
        acceptance_policy = am.ApprovalPolicy(
            id="policy-golden-uat", org_id=org.id, key="golden-uat",
            name="项目与业务共同验收", enabled=True, rules={
                "actions": ["uat"], "mode": "threshold", "required": 2,
                "approvers": [{"type": "project_owner", "label": "项目负责人"},
                              {"type": "permission", "key": "delivery.accept",
                               "label": "业务验收人"}],
                "invalidateOnNewVersion": True, "separationOfDuties": True})
        environment = am.Environment(
            id="env-golden", org_id=org.id, key="verification", name="trial 验证环境",
            approval_policy_id=deploy_policy.id,
            acceptance_policy_id=acceptance_policy.id, enabled=True,
            promotion_policy={"autoStart": True, "requires": [],
                              "requiresApproval": True, "requiresAcceptance": True,
                              "marksDelivery": True})
        target = am.DeploymentTarget(
            id="target-golden", repo_id=repo.id, environment_id=environment.id,
            name="trial 应用", provider="runner-command",
            config={"argv": ["deploy-golden"], "timeoutSeconds": 60, "env": {}, "cwd": "repo"},
            health_checks=[{"type": "http", "name": "版本可用",
                            "url": "http://staging.example.com/health", "expectStatus": 200,
                            "timeoutSeconds": 10}], rollback={"mode": "manual"}, enabled=True)
        task = models.Task(
            id="t-golden", title="从需求交付到验证环境", status="todo",
            owner_client_id=client.id, created_by=requester.id,
            requester_user_id=requester.id, assignee_user_id=task_owner.id,
            project_id=project.id, repo_id=repo.id)
        plugin = am.Plugin(id="plugin-golden", key="golden-delivery",
                           name="黄金交付流程", enabled=True)
        version = am.PluginVersion(
            id="version-golden", plugin_id=plugin.id, version="1.0.0", checksum="golden",
            manifest={}, workflow={"nodes": [{"key": "delivery", "name": "交付闭环",
                                                "type": "publish", "dependsOn": [],
                                                "config": {}, "outputs": [],
                                                "retry": {"maxAttempts": 1}}]},
            trust_state="approved", enabled=True)
        binding = am.PluginBinding(id="binding-golden", plugin_id=plugin.id,
                                   version_id=version.id, project_id=project.id, enabled=True)
        session.add_all([org, release_role, acceptance_role, requester, task_owner,
                         project_owner, release_authorizer, business_acceptor, outsider,
                         client, project, repo, deploy_policy, acceptance_policy,
                         environment, target, task, plugin, version, binding])
        await session.commit()
        await preflight_evidence.record(
            session, subject_kind="repository", subject_id=repo.id, check_kind="scm.read",
            config_fingerprint=environment_service.repo_probe_fingerprint(repo), ok=True,
            summary="Runner 已读取目标分支", executor_id="runner-golden",
            executor_name="trial Runner", detail={"target": "main", "head": "base"})
        await preflight_evidence.record(
            session, subject_kind="deployment_target", subject_id=target.id,
            check_kind="deploy.preflight",
            config_fingerprint=environment_service.target_probe_fingerprint(
                target, environment, repo, {}), ok=True,
            summary="部署命令与 Runner 已就绪", executor_id="runner-golden",
            executor_name="trial Runner", detail={"commandState": "available"})
        await session.commit()

        check("黄金链由六个互不混用的真人职责共同参与",
              len({requester.id, task_owner.id, project_owner.id, release_authorizer.id,
                   business_acceptor.id, outsider.id}) == 6)

        requirements = am.ArtifactVersion(
            id="artifact-golden-requirements", task_id=task.id, seq=1,
            kind="requirement", checksum="requirements-golden", state="candidate",
            created_by_kind="ai", created_by_name="Pi")
        session.add(requirements)
        await session.commit()
        baseline = await release_control.ensure_request(
            session, task, requirements, "baseline", context={"summary": "确认需求基线"})
        baseline_result = await release_control.decide(
            session, task, requester, action="baseline", decision="approve",
            artifact_version_id=requirements.id, note="目标和验收标准已经确认")
        check("需求提出人确认 AI 整理的需求基线",
              baseline_result.get("ok") and baseline.status == "approved"
              and requirements.state == "baselined", baseline_result)

        run = await workflow_engine.start(session, task, binding, {}, actor_id=requester.id)
        check("工作流启动即把任务切为进行中", task.status == "doing", task.status)

        artifact, created = await release_control.ensure_code_candidate(session, task, {
            "branch": "soduwork/t-golden", "target": "main",
            "commits": [{"sha": "a" * 40, "subject": "deliver feature"}],
            "files": ["app.py", "tests/test_app.py"],
        }, who="Pi")
        requests = list((await session.execute(select(am.ApprovalRequest).where(
            am.ApprovalRequest.task_id == task.id,
            am.ApprovalRequest.action.in_(("review", "merge")),
        ))).scalars().all())
        check("插件代码候选不会创建人工代码审查或合并票", created and not requests, requests)

        await release_control.record_ai_review(session, task, artifact, {
            "verdict": "pass", "reportChecksum": "review-" + "b" * 56,
            "summary": "需求覆盖、边界和测试证据通过", "findings": [],
            "checks": ["需求覆盖", "测试证据", "安全边界"],
        }, source={"runId": run.id, "runnerId": "runner-golden"})
        authorized_artifact, authorized = await release_control.merge_authorization(
            session, task.id)
        check("结构化 AI 审查绑定固定提交并直接授权自动合并",
              authorized and authorized_artifact.id == artifact.id)

        original_merge = ai_remote.git_merge_sync
        ai_remote.git_merge_sync = lambda route, payload: {
            "ok": route.get("runnerId") == "runner-golden",
            "commit": "merge-golden", "branch": payload.get("branch"),
            "target": payload.get("target")}
        try:
            merged = await code_delivery.ship(
                session, task, repo, artifact.branch, who="SoduWork",
                git_creds={"token": "memory-only"},
                scm={"provider": "runner", "runnerId": "runner-golden"})
        finally:
            ai_remote.git_merge_sync = original_merge
        human_code_gates = list((await session.execute(select(am.ApprovalRequest).where(
            am.ApprovalRequest.task_id == task.id,
            am.ApprovalRequest.action.in_(("review", "merge")),
        ))).scalars().all())
        check("合并由原 Runner 的干净镜像执行且不依赖 Hub 本地目录",
              merged.get("ok") and not repo.server_dir, merged)
        check("代码审查与合并全程没有依赖人工票", not human_code_gates, human_code_gates)

        gate = await deployments.queue_automatic(session, task, "SoduWork")
        deploy_request = (await session.execute(select(am.ApprovalRequest).where(
            am.ApprovalRequest.task_id == task.id,
            am.ApprovalRequest.action == "deploy",
            am.ApprovalRequest.environment_id == environment.id,
        ))).scalar_one()
        deploy_assignments = list((await session.execute(select(am.ApprovalAssignment).where(
            am.ApprovalAssignment.request_id == deploy_request.id
        ))).scalars().all())
        check("发布链先停在明确的发布授权人，而不是由超级管理员代办",
              gate.get("pendingApproval") and not gate.get("runs")
              and {x.user_id for x in deploy_assignments} == {release_authorizer.id},
              {"gate": gate, "assignments": [x.user_id for x in deploy_assignments]})
        denied_deploy = await release_control.decide(
            session, task, outsider, action="deploy", decision="approve",
            artifact_version_id=artifact.id, environment_id=environment.id,
            note="我不应该有发布权限")
        check("无关人员不能越权批准环境发布",
              not denied_deploy.get("ok") and denied_deploy.get("reason") == "forbidden",
              denied_deploy)
        approved_deploy = await release_control.decide(
            session, task, release_authorizer, action="deploy", decision="approve",
            artifact_version_id=artifact.id, environment_id=environment.id,
            note="发布版本、目标环境和回滚入口已核对")
        check("发布授权人批准固定版本进入 trial 验证环境",
              approved_deploy.get("ok") and deploy_request.status == "approved",
              approved_deploy)

        original_start = deployments._start

        async def fake_start(s, deployment):
            deployment.state = "running"
            deployment.runner_id = "runner-golden"
            deployment.started_at = datetime.now(timezone.utc)
            await s.commit()

        deployments._start = fake_start
        try:
            queued = await deployments.queue_automatic(session, task, "SoduWork")
        finally:
            deployments._start = original_start
        deployment = (await session.execute(select(am.DeploymentRun).where(
            am.DeploymentRun.task_id == task.id
        ))).scalar_one()
        check("合并后按任意声明式环境自动排入发布", queued.get("runs") and
              deployment.runner_id == "runner-golden", queued)
        deployment.state = "succeeded"
        deployment.result = {"checks": [{"name": "版本可用", "ok": True,
                                           "evidence": "HTTP 200 + version"}]}
        deployment.finished_at = datetime.now(timezone.utc)
        await session.commit()
        await deployments._after_terminal(session, deployment)
        uat = (await session.execute(select(am.ApprovalRequest).where(
            am.ApprovalRequest.task_id == task.id,
            am.ApprovalRequest.action == "uat",
            am.ApprovalRequest.environment_id == environment.id,
        ))).scalar_one_or_none()
        check("部署成功只发起业务验收，不提前把任务伪装成完成",
              uat is not None and uat.status == "pending" and task.status == "doing", uat)
        pending_chain = await deployments.chain_status(session, task)
        check("release chain identifies the pending UAT request for client workflow state",
              pending_chain.get("pendingAcceptance")
              and pending_chain.get("requestId") == uat.id,
              pending_chain)
        uat_assignments = list((await session.execute(select(am.ApprovalAssignment).where(
            am.ApprovalAssignment.request_id == uat.id
        ))).scalars().all())
        check("业务验收明确分给项目负责人和业务验收人",
              {x.user_id for x in uat_assignments} == {
                  project_owner.id, business_acceptor.id},
              [x.user_id for x in uat_assignments])
        denied_uat = await release_control.decide(
            session, task, task_owner, action="uat", decision="approve",
            artifact_version_id=artifact.id, environment_id=environment.id,
            note="任务承接人不能代替业务验收")
        check("任务承接人不能审批自己未被分配的验收",
              not denied_uat.get("ok") and denied_uat.get("reason") == "forbidden",
              denied_uat)



        session.add(models.Attachment(
            task_id=task.id, filename="环境验收截图.png", content_type="image/png",
            size=2048, role="verification", uploaded_by=business_acceptor.id,
            evidence_meta={"kind": "screenshot", "gateRequestId": uat.id,
                           "verification": {"state": "passed",
                                            "by": business_acceptor.id}}))
        await session.commit()
        owner_vote = await release_control.decide(
            session, task, project_owner, action="uat", decision="approve",
            artifact_version_id=artifact.id, environment_id=environment.id,
            note="工程范围与固定提交一致")
        check("项目负责人一票后仍等待业务验收，不会提前完成",
              owner_vote.get("ok") and uat.status == "pending" and task.status == "doing",
              owner_vote)
        accept_vote = await release_control.decide(
            session, task, business_acceptor, action="uat", decision="approve",
            artifact_version_id=artifact.id, environment_id=environment.id,
            note="真实页面与验收标准一致")
        check("业务验收人第二票完成会签",
              accept_vote.get("ok") and uat.status == "approved", accept_vote)
        node = (await session.execute(select(am.NodeRun).where(
            am.NodeRun.run_id == run.id
        ))).scalar_one()
        node.state = "succeeded"
        node.finished_at = datetime.now(timezone.utc)
        run.state = "succeeded"
        run.finished_at = datetime.now(timezone.utc)
        await session.commit()
        completed = await deployments.continue_after_acceptance(
            session, task, environment.id, business_acceptor.display_name)
        check("人工只做最终业务验收，通过后任务才正式完成",
              completed.get("complete") and task.status == "done" and artifact.state == "released",
              completed)

        await session.refresh(task)
        trace = await task_trace.trace(session, task)
        check("客户端统一全链路包含 AI、合并、部署、验收和证据",
              bool(trace.get("stages")) and bool(trace.get("deployments")) and
              any(item.get("action") == "deploy" for item in trace.get("approvals") or []) and
              any(item.get("action") == "uat" for item in trace.get("approvals") or []) and
              any(item.get("kind") == "release.ai_reviewed"
                  for item in trace.get("timeline") or []), trace.get("summary"))


async def run() -> None:
    try:
        await main()
    finally:
        await engine.dispose()
        for suffix in ("", "-shm", "-wal"):
            try:
                os.remove(DB + suffix)
            except FileNotFoundError:
                pass


asyncio.run(run())
print(f"\ngolden delivery: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
