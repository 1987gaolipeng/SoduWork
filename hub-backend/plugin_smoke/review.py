"""Human decisions, rework and deployment completion."""
from sqlalchemy import select
from app import automation_models as am
from app import models
from app.services import plugin_service
from app.services import release_control
from app.services import workflow_control
from app.services import workflow_engine
from .support import BASE, package


async def review(chk, actor, approved):
    'Version-bound human decisions and explicit rework limits.'
    session, creator, box, task = actor.session, actor.creator, actor.box, actor.task
    creator_id, creator_name, box_id = creator.id, creator.display_name, box.id
    plugin, version, binding = approved.plugin, approved.version, approved.binding
    run = await workflow_engine.start(session, task, binding, {"ready": True}, actor_id=creator_id)
    await workflow_engine.tick(session)
    await workflow_engine.tick(session)
    current = await workflow_engine.run_api(session, run)
    review_node = next((x for x in current["nodes"] if x["key"] == "review"), None)
    chk("DAG 持久化推进到人工审阅门",
        review_node is not None and review_node["state"] == "waiting_human", current)
    artifact = await release_control.latest_artifact(session, task.id)
    decision = await release_control.decide(
        session, task, creator, action="review", decision="approve",
        artifact_version_id=artifact.id)
    chk("人工决定绑定当时的不可变产出版本", decision.get("ok"))
    await workflow_engine.tick(session)
    await workflow_engine.tick(session)
    finished = await workflow_engine.run_api(session, run)
    chk("审阅后继续发布并办结任务",
        finished["state"] == "succeeded" and task.status == "done"
        and task.result == "插件交付完成", finished)
    chk("每个节点保存独立尝试与证据",
        [x["state"] for x in finished["nodes"]] == ["succeeded", "succeeded", "succeeded"],
        finished["nodes"])
    summaries = await workflow_engine.list_runs(session, task_id=task.id)
    chk("运行列表只取轻量摘要，完整证据按需打开",
        len(summaries) == 1 and "nodes" not in summaries[0] and "events" not in summaries[0],
        summaries)

    # Human rejection follows onReject to a new attempt whose outputs must pass the gates again.
    rework_manifest = {**BASE, "key": "smoke-rework", "name": "自动返修冒烟"}
    rework_flow = {"nodes": [
        {"key": "prepare", "type": "condition",
         "config": {"inputKey": "ready", "equals": True},
         "retry": {"maxAttempts": 1}},
        {"key": "review", "type": "human_review", "dependsOn": ["prepare"],
         "config": {"summary": "返修门", "onReject": {
             "retryFrom": "prepare", "maxRounds": 1}},
         "retry": {"maxAttempts": 1}},
        {"key": "publish", "type": "publish", "dependsOn": ["review"],
         "config": {"message": "返修后通过"}, "retry": {"maxAttempts": 3}},
    ]}
    rework_installed = await plugin_service.install(
        session, package(rework_manifest, rework_flow), creator, None)
    rework_plugin = await session.get(am.Plugin, rework_installed["plugin"]["id"])
    rework_version = (await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id == rework_plugin.id))).scalar_one()
    await plugin_service.approve_version(session, rework_version, True, creator_name)
    rework_binding = await plugin_service.save_binding(
        session, rework_plugin, {"versionId": rework_version.id})
    rework_task = models.Task(
        id="t-plugin-rework", owner_client_id=box_id, title="验证自动返修",
        created_by=creator_id, created_by_name=creator_name,
        artifact_url="https://preview.local/v1")
    session.add(rework_task)
    await session.commit()
    rework_run = await workflow_engine.start(
        session, rework_task, rework_binding, {"ready": True}, actor_id=creator_id)
    await workflow_engine.tick(session)
    await workflow_engine.tick(session)
    first_rework_artifact = await release_control.latest_artifact(session, rework_task.id)
    await release_control.decide(
        session, rework_task, creator, action="review", decision="reject",
        note="预览缺少错误状态", artifact_version_id=first_rework_artifact.id)
    await workflow_engine.tick(session)
    after_reject = await workflow_engine.run_api(session, rework_run)
    chk("自动尝试次数用完后，人工退回仍按独立返修额度续跑",
        after_reject["state"] == "running"
        and any(x["key"] == "prepare" and x["attempt"] == 2
                for x in after_reject["nodes"]), after_reject)
    rework_task.artifact_url = "https://preview.local/v2"
    await session.commit()
    await workflow_engine.tick(session)
    await workflow_engine.tick(session)
    second_rework_artifact = await release_control.latest_artifact(session, rework_task.id)
    second_wait = await workflow_engine.run_api(session, rework_run)
    chk("返修产生新版本并重新生成审批门",
        second_rework_artifact.id != first_rework_artifact.id
        and len([x for x in second_wait["nodes"] if x["key"] == "review"]) == 2
        and [x for x in second_wait["nodes"] if x["key"] == "review"][-1]["state"] == "waiting_human",
        second_wait)
    await release_control.decide(
        session, rework_task, creator, action="review", decision="approve",
        artifact_version_id=second_rework_artifact.id)
    await workflow_engine.tick(session)
    await workflow_engine.tick(session)
    rework_done = await workflow_engine.run_api(session, rework_run)
    chk("返修版本审批通过后继续完成原流程",
        rework_done["state"] == "succeeded" and rework_task.result == "返修后通过",
        rework_done)


