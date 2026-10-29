"""Execution receipts, delivery evidence and structured decisions."""
import json
from sqlalchemy import select
from app import automation_models as am
from app import models
from app.realtime import hub
from app.services import ai_exec
from app.services import ai_remote
from app.services import code_delivery
from app.services import release_control
from app.services import storage
from app.services import workflow_contracts
from app.services import workflow_engine
from .fixtures import repository_fixture, receipt_task_fixture


async def receipts(chk, actor, approved):
    'Runner output receipts, bounded settlement and policy stop behavior.'
    session, creator, box, task = actor.session, actor.creator, actor.box, actor.task
    creator_id, creator_name, box_id = creator.id, creator.display_name, box.id
    plugin, version, binding = approved.plugin, approved.version, approved.binding
    pushed = []
    publish = hub.publish

    async def capture(device, event, *, user_id=None):
        assert user_id == task.owner_user_id, (device, user_id)
        pushed.append((device, event))

    hub.publish = capture
    try:
        run = await workflow_engine.start(
            session, task, binding, {"ready": True}, actor_id=creator_id)
    finally:
        hub.publish = publish
    chk("启动插件后立即向任务持有人同步进行中状态",
        len(pushed) == 1 and pushed[0][0] == box.id
        and pushed[0][1].get("type") == "task.updated"
        and pushed[0][1].get("task", {}).get("status") == "doing", pushed)
    # Persist enough node provenance to restore execution-to-Runner routing after restart without broadcast discovery.
    ai_remote._WHERE.pop("ref-plugin-restart", None)
    restored = workflow_engine._restore_ai_route({
        "provider": "runner", "runnerId": "runner-persisted",
        "ref": "ref-plugin-restart",
    })
    chk("服务端重启后可从插件节点恢复执行机路由",
        restored == ("ref-plugin-restart", "runner-persisted")
        and ai_remote._WHERE.get("ref-plugin-restart") == "runner-persisted", restored)
    ai_remote._WHERE.pop("ref-plugin-restart", None)

    # Repeated polling is idempotent within one execution, but rework creates new same-named attachments.
    # Subsequent approval must read only the latest version.
    receipt_task = models.Task(
        id="t-plugin-receipt", owner_client_id=box.id, title="验证产出回流版本")
    session.add(receipt_task)
    await session.commit()
    payloads = {
        "ref-receipt-v1": b"# v1\n## acceptance criteria\n- old criterion\n",
        "ref-receipt-v2": b"# v2\n## acceptance criteria\n- new criterion\n",
    }

    class FakeArtifactProvider:
        PREFIX = "runner:"

        @staticmethod
        def fetch_attachment_for_sync(_cfg, ref, _attachment_id):
            return payloads.get(ref)

    async def fake_by_ref(_ref):
        return FakeArtifactProvider

    original_by_ref = ai_exec._by_ref_async
    original_runner_info = ai_exec.runner_info_sync
    original_delivery_check = code_delivery.check
    delivery_checks = 0

    async def count_delivery_check(*_args, **_kwargs):
        nonlocal delivery_checks
        delivery_checks += 1
        return {"applies": True}

    ai_exec._by_ref_async = fake_by_ref
    ai_exec.runner_info_sync = lambda _ctx, _ref: {}
    code_delivery.check = count_delivery_check
    try:
        def receipt_status(ref, marker):
            return {"identifier": marker, "attachments": [
                {"id": "requirements.md", "filename": "requirements.md"}]}

        first = await ai_exec.pull_artifacts(
            session, receipt_task.id, {"name": "local", "cfg": {}},
            receipt_status("ref-receipt-v1", "RECEIPT-V1"), "ref-receipt-v1", settle=False)
        repeated = await ai_exec.pull_artifacts(
            session, receipt_task.id, {"name": "local", "cfg": {}},
            receipt_status("ref-receipt-v1", "RECEIPT-V1"), "ref-receipt-v1", settle=False)
        second = await ai_exec.pull_artifacts(
            session, receipt_task.id, {"name": "local", "cfg": {}},
            receipt_status("ref-receipt-v2", "RECEIPT-V2"), "ref-receipt-v2", settle=False)
    finally:
        code_delivery.check = original_delivery_check
        ai_exec._by_ref_async = original_by_ref
        ai_exec.runner_info_sync = original_runner_info
    receipt_rows = list((await session.execute(select(models.Attachment).where(
        models.Attachment.task_id == receipt_task.id
    ).order_by(models.Attachment.created_at))).scalars().all())
    chk("同一执行单重复轮询不会重复挂附件",
        first["files"] == 1 and repeated["files"] == 0 and not repeated["missing"],
        (first, repeated))
    chk("返修执行单的同名产出会保存为新版本",
        second["files"] == 1 and len(receipt_rows) == 2, (second, len(receipt_rows)))
    chk("★★插件节点回收产出不触发普通派活的候选与审批链",
        delivery_checks == 0, delivery_checks)
    requirement = await workflow_engine._requirement_manifest(
        session, receipt_task, {"files": ["requirements.md"]})
    latest_output = await release_control.output_manifest(session, receipt_task)
    chk("需求审批和产出快照只读取同名文件的最新版",
        requirement["acceptanceCriteria"] == ["new criterion"]
        and len(latest_output["files"]) == 1
        and storage.get(receipt_rows[-1].storage_key, receipt_rows[-1].backend).startswith(b"# v2"),
        (requirement, latest_output))

    # Runner completion does not prove artifacts reached Hub; fail the producing node when files are missing.
    # Do not defer that error to an unrelated requirements-approval gate.
    broken_run = am.WorkflowRun(
        id="r-plugin-missing-artifact", task_id=receipt_task.id,
        plugin_id=plugin.id, plugin_version_id=version.id, binding_id=binding.id,
        state="running")
    broken_node = am.NodeRun(
        id="n-plugin-missing-artifact", run_id=broken_run.id, node_key="check",
        node_type="ai", state="running", attempt=1,
        executor={"ref": "ref-missing-artifact"}, idempotency_key="missing-artifact:1")
    session.add_all([broken_run, broken_node])
    await session.commit()
    original_load = ai_exec.load
    original_status = ai_exec.status_sync
    original_pull = ai_exec.pull_artifacts

    async def fake_load(_session, force=False):
        return {"name": "local", "cfg": {}}

    pull_ready = False

    async def fake_pull(*_args, **_kwargs):
        if pull_ready:
            return {
                "files": 1, "received": ["requirements.md"],
                "valid": ["requirements.md"],
                "deliverables": ["requirements.md"],
                "missing": [], "url": "",
            }
        return {"files": 0, "received": [], "missing": ["requirements.md"], "url": ""}

    ai_exec.load = fake_load
    ai_exec.status_sync = lambda _ctx, _ref: {
        "ok": True, "done": True, "error": "", "artifactsDropped": 0,
        "attachments": [{"id": "requirements.md", "filename": "requirements.md"}],
    }
    ai_exec.pull_artifacts = fake_pull
    try:
        await workflow_engine._poll_node(session, broken_run, broken_node)
        waiting_state = broken_node.state
        waiting_mark = dict(dict(broken_run.context or {}).get(
            "aiOutputSettle") or {}).get(broken_node.id)
        pull_ready = True
        await workflow_engine._poll_node(session, broken_run, broken_node)
    finally:
        ai_exec.load = original_load
        ai_exec.status_sync = original_status
        ai_exec.pull_artifacts = original_pull
    chk("终态文件尚在回传时节点进入有界结算而不是抢先判失败",
        waiting_state == "running" and waiting_mark
        and waiting_mark.get("missing") == ["requirements.md"],
        (waiting_state, waiting_mark))
    chk("结算窗口内文件回传后节点自动恢复并通过",
        broken_node.state == "succeeded"
        and not dict(broken_run.context or {}).get("aiOutputSettle"),
        workflow_engine.node_api(broken_node))

    expired_run = am.WorkflowRun(
        id="r-plugin-expired-artifact", task_id=receipt_task.id,
        plugin_id=plugin.id, plugin_version_id=version.id, binding_id=binding.id,
        state="running")
    expired_node = am.NodeRun(
        id="n-plugin-expired-artifact", run_id=expired_run.id, node_key="check",
        node_type="ai", state="running", attempt=1,
        executor={"ref": "ref-expired-artifact"},
        idempotency_key="expired-artifact:1")
    expired_run.context = {"aiOutputSettle": {expired_node.id: {
        "since": (workflow_engine._now() - workflow_engine.timedelta(
            seconds=workflow_engine._AI_OUTPUT_SETTLE_GRACE_S + 1)).timestamp(),
        "polls": workflow_engine._AI_OUTPUT_SETTLE_MIN_POLLS,
        "missing": ["requirements.md"],
    }}}
    session.add_all([expired_run, expired_node])
    await session.commit()
    pull_ready = False
    ai_exec.load = fake_load
    ai_exec.status_sync = lambda _ctx, _ref: {
        "ok": True, "done": True, "error": "", "artifactsDropped": 0,
        "attachments": [{"id": "requirements.md", "filename": "requirements.md"}],
    }
    ai_exec.pull_artifacts = fake_pull
    try:
        await workflow_engine._poll_node(session, expired_run, expired_node)
    finally:
        ai_exec.load = original_load
        ai_exec.status_sync = original_status
        ai_exec.pull_artifacts = original_pull
    chk("超过结算上限仍缺文件会严格失败且不永久卡住",
        expired_node.state == "failed"
        and "产出没有完整回传" in expired_node.error
        and not dict(expired_run.context or {}).get("aiOutputSettle"),
        workflow_engine.node_api(expired_node))

    # Validate file-node repository boundaries from actual Runner Git state.
    # Stop violations immediately rather than allowing unauthorized changes to reach later nodes.
    guard_run = am.WorkflowRun(
        id="r-plugin-workspace-guard", task_id=receipt_task.id,
        plugin_id=plugin.id, plugin_version_id=version.id, binding_id=binding.id,
        state="running")
    guard_node = am.NodeRun(
        id="n-plugin-workspace-guard", run_id=guard_run.id, node_key="check",
        node_type="ai", state="running", attempt=1,
        executor={"ref": "ref-workspace-guard"}, idempotency_key="workspace-guard:1")
    session.add_all([guard_run, guard_node])
    await session.commit()
    stopped = []
    original_load = ai_exec.load
    original_status = ai_exec.status_sync
    original_stop = ai_exec.stop_sync
    ai_exec.load = fake_load
    ai_exec.status_sync = lambda _ctx, _ref: {
        "ok": True, "done": False, "running": True, "error": "",
        "workspaceGuard": {
            "enabled": True, "ok": False,
            "reason": "文件型节点越权修改仓库：src/app.py",
            "violatingPaths": ["src/app.py"],
        },
    }
    ai_exec.stop_sync = lambda _ctx, ref: stopped.append(ref) or {"ok": True}
    try:
        await workflow_engine._poll_node(session, guard_run, guard_node)
    finally:
        ai_exec.load = original_load
        ai_exec.status_sync = original_status
        ai_exec.stop_sync = original_stop
    chk("★★文件节点运行中越权会被立即停止并留下结构化失败证据",
        guard_node.state == "failed" and stopped == ["ref-workspace-guard"]
        and guard_node.output.get("failureKind") == "contract"
        and guard_node.output.get("workspaceGuard", {}).get("violatingPaths")
        == ["src/app.py"], workflow_engine.node_api(guard_node))

    # Policy failure takes precedence even if cancellation temporarily fails.
    # Retain cancellation diagnostics so operators can identify potentially surviving processes.
    stop_fail_run = am.WorkflowRun(
        id="r-plugin-stop-failure", task_id=receipt_task.id,
        plugin_id=plugin.id, plugin_version_id=version.id, binding_id=binding.id,
        state="running")
    stop_fail_node = am.NodeRun(
        id="n-plugin-stop-failure", run_id=stop_fail_run.id, node_key="check",
        node_type="ai", state="running", attempt=1,
        executor={"ref": "ref-stop-failure"}, idempotency_key="stop-failure:1")
    session.add_all([stop_fail_run, stop_fail_node])
    await session.commit()
    ai_exec.load = fake_load
    ai_exec.status_sync = lambda _ctx, _ref: {
        "ok": True, "done": False, "running": True, "error": "",
        "workspaceGuard": {
            "enabled": True, "ok": False,
            "reason": "文件型节点越权修改仓库：src/app.py",
            "violatingPaths": ["src/app.py"],
        },
    }
    ai_exec.stop_sync = lambda _ctx, _ref: (_ for _ in ()).throw(
        RuntimeError("runner stop channel unavailable"))
    try:
        await workflow_engine._poll_node(session, stop_fail_run, stop_fail_node)
    finally:
        ai_exec.load = original_load
        ai_exec.status_sync = original_status
        ai_exec.stop_sync = original_stop
    chk("策略拦截后停止失败仍会阻断节点并留下可操作审计证据",
        stop_fail_node.state == "failed"
        and stop_fail_node.output.get("stopError") == "runner stop channel unavailable",
        workflow_engine.node_api(stop_fail_node))

    timeout_run = am.WorkflowRun(
        id="r-plugin-ai-timeout", task_id=receipt_task.id,
        plugin_id=plugin.id, plugin_version_id=version.id, binding_id=binding.id,
        state="running")
    timeout_node = am.NodeRun(
        id="n-plugin-ai-timeout", run_id=timeout_run.id, node_key="check",
        node_type="ai", state="running", attempt=1,
        executor={"ref": "ref-ai-timeout"}, idempotency_key="ai-timeout:1",
        started_at=workflow_engine._now() - workflow_engine.timedelta(seconds=121))
    session.add_all([timeout_run, timeout_node])
    await session.commit()
    original_node_config = workflow_engine._node_config
    timeout_stopped = []

    async def timeout_node_config(_session, _run, _key):
        return {"timeoutSeconds": 60}

    workflow_engine._node_config = timeout_node_config
    ai_exec.load = fake_load
    ai_exec.status_sync = lambda _ctx, _ref: {
        "ok": True, "done": False, "running": True, "error": "",
    }
    ai_exec.stop_sync = lambda _ctx, ref: timeout_stopped.append(ref) or {"ok": True}
    try:
        await workflow_engine._poll_node(session, timeout_run, timeout_node)
    finally:
        workflow_engine._node_config = original_node_config
        ai_exec.load = original_load
        ai_exec.status_sync = original_status
        ai_exec.stop_sync = original_stop
    chk("无人值守 AI 超时会停止当前执行并按基础设施故障留下可重试证据",
        timeout_node.state == "failed"
        and timeout_stopped == ["ref-ai-timeout"]
        and timeout_node.output.get("failureKind") == "infrastructure"
        and timeout_node.output.get("timeout", {}).get("limitSeconds") == 60,
        workflow_engine.node_api(timeout_node))

    workflow_engine._record_ai_dispatch(session, receipt_task, broken_run, broken_node, {
        "issueId": "ref-plugin-console", "identifier": "PLUGIN-CONSOLE",
        "provider": "runner", "runnerId": "runner-console", "host": "smoke-host",
        "assigneeId": "runner:runner-console:pi", "assigneeName": "smoke-host · Pi",
        "assigneeCli": "pi",
    }, "local:pi")
    await session.commit()
    dispatch_event = await ai_exec.last_dispatch_event(session, receipt_task.id)
    chk("插件 AI 节点写入统一派活时间线供控制台认回会话",
        dispatch_event is not None
        and (dispatch_event.detail or {}).get("ref") == "ref-plugin-console"
        and (dispatch_event.detail or {}).get("plugin", {}).get("node") == "check",
        dispatch_event.detail if dispatch_event else None)


