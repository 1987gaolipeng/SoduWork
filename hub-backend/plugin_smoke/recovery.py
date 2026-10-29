"""Resuming failures preserves evidence, attempts and leases."""
from sqlalchemy import select
from app import automation_models as am
from app.services import workflow_engine
from .fixtures import receipt_task_fixture


async def recovery(chk, actor, approved):
    'Historical output, manual gate retries and startup lease recovery.'
    session, creator, box, task = actor.session, actor.creator, actor.box, actor.task
    creator_id, creator_name, box_id = creator.id, creator.display_name, box.id
    plugin, version, binding = approved.plugin, approved.version, approved.binding
    receipt_task = await receipt_task_fixture(session, box)
    recover_version = am.PluginVersion(
        id="pv-plugin-recover", plugin_id=plugin.id, version="recover-test",
        checksum="recover-test", trust_state="approved", enabled=True,
        workflow={"nodes": [
            {"key": "analyze", "type": "ai", "retry": {"maxAttempts": 2}},
            {"key": "baseline", "type": "condition", "dependsOn": ["analyze"],
             "config": {"inputKey": "ready", "equals": True}},
        ]})
    recover_run = am.WorkflowRun(
        id="r-plugin-recover", task_id=receipt_task.id, plugin_id=plugin.id,
        plugin_version_id=recover_version.id, binding_id=binding.id,
        state="failed", error="自动返修次数已用完")
    recover_old = am.NodeRun(
        id="n-plugin-recover-1", run_id=recover_run.id, node_key="analyze",
        node_type="ai", state="failed", attempt=1,
        executor={"ref": "ref-receipt-v2", "provider": "runner"},
        idempotency_key="recover:1", error="产出没有完整回传")
    recover_latest = am.NodeRun(
        id="n-plugin-recover-2", run_id=recover_run.id, node_key="analyze",
        node_type="ai", state="failed", attempt=2,
        executor={"ref": "ref-interrupted", "provider": "runner"},
        idempotency_key="recover:2", error="会话中断")
    session.add_all([recover_version, recover_run, recover_old, recover_latest])
    await session.commit()
    rejected_guard_recovery = False
    try:
        await workflow_engine.recover_ai_output(
            session, recover_run, receipt_task, recover_old,
            {"done": True, "error": "", "attachments": [
                {"id": "requirements.md", "filename": "requirements.md"}],
             "workspaceGuard": {"enabled": True, "ok": False,
                                "reason": "文件节点改了 src/app.py"}},
            {"files": 0, "received": ["requirements.md"], "missing": []},
            actor=creator_id)
    except ValueError as exc:
        rejected_guard_recovery = "仓库边界" in str(exc)
    chk("历史产出恢复不能绕过节点仓库边界", rejected_guard_recovery)
    recovered = await workflow_engine.recover_ai_output(
        session, recover_run, receipt_task, recover_old,
        {"done": True, "error": "", "attachments": [
            {"id": "requirements.md", "filename": "requirements.md"}]},
        {"files": 0, "received": ["requirements.md"], "missing": []},
        actor=creator_id)
    recovered_again = await workflow_engine.recover_ai_output(
        session, recover_run, receipt_task, recover_old,
        {"done": True, "error": "", "attachments": [
            {"id": "requirements.md", "filename": "requirements.md"}]},
        {"files": 0, "received": ["requirements.md"], "missing": []},
        actor=creator_id)
    recovered_nodes = list((await session.execute(select(am.NodeRun).where(
        am.NodeRun.run_id == recover_run.id
    ).order_by(am.NodeRun.attempt, am.NodeRun.created_at))).scalars().all())
    chk("历史产出恢复保留失败尝试并新增成功证据",
        [x.state for x in recovered_nodes if x.node_key == "analyze"]
        == ["failed", "failed", "succeeded"]
        and recovered.attempt == 3, [workflow_engine.node_api(x) for x in recovered_nodes])
    chk("恢复成功后 DAG 从下游节点继续而不重跑 AI",
        recover_run.state == "running"
        and any(x.node_key == "baseline" and x.state == "queued" for x in recovered_nodes),
        workflow_engine.run_summary(recover_run))
    chk("重复恢复保持幂等，不制造第二条恢复证据",
        recovered_again.id == recovered.id
        and len([x for x in recovered_nodes if x.node_key == "analyze"]) == 3)

    quality_retry_version = am.PluginVersion(
        id="pv-plugin-quality-retry", plugin_id=plugin.id, version="quality-retry-test",
        checksum="quality-retry-test", trust_state="approved", enabled=True,
        workflow={"nodes": [
            {"key": "implement", "type": "condition"},
            {"key": "quality", "type": "quality", "dependsOn": ["implement"],
             "config": {"commands": [{"argv": ["git", "diff", "--check"]}]},
             "retry": {"maxAttempts": 3}},
        ]})
    quality_retry_run = am.WorkflowRun(
        id="r-plugin-quality-retry", task_id=receipt_task.id, plugin_id=plugin.id,
        plugin_version_id=quality_retry_version.id, binding_id=binding.id,
        state="failed", error="runner reply timeout")
    quality_upstream = am.NodeRun(
        id="n-plugin-quality-upstream", run_id=quality_retry_run.id,
        node_key="implement", node_type="condition", state="succeeded", attempt=1,
        output={"commit": "abc"}, idempotency_key="quality-upstream:1")
    quality_failed = am.NodeRun(
        id="n-plugin-quality-failed", run_id=quality_retry_run.id,
        node_key="quality", node_type="quality", state="failed", attempt=3,
        error="runner reply timeout", idempotency_key="quality-failed:3")
    session.add_all([quality_retry_version, quality_retry_run,
                     quality_upstream, quality_failed])
    await session.commit()
    quality_retried = await workflow_engine.retry_failed_quality(
        session, quality_retry_run, actor=creator_id)
    retry_outbox = (await session.execute(select(am.WorkflowOutbox).where(
        am.WorkflowOutbox.node_run_id == quality_retried.id))).scalar_one()
    chk("人工重试质量门禁保留失败证据且不重跑已成功开发节点",
        quality_retry_run.state == "running" and quality_retried.attempt == 4
        and quality_retried.state == "queued" and retry_outbox.status == "pending"
        and quality_upstream.state == "succeeded" and quality_failed.state == "failed",
        workflow_engine.run_summary(quality_retry_run))
    review_retry_version = am.PluginVersion(
        id="pv-plugin-review-retry", plugin_id=plugin.id, version="review-retry-test",
        checksum="review-retry-test", trust_state="approved", enabled=True,
        workflow={"nodes": [
            {"key": "quality", "type": "condition"},
            {"key": "review", "type": "human_review", "dependsOn": ["quality"]},
        ]})
    review_retry_run = am.WorkflowRun(
        id="r-plugin-review-retry", task_id=receipt_task.id, plugin_id=plugin.id,
        plugin_version_id=review_retry_version.id, binding_id=binding.id,
        state="failed", error="开发节点还没有提交可审阅的代码版本")
    review_upstream = am.NodeRun(
        id="n-plugin-review-upstream", run_id=review_retry_run.id,
        node_key="quality", node_type="condition", state="succeeded", attempt=1,
        idempotency_key="review-upstream:1")
    review_failed = am.NodeRun(
        id="n-plugin-review-failed", run_id=review_retry_run.id,
        node_key="review", node_type="human_review", state="failed", attempt=3,
        error="开发节点还没有提交可审阅的代码版本",
        idempotency_key="review-failed:3")
    session.add_all([review_retry_version, review_retry_run,
                     review_upstream, review_failed])
    await session.commit()
    review_retried = await workflow_engine.retry_failed_gate(
        session, review_retry_run, actor=creator_id)
    chk("人工关卡在尚未生成审批请求的技术性失败后可断点续跑",
        review_retry_run.state == "running" and review_retried.attempt == 4
        and review_retried.node_type == "human_review"
        and review_upstream.state == "succeeded" and review_failed.state == "failed",
        workflow_engine.run_summary(review_retry_run))
    review_retried.state = "failed"
    review_retried.output = {"requestId": "approval-already-created"}
    review_retry_run.state = "failed"
    await session.commit()
    bypass_rejected = False
    try:
        await workflow_engine.retry_failed_gate(
            session, review_retry_run, actor=creator_id)
    except ValueError as exc:
        bypass_rejected = "不能用重试绕过人的决定" in str(exc)
    chk("已经产生人工处理记录的关卡禁止用重试绕过人的决定", bypass_rejected)
    review_retry_version.workflow = {"nodes": [
        {"key": "quality", "type": "condition", "retry": {"maxAttempts": 1}},
        {"key": "review", "type": "human_review", "dependsOn": ["quality"],
         "config": {"onReject": {"retryFrom": "quality", "maxRounds": 1}},
         "retry": {"maxAttempts": 1}},
    ]}
    review_upstream.state = "rework"
    review_retried.state = "rework"
    review_retry_run.state, review_retry_run.error = "failed", "自动返修次数已用完"
    rejected_request = am.ApprovalRequest(
        id="approval-already-created", task_id=receipt_task.id,
        artifact_version_id="artifact-review-retry", action="review", status="rejected")
    session.add(rejected_request)
    await session.commit()
    resumed = await workflow_engine.retry_failed_gate(
        session, review_retry_run, actor=creator_id)
    await workflow_engine._schedule(session, review_retry_run)
    resumed_nodes = list((await session.execute(select(am.NodeRun).where(
        am.NodeRun.run_id == review_retry_run.id
    ).order_by(am.NodeRun.created_at))).scalars().all())
    chk("旧版已记录人工退回的流程恢复开发节点而不重开审批",
        resumed.id == review_retried.id and review_retry_run.state == "running"
        and any(x.node_key == "quality" and x.attempt == 2 and x.state == "queued"
                for x in resumed_nodes)
        and rejected_request.status == "rejected", workflow_engine.run_summary(review_retry_run))

    ai_rework_version = am.PluginVersion(
        id="pv-plugin-ai-review-rework", plugin_id=plugin.id,
        version="ai-review-rework-test", checksum="ai-review-rework-test",
        trust_state="approved", enabled=True,
        workflow={"nodes": [
            {"key": "implement", "type": "condition", "retry": {"maxAttempts": 1}},
            {"key": "quality", "type": "condition", "dependsOn": ["implement"],
             "retry": {"maxAttempts": 1}},
            {"key": "review", "type": "ai_review", "dependsOn": ["quality"],
             "config": {"onFailure": {"retryFrom": "implement", "maxRounds": 2}},
             "retry": {"maxAttempts": 3}},
        ]})
    ai_rework_run = am.WorkflowRun(
        id="r-plugin-ai-review-rework", task_id=receipt_task.id,
        plugin_id=plugin.id, plugin_version_id=ai_rework_version.id,
        binding_id=binding.id, state="failed", error="自动返修次数已用完",
        context={"reworkRounds": {"review": 2}})
    ai_rework_implement = am.NodeRun(
        id="n-plugin-ai-rework-implement", run_id=ai_rework_run.id,
        node_key="implement", node_type="condition", state="succeeded", attempt=3,
        idempotency_key="ai-rework-implement:3")
    ai_rework_quality = am.NodeRun(
        id="n-plugin-ai-rework-quality", run_id=ai_rework_run.id,
        node_key="quality", node_type="condition", state="succeeded", attempt=3,
        idempotency_key="ai-rework-quality:3")
    ai_rework_review = am.NodeRun(
        id="n-plugin-ai-rework-review", run_id=ai_rework_run.id,
        node_key="review", node_type="ai_review", state="failed", attempt=4,
        output={"review": {"verdict": "changes_requested",
                           "summary": "存在一处并发竞态", "findings": []}},
        error="存在一处并发竞态", idempotency_key="ai-rework-review:4")
    session.add_all([ai_rework_version, ai_rework_run, ai_rework_implement,
                     ai_rework_quality, ai_rework_review])
    await session.commit()
    ai_rework_resumed = await workflow_engine.retry_failed_gate(
        session, ai_rework_run, actor=creator_id, node_key="review",
        resume_rework=True)
    await workflow_engine._schedule(session, ai_rework_run)
    ai_rework_nodes = list((await session.execute(select(am.NodeRun).where(
        am.NodeRun.run_id == ai_rework_run.id
    ).order_by(am.NodeRun.created_at))).scalars().all())
    chk("AI 审查返修轮次耗尽后可显式回到实施且不会把审查改成通过",
        ai_rework_resumed.id == ai_rework_review.id
        and ai_rework_review.state == "rework"
        and ai_rework_review.output["review"]["verdict"] == "changes_requested"
        and ai_rework_run.state == "running"
        and dict(ai_rework_run.context or {}).get("reworkRounds", {}).get("review") == 3
        and any(x.node_key == "implement" and x.attempt == 4 and x.state == "queued"
                for x in ai_rework_nodes)
        and not any(x.node_key == "review" and x.attempt > 4
                    for x in ai_rework_nodes), workflow_engine.run_summary(ai_rework_run))

    extended_run = am.WorkflowRun(
        id="r-plugin-ai-review-manual-extension", task_id=receipt_task.id,
        plugin_id=plugin.id, plugin_version_id=ai_rework_version.id,
        binding_id=binding.id, state="failed", error="manual extension required",
        context={"reworkRounds": {"review": 5}})
    extended_implement = am.NodeRun(
        id="n-plugin-ai-extension-implement", run_id=extended_run.id,
        node_key="implement", node_type="condition", state="succeeded", attempt=6,
        idempotency_key="ai-extension-implement:6")
    extended_quality = am.NodeRun(
        id="n-plugin-ai-extension-quality", run_id=extended_run.id,
        node_key="quality", node_type="condition", state="succeeded", attempt=6,
        idempotency_key="ai-extension-quality:6")
    extended_review = am.NodeRun(
        id="n-plugin-ai-extension-review", run_id=extended_run.id,
        node_key="review", node_type="ai_review", state="failed", attempt=6,
        output={"review": {"verdict": "changes_requested",
                           "summary": "one new verified blocker remains"}},
        error="one new verified blocker remains",
        idempotency_key="ai-extension-review:6")
    session.add_all([extended_run, extended_implement,
                     extended_quality, extended_review])
    await session.commit()
    await workflow_engine.retry_failed_gate(
        session, extended_run, actor=creator_id, node_key="review",
        resume_rework=True)
    await workflow_engine._schedule(session, extended_run)
    extended_nodes = list((await session.execute(select(am.NodeRun).where(
        am.NodeRun.run_id == extended_run.id
    ))).scalars().all())
    chk("管理员显式确认只增加一轮返修且留下独立授权计数",
        extended_run.state == "running"
        and dict(extended_run.context or {}).get(
            "reworkRounds", {}).get("review") == 6
        and dict(extended_run.context or {}).get(
            "manualReworkGrants", {}).get("review") == 1
        and any(x.node_key == "implement" and x.attempt == 7
                and x.state == "queued" for x in extended_nodes),
        workflow_engine.run_summary(extended_run))

    capped_run = am.WorkflowRun(
        id="r-plugin-ai-review-cap", task_id=receipt_task.id,
        plugin_id=plugin.id, plugin_version_id=ai_rework_version.id,
        binding_id=binding.id, state="failed", error="自动返修次数已用完",
        context={"reworkRounds": {"review": 8}})
    capped_implement = am.NodeRun(
        id="n-plugin-ai-cap-implement", run_id=capped_run.id,
        node_key="implement", node_type="condition", state="succeeded", attempt=9,
        idempotency_key="ai-cap-implement:9")
    capped_quality = am.NodeRun(
        id="n-plugin-ai-cap-quality", run_id=capped_run.id,
        node_key="quality", node_type="condition", state="succeeded", attempt=9,
        idempotency_key="ai-cap-quality:9")
    capped_review = am.NodeRun(
        id="n-plugin-ai-cap-review", run_id=capped_run.id,
        node_key="review", node_type="ai_review", state="failed", attempt=9,
        output={"review": {"verdict": "changes_requested", "summary": "仍需修改"}},
        error="仍需修改", idempotency_key="ai-cap-review:9")
    session.add_all([capped_run, capped_implement, capped_quality, capped_review])
    await session.commit()
    cap_rejected = False
    try:
        await workflow_engine.retry_failed_gate(
            session, capped_run, actor=creator_id, node_key="review",
            resume_rework=True)
    except ValueError as exc:
        cap_rejected = "安全返修上限" in str(exc)
    chk("显式继续返修仍受八轮人工硬上限保护", cap_rejected)
    recover_baseline = next(x for x in recovered_nodes if x.node_key == "baseline")
    recover_outbox = (await session.execute(select(am.WorkflowOutbox).where(
        am.WorkflowOutbox.node_run_id == recover_baseline.id
    ))).scalar_one()
    recover_baseline.state, recover_baseline.started_at = "dispatching", workflow_engine._now()
    recover_outbox.status, recover_outbox.lease_owner = "processing", "dead-hub"
    await session.commit()
    reclaimed = await workflow_engine.reclaim_startup_leases(session)
    chk("服务重启会立即释放旧进程租约并恢复待执行节点",
        reclaimed == 1 and recover_outbox.status == "pending"
        and recover_baseline.state == "queued" and recover_baseline.started_at is None,
        (reclaimed, recover_outbox.status, recover_baseline.state))
    recover_baseline.state, recover_baseline.started_at = "dispatching", workflow_engine._now()
    recover_outbox.status, recover_outbox.lease_owner = "done", "old-hub"
    await session.commit()
    orphaned = await workflow_engine.reclaim_startup_leases(session)
    chk("服务重启也会修复旧版遗留的 dispatching/done 孤儿节点",
        orphaned == 1 and recover_outbox.status == "pending"
        and recover_baseline.state == "queued" and recover_baseline.started_at is None,
        (orphaned, recover_outbox.status, recover_baseline.state))