async def deployments(chk, actor):
    'Deployment authorization, completion, acceptance and cancellation.'
    session, creator, box, task = actor.session, actor.creator, actor.box, actor.task
    creator_id, creator_name, box_id = creator.id, creator.display_name, box.id
    deploy_manifest = {**BASE, "key": "smoke-deploy-gate", "name": "发布门冒烟"}
    deploy_flow = {"nodes": [{
        "key": "production", "type": "deploy",
        "config": {"environmentId": release_control.ENV_PRODUCTION},
    }]}
    deploy_installed = await plugin_service.install(
        session, package(deploy_manifest, deploy_flow), creator, None)
    deploy_plugin = await session.get(am.Plugin, deploy_installed["plugin"]["id"])
    deploy_version = (await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id == deploy_plugin.id))).scalar_one()
    await plugin_service.approve_version(session, deploy_version, True, creator_name)
    deploy_binding = await plugin_service.save_binding(
        session, deploy_plugin, {"versionId": deploy_version.id})
    deploy_task = models.Task(
        id="t-plugin-deploy", owner_client_id=box_id, title="发布生产环境",
        created_by=creator_id, created_by_name=creator_name, status="doing")
    session.add(deploy_task)
    await session.flush()
    session.add(models.Attachment(
        id="att-plugin-deploy", task_id=deploy_task.id, filename="release.zip",
        content_type="application/zip", size=800, storage_key="smoke/release.zip",
        backend="local", uploaded_by="agent:runner", role="output",
        evidence_meta={"category": "primary",
                       "verification": {"state": "passed"}}))
    await session.commit()
    original_request = workflow_engine.deployments.request_environment

    async def fake_request(s, task_row, environment_id, who="SoduWork"):
        artifact_row, _ = await release_control.ensure_current_output(s, task_row, who=who)
        request = await release_control.ensure_request(
            s, task_row, artifact_row, "deploy", environment_id, {
                "requiredEvidence": [{
                    "id": "release-package", "label": "fixed release package",
                    "oneOf": ["file"],
                }],
            })
        await s.commit()
        if request.status != "approved":
            return {"ok": True, "pendingApproval": True,
                    "request": release_control.request_api(request), "runs": []}
        run_row = (await s.execute(select(am.DeploymentRun).where(
            am.DeploymentRun.task_id == task_row.id))).scalar_one_or_none()
        if run_row is None:
            run_row = am.DeploymentRun(
                task_id=task_row.id, artifact_version_id=artifact_row.id,
                environment_id=environment_id, target_id="target-smoke",
                state="queued", attempt=1, idempotency_key=artifact_row.id + ":target-smoke")
            s.add(run_row)
            await s.commit()
        return {"ok": True, "pendingApproval": False, "runs": [{"id": run_row.id}]}

    workflow_engine.deployments.request_environment = fake_request
    try:
        deploy_workflow = await workflow_engine.start(
            session, deploy_task, deploy_binding, {}, actor_id=creator_id)
        await workflow_engine.tick(session)
        awaiting = await workflow_engine.run_api(session, deploy_workflow)
        deploy_node = awaiting["nodes"][0]
        deploy_artifact = await release_control.latest_artifact(session, deploy_task.id)
        chk("生产发布节点先停在版本绑定审批门",
            deploy_node["state"] == "waiting_human" and deploy_node["output"].get("requestId"),
            deploy_node)
        await release_control.decide(
            session, deploy_task, creator, action="deploy", decision="approve",
            artifact_version_id=deploy_artifact.id,
            environment_id=release_control.ENV_PRODUCTION)
        await workflow_engine.tick(session)
        queued = await workflow_engine.run_api(session, deploy_workflow)
        chk("生产审批通过后真正进入部署等待而非直接成功",
            queued["nodes"][0]["state"] == "waiting_external", queued["nodes"][0])
        deployment = (await session.execute(select(am.DeploymentRun).where(
            am.DeploymentRun.task_id == deploy_task.id))).scalar_one()
        deployment.state = "succeeded"
        await session.commit()
        await workflow_engine.tick(session)
        deployed = await workflow_engine.run_api(session, deploy_workflow)
        chk("只有环境运行成功后发布节点才完成",
            deployed["state"] == "succeeded" and deployed["nodes"][0]["state"] == "succeeded",
            deployed)
    finally:
        workflow_engine.deployments.request_environment = original_request

    chain_manifest = {**BASE, "key": "smoke-enterprise-chain", "name": "企业环境链冒烟"}
    chain_flow = {"nodes": [{
        "key": "releaseChain", "type": "deploy_chain", "name": "走完企业发布链",
    }]}
    chain_installed = await plugin_service.install(
        session, package(chain_manifest, chain_flow), creator, None)
    chain_plugin = await session.get(am.Plugin, chain_installed["plugin"]["id"])
    chain_version = (await session.execute(select(am.PluginVersion).where(
        am.PluginVersion.plugin_id == chain_plugin.id))).scalar_one()
    await plugin_service.approve_version(session, chain_version, True, creator_name)
    chain_binding = await plugin_service.save_binding(
        session, chain_plugin, {"versionId": chain_version.id})
    chain_task = models.Task(
        id="t-plugin-chain", owner_client_id=box_id, title="验证企业环境链",
        created_by=creator_id, created_by_name=creator_name,
        repo_id="repo-plugin-smoke", project_id="project-plugin-smoke", status="doing")
    session.add(chain_task)
    await session.flush()
    chain_artifact, _ = await release_control.ensure_code_candidate(session, chain_task, {
        "commits": [{"sha": "chain123", "subject": "chain"}],
        "files": ["deploy.yml"], "branch": "feat/chain", "target": "main",
    }, who="SoduWork")
    chain_artifact.state = "merged"
    await session.commit()
    original_queue = workflow_engine.deployments.queue_automatic
    original_chain = workflow_engine.deployments.chain_status
    chain_complete = False
    chain_accepting = False

    async def fake_queue(*_args, **_kwargs):
        return {"ok": True, "runs": []}

    async def fake_chain(*_args, **_kwargs):
        if chain_accepting:
            return {"ok": True, "complete": False, "failed": False,
                    "pendingAcceptance": True, "requestId": "uat-chain-smoke",
                    "environments": [{"name": "trial validation", "deployed": True,
                                      "acceptance": "pending"}]}
        return {"ok": True, "complete": chain_complete, "failed": False,
                "environments": [{"name": "trial 验证环境", "deployed": chain_complete}]}

    workflow_engine.deployments.queue_automatic = fake_queue
    workflow_engine.deployments.chain_status = fake_chain
    try:
        chain_workflow = await workflow_engine.start(
            session, chain_task, chain_binding, {}, actor_id=creator_id)
        await workflow_engine.tick(session)
        chain_wait = await workflow_engine.run_api(session, chain_workflow)
        chk("通用发布链节点不写死环境名称并持续等待真实环境证据",
            chain_wait["nodes"][0]["state"] == "waiting_external", chain_wait)
        chain_accepting = True
        await workflow_engine.tick(session)
        chain_accept = await workflow_engine.run_api(session, chain_workflow)
        chk("deploy chain exposes environment acceptance as a human gate",
            chain_accept["nodes"][0]["state"] == "waiting_human"
            and chain_accept["nodes"][0]["output"].get("requestId") == "uat-chain-smoke",
            chain_accept)
        chain_accepting = False
        chain_complete = True
        await workflow_engine.tick(session)
        chain_done = await workflow_engine.run_api(session, chain_workflow)
        chk("企业配置的交付边界全部完成后通用发布链节点才成功",
            chain_done["state"] == "succeeded"
            and chain_done["nodes"][0]["state"] == "succeeded", chain_done)
    finally:
        workflow_engine.deployments.queue_automatic = original_queue
        workflow_engine.deployments.chain_status = original_chain

    cancel_task = models.Task(
        id="t-plugin-cancel", owner_client_id=box.id, title="结束旧验证流程",
        created_by=creator_id, created_by_name=creator_name, status="doing")
    cancel_artifact = am.ArtifactVersion(
        id="artifact-plugin-cancel", task_id=cancel_task.id, kind="code",
        checksum="artifact-plugin-cancel", commit_sha="abc123", branch="fix/cancel",
        target="main", state="tested")
    cancel_env = am.Environment(
        id="env-plugin-cancel", key="cancel-test", name="取消验证环境",
        promotion_policy={"autoStart": True, "requiresAcceptance": True})
    cancel_run = am.WorkflowRun(
        id="run-plugin-cancel", task_id=cancel_task.id, plugin_id=chain_plugin.id,
        plugin_version_id=chain_version.id, binding_id=chain_binding.id,
        state="waiting_external", current_nodes=["releaseChain"])
    succeeded_deployment = am.DeploymentRun(
        id="deploy-plugin-cancel-done", task_id=cancel_task.id,
        artifact_version_id=cancel_artifact.id, environment_id=cancel_env.id,
        target_id="target-plugin-cancel-done", state="succeeded", attempt=1,
        idempotency_key="cancel-done", commit_sha="abc123")
    queued_deployment = am.DeploymentRun(
        id="deploy-plugin-cancel-queued", task_id=cancel_task.id,
        artifact_version_id=cancel_artifact.id, environment_id=cancel_env.id,
        target_id="target-plugin-cancel-queued", state="queued", attempt=1,
        idempotency_key="cancel-queued", commit_sha="abc123")
    cancel_node = am.NodeRun(
        id="node-plugin-cancel", run_id=cancel_run.id, node_key="releaseChain",
        node_type="deploy_chain", attempt=1, state="waiting_external",
        idempotency_key="run-plugin-cancel:releaseChain:1", output={
            "artifactVersionId": cancel_artifact.id,
            "environments": [{"id": cancel_env.id, "acceptance": "pending"}],
            "runs": [{"id": succeeded_deployment.id}, {"id": queued_deployment.id}],
        })
    cancel_approval = am.ApprovalRequest(
        id="approval-plugin-cancel", task_id=cancel_task.id,
        artifact_version_id=cancel_artifact.id, action="uat",
        environment_id=cancel_env.id, status="pending")
    session.add_all([cancel_task, cancel_artifact, cancel_env, cancel_run, cancel_node,
                     cancel_approval, succeeded_deployment, queued_deployment])
    await session.commit()
    cancelled = await workflow_control.cancel_run(
        session, cancel_run, actor=creator_name, reason="   ")
    await session.refresh(cancel_node)
    await session.refresh(cancel_approval)
    await session.refresh(succeeded_deployment)
    await session.refresh(queued_deployment)
    await session.refresh(cancel_task)
    chk("结束流程会关闭当前节点、待验收单和尚未开始的发布",
        cancelled["ok"] and cancel_run.state == "cancelled"
        and cancel_node.state == "cancelled" and cancel_approval.status == "cancelled"
        and queued_deployment.state == "cancelled", cancelled)
    chk("结束最后一个活动流程会把任务恢复为待处理，避免永远显示进行中",
        cancel_task.status == "todo" and cancelled.get("taskReopened") is True,
        {"status": cancel_task.status, "cancel": cancelled})
    chk("结束流程不会改写已经成功的发布证据",
        succeeded_deployment.state == "succeeded", succeeded_deployment.state)
    repeated = await workflow_control.cancel_run(
        session, cancel_run, actor=creator_name, reason="重复请求")
    chk("重复结束同一流程保持幂等", repeated.get("alreadyCancelled"), repeated)
    await session.refresh(cancel_run)
    chk("空白结束原因会落成可读审计说明",
        bool(dict(cancel_run.output or {}).get("cancellation", {}).get("reason")))
    fresh_approval = await release_control.ensure_request(
        session, cancel_task, cancel_artifact, "uat", cancel_env.id)
    await session.commit()
    chk("新流程不会复用已经取消的人工关口",
        fresh_approval.id != cancel_approval.id and fresh_approval.status == "pending",
        fresh_approval.id)