async def git(chk, actor, approved):
    'Fixed Git delivery evidence and recovery of interrupted output.'
    session, creator, box, task = actor.session, actor.creator, actor.box, actor.task
    creator_id, creator_name, box_id = creator.id, creator.display_name, box.id
    plugin, version, binding = approved.plugin, approved.version, approved.binding
    single_project, single_repo, _ = await repository_fixture(session, box)
    git_contract_task = models.Task(
        id="t-plugin-git-contract", owner_client_id=box.id,
        title="验证代码固定版本契约", project_id=single_project.id,
        repo_id=single_repo.id)
    session.add(git_contract_task)
    await session.commit()
    original_delivery_check = code_delivery.check
    original_latest_artifact = release_control.latest_artifact
    rejected_empty_branch = False

    async def fake_no_commit(*_args, **_kwargs):
        return {"stage": "none", "error": "任务分支相对 develop 没有新提交"}

    async def fake_fixed_commit(*_args, **_kwargs):
        return {"stage": "committed", "branch": "fix/task", "target": "develop"}

    async def fake_gerrit_candidate(*_args, **_kwargs):
        return {"stage": "candidate", "branch": "refs/changes/98/170298/1",
                "target": "develop"}

    async def fake_latest_artifact(*_args, **_kwargs):
        return type("FixedArtifact", (), {
            "id": "artifact-fixed", "branch": "fix/task", "target": "develop",
            "commit_sha": "a" * 40,
        })()

    try:
        code_delivery.check = fake_no_commit
        release_control.latest_artifact = fake_latest_artifact
        try:
            await workflow_engine._verified_git_delivery(
                session, git_contract_task, {"provider": "runner"}, "ref-baseline",
                {"gitBranch": "fix/task", "gitHead": "b" * 40},
                {"declared": [{"kind": "git"}]})
        except workflow_contracts.WorkflowContractError:
            rejected_empty_branch = True
        code_delivery.check = fake_fixed_commit
        fixed_delivery = await workflow_engine._verified_git_delivery(
            session, git_contract_task, {"provider": "runner"}, "ref-fixed",
            {"gitBranch": "fix/task", "gitHead": "a" * 40},
            {"declared": [{"kind": "git"}]})
        code_delivery.check = fake_gerrit_candidate
        gerrit_delivery = await workflow_engine._verified_git_delivery(
            session, git_contract_task, {"provider": "runner"}, "ref-gerrit",
            {"gitBranch": "fix/task", "gitHead": "a" * 40},
            {"declared": [{"kind": "git"}]})
    finally:
        code_delivery.check = original_delivery_check
        release_control.latest_artifact = original_latest_artifact
    chk("Git 节点拒绝只有分支名和基线 SHA 的假成功",
        rejected_empty_branch)
    chk("Git 节点只接受仓库核对后的固定版本",
        fixed_delivery.get("artifactVersionId") == "artifact-fixed"
        and fixed_delivery.get("commit") == "a" * 40, fixed_delivery)
    chk("Gerrit 已核对的 candidate patchset 可进入权威质量门",
        gerrit_delivery.get("stage") == "candidate"
        and gerrit_delivery.get("artifactVersionId") == "artifact-fixed",
        gerrit_delivery)

    git_recover_version = am.PluginVersion(
        id="pv-plugin-git-recover", plugin_id=plugin.id, version="git-recover-test",
        checksum="git-recover-test", trust_state="approved", enabled=True,
        workflow={"nodes": [{
            "key": "implement", "type": "ai",
            "outputs": [{"key": "code", "kind": "git", "required": True}],
            "retry": {"maxAttempts": 3},
        }]})
    git_recover_run = am.WorkflowRun(
        id="r-plugin-git-recover", task_id=git_contract_task.id, plugin_id=plugin.id,
        plugin_version_id=git_recover_version.id, binding_id=binding.id,
        state="failed", error="执行结果回传中断")
    git_recover_source = am.NodeRun(
        id="n-plugin-git-recover-1", run_id=git_recover_run.id,
        node_key="implement", node_type="ai", state="failed", attempt=1,
        executor={"ref": "ref-git-recover", "provider": "runner"},
        idempotency_key="git-recover:1", error="回传中断")
    git_recover_latest = am.NodeRun(
        id="n-plugin-git-recover-2", run_id=git_recover_run.id,
        node_key="implement", node_type="ai", state="failed", attempt=2,
        executor={"ref": "ref-git-recover-retry", "provider": "runner"},
        idempotency_key="git-recover:2", error="平台固定提交核验失败",
        output=workflow_contracts.failure_output("contract"))
    session.add_all([git_recover_version, git_recover_run,
                     git_recover_source, git_recover_latest])
    await session.commit()
    rejected_git_recovery = False
    try:
        code_delivery.check = fake_no_commit
        release_control.latest_artifact = fake_latest_artifact
        try:
            await workflow_engine.recover_ai_output(
                session, git_recover_run, git_contract_task, git_recover_source,
                {"done": True, "error": "", "gitBranch": "fix/task",
                 "gitHead": "b" * 40, "attachments": []},
                {"files": 0, "received": [], "missing": []}, actor=creator_id)
        except ValueError:
            rejected_git_recovery = True
        code_delivery.check = fake_fixed_commit
        recovered_git = await workflow_engine.recover_ai_output(
            session, git_recover_run, git_contract_task, git_recover_source,
            {"done": True, "error": "", "gitBranch": "fix/task",
             "gitHead": "a" * 40, "attachments": []},
            {"files": 0, "received": [], "missing": []}, actor=creator_id)
    finally:
        code_delivery.check = original_delivery_check
        release_control.latest_artifact = original_latest_artifact
    chk("历史会话恢复不能绕过仓库固定提交校验", rejected_git_recovery)
    chk("终止型平台核验失败无需空烧到最大重试次数即可恢复真实提交",
        recovered_git.attempt == 3)
    chk("历史 Git 产出恢复沿用同一固定版本并写入恢复证据",
        recovered_git.output.get("gitDelivery", {}).get("artifactVersionId")
        == "artifact-fixed"
        and recovered_git.output.get("gitHead") == "a" * 40,
        workflow_engine.node_api(recovered_git))


async def decisions(chk, actor, approved):
    'Structured blocked decisions cannot launch downstream work.'
    session, creator, box, task = actor.session, actor.creator, actor.box, actor.task
    creator_id, creator_name, box_id = creator.id, creator.display_name, box.id
    plugin, version, binding = approved.plugin, approved.version, approved.binding
    receipt_task = await receipt_task_fixture(session, box)

    async def fake_load(_session, force=False):
        return {"name": "local", "cfg": {}}

    decision_version = am.PluginVersion(
        id="pv-plugin-decision", plugin_id=plugin.id, version="decision-test",
        checksum="decision-test", trust_state="approved", enabled=True,
        workflow={"nodes": [
            {"key": "scope", "type": "ai", "outputs": [{
                "key": "preflight", "kind": "decision", "label": "执行前置结论",
                "path": "workflow-decision.json", "required": True,
            }], "retry": {"maxAttempts": 3}},
            {"key": "implement", "type": "ai", "dependsOn": ["scope"]},
        ]})
    decision_run = am.WorkflowRun(
        id="r-plugin-decision", task_id=receipt_task.id, plugin_id=plugin.id,
        plugin_version_id=decision_version.id, binding_id=binding.id, state="running")
    decision_node_run = am.NodeRun(
        id="n-plugin-decision", run_id=decision_run.id, node_key="scope",
        node_type="ai", state="running", attempt=1,
        executor={"ref": "ref-node-decision"}, idempotency_key="node-decision:1")
    decision_bytes = json.dumps({
        "schemaVersion": 1, "outcome": "blocked",
        "summary": "执行机缺少本工程所需的 JDK 与 Maven",
        "reasonCode": "missing_toolchain",
        "evidence": ["java 与 mvn 均不可用", "仓库没有 Maven Wrapper"],
        "nextAction": "为可用 Runner 安装并探活项目要求的 JDK 与 Maven",
    }, ensure_ascii=False).encode("utf-8")
    decision_backend = storage.put(
        "smoke/node-decision.json", decision_bytes, "application/json")
    session.add_all([decision_version, decision_run, decision_node_run,
                     models.Attachment(
                         id="att-node-decision", task_id=receipt_task.id,
                         filename="workflow-decision.json", content_type="application/json",
                         size=len(decision_bytes), storage_key="smoke/node-decision.json",
                         backend=decision_backend, uploaded_by="agent:runner", role="process",
                         source_ref="ref-node-decision", workflow_run_id=decision_run.id,
                         node_run_id=decision_node_run.id)])
    await session.commit()
    original_load = ai_exec.load
    original_status = ai_exec.status_sync
    original_pull = ai_exec.pull_artifacts
    ai_exec.load = fake_load
    ai_exec.status_sync = lambda _ctx, _ref: {
        "ok": True, "done": True, "error": "", "artifactsDropped": 0,
        "attachments": [{"id": "workflow-decision.json",
                         "filename": "workflow-decision.json"}],
    }

    async def fake_decision_pull(*_args, **_kwargs):
        return {"files": 0, "received": ["workflow-decision.json"],
                "valid": ["workflow-decision.json"], "missing": []}

    ai_exec.pull_artifacts = fake_decision_pull
    try:
        await workflow_engine._poll_node(session, decision_run, decision_node_run)
    finally:
        ai_exec.load = original_load
        ai_exec.status_sync = original_status
        ai_exec.pull_artifacts = original_pull
    await workflow_engine._schedule(session, decision_run)
    downstream = list((await session.execute(select(am.NodeRun).where(
        am.NodeRun.run_id == decision_run.id,
        am.NodeRun.node_key == "implement"))).scalars().all())
    chk("AI 明确报告前置阻断后，本关和整条流程停止且绝不启动下游",
        decision_node_run.state == "failed" and decision_run.state == "failed"
        and decision_node_run.output.get("failureKind") == "configuration"
        and decision_node_run.output.get("decision", {}).get("outcome") == "blocked"
        and not downstream,
        {"node": workflow_engine.node_api(decision_node_run),
         "run": decision_run.state, "downstream": downstream})
    retried_decision = await workflow_engine.retry_failed_gate(
        session, decision_run, actor="smoke")
    chk("补齐条件后只重试被阻断的当前关，不重放或越过流程",
        retried_decision.node_key == "scope" and retried_decision.attempt == 2
        and retried_decision.state == "queued" and decision_run.state == "running",
        workflow_engine.node_api(retried_decision))
    retry_outboxes = list((await session.execute(select(am.WorkflowOutbox).where(
        am.WorkflowOutbox.run_id == decision_run.id))).scalars().all())
    for row in retry_outboxes:
        row.status = "done"
    retried_decision.state = "cancelled"
    decision_run.state = "cancelled"
    await session.commit()
