# -*- coding: utf-8 -*-
"""A review rework must advance the immutable Git commit before review repeats."""
import asyncio
import os
import sys
import tempfile

_temporary = tempfile.TemporaryDirectory(prefix="smoke-rework-delivery-progress-")
DB = os.path.join(_temporary.name, "test.db")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import ai_prompts, code_delivery, workflow_engine, workflow_runs  # noqa: E402


async def check_progress() -> int:
    await init_db()
    passed = failed = 0

    def check(name, condition, detail=None):
        nonlocal passed, failed
        if condition:
            passed += 1
            print("  PASS  " + name)
        else:
            failed += 1
            print("  FAIL  " + name + ((" :: " + repr(detail))
                                        if detail is not None else ""))

    old_head = "a" * 40
    new_head = "b" * 40

    merged_state = {"stage": "merged", "mergeCommit": old_head}
    check("merged delivery keeps the zero-network fast path without a new hint",
          code_delivery._merged_state_matches_head(merged_state, ""))
    check("merged delivery keeps the fast path for the same immutable head",
          code_delivery._merged_state_matches_head(merged_state, old_head.upper()))
    check("a newer execution head bypasses stale merged task state",
          not code_delivery._merged_state_matches_head(merged_state, new_head))

    class Obj:
        pass

    repo = Obj()
    repo.scm = "git"
    repo.default_branch = "main"
    repo.merge_branch = "main"
    artifact = Obj()
    artifact.branch = "main"
    artifact.target = "main"
    branch, target = workflow_engine._continuation_remote_branch(
        artifact, repo, "task-progress", {})
    check("rework never inherits the protected target branch",
          branch == ai_prompts.work_branch("task-progress", {}), branch)
    check("rework preserves the configured merge target", target == "main", target)
    artifact.branch = "soduwork/task-progress"
    branch, _target = workflow_engine._continuation_remote_branch(
        artifact, repo, "task-progress", {})
    check("rework preserves an existing writable task branch",
          branch == "soduwork/task-progress", branch)

    async with SessionLocal() as session:
        version = am.PluginVersion(
            id="pv-progress", plugin_id="p-progress", version="1.0.0",
            checksum="c" * 64, trust_state="approved", enabled=True,
            workflow={"nodes": []})
        run = am.WorkflowRun(
            id="run-progress", task_id="task-progress", plugin_id="p-progress",
            plugin_version_id=version.id, binding_id="binding-progress",
            state="running", current_nodes=["implement"])
        first = am.NodeRun(
            id="node-progress-1", run_id=run.id, node_key="implement",
            node_type="ai", attempt=1, state="rework",
            idempotency_key="run-progress:implement:1",
            output={"gitHead": old_head})
        second = am.NodeRun(
            id="node-progress-2", run_id=run.id, node_key="implement",
            node_type="ai", attempt=2, state="running",
            idempotency_key="run-progress:implement:2",
            input={"reworkFeedback": "fix the review findings"})
        session.add_all([version, run, first, second])
        await session.commit()

        same = await workflow_engine._unchanged_rework_delivery(
            session, second, {"commit": old_head.upper()})
        check("same commit is rejected", same.get("previousAttempt") == 1)
        check("guard records immutable identities",
              same.get("previousGitHead") == old_head
              and same.get("currentGitHead") == old_head)

        changed = await workflow_engine._unchanged_rework_delivery(
            session, second, {"commit": new_head})
        check("new commit is accepted", changed == {})

        merge_conflict_output = {
            "conflict": True,
            "branch": "soduwork/task-progress",
            "target": "main",
            "output": "CONFLICT (content): Merge conflict in src/app.js",
        }
        merge_attempt = am.NodeRun(
            id="node-progress-merge-1", run_id=run.id, node_key="merge",
            node_type="merge", attempt=1, state="rework",
            idempotency_key="run-progress:merge:1", output=merge_conflict_output)
        conflict_retry = am.NodeRun(
            id="node-progress-3", run_id=run.id, node_key="implement",
            node_type="ai", attempt=3, state="running",
            idempotency_key="run-progress:implement:3",
            input={"reworkFeedback": workflow_engine._merge_conflict_rework_feedback(
                merge_conflict_output)})
        session.add_all([merge_attempt, conflict_retry])
        await session.commit()

        unresolved = await workflow_engine._unchanged_rework_delivery(
            session, conflict_retry, {
                "commit": old_head, "branch": "soduwork/task-progress", "target": "main",
                "containsTarget": False})
        check("same head stays blocked until the target is in the task branch",
              unresolved.get("previousGitHead") == old_head, unresolved)

        wrong_route = await workflow_engine._unchanged_rework_delivery(
            session, conflict_retry, {
                "commit": old_head, "branch": "soduwork/other", "target": "main",
                "containsTarget": True})
        check("conflict exception requires the exact recorded branch route",
              wrong_route.get("previousGitHead") == old_head, wrong_route)

        resolved_delivery = {
            "commit": old_head, "branch": "soduwork/task-progress", "target": "main",
            "containsTarget": True}
        resolved = await workflow_engine._unchanged_rework_delivery(
            session, conflict_retry, resolved_delivery)
        proof = dict(resolved_delivery.get("resolvedMergeConflict") or {})
        check("resolved merge conflict can retry without manufacturing a commit",
              resolved == {} and proof.get("resolved") is True, (resolved, proof))
        check("resolved conflict receipt keeps immutable route evidence",
              proof.get("branch") == "soduwork/task-progress"
              and proof.get("target") == "main"
              and proof.get("commit") == old_head,
              proof)

        second.input = {}
        no_feedback = await workflow_engine._unchanged_rework_delivery(
            session, second, {"commit": old_head})
        check("ordinary delivery is unaffected", no_feedback == {})

        resumed_run = am.WorkflowRun(
            id="run-resumed-progress", task_id="task-progress",
            plugin_id="p-progress", plugin_version_id=version.id,
            binding_id="binding-progress", state="running",
            current_nodes=["implement"], context={"adoption": {
                "sourceRunId": run.id, "targetNode": "implement",
                "commit": old_head}})
        resumed = am.NodeRun(
            id="node-resumed-progress-1", run_id=resumed_run.id,
            node_key="implement", node_type="ai", attempt=1, state="running",
            idempotency_key="run-resumed-progress:implement:1", input={})
        session.add_all([resumed_run, resumed])
        await session.commit()

        adopted_same = await workflow_engine._unchanged_rework_delivery(
            session, resumed, {"commit": old_head.upper()})
        check("history continuation rejects its adopted commit",
              adopted_same.get("baselineSource") == "adoption"
              and adopted_same.get("sourceRunId") == run.id)
        adopted_changed = await workflow_engine._unchanged_rework_delivery(
            session, resumed, {"commit": new_head})
        check("history continuation accepts a new commit", adopted_changed == {})

        resumed.node_key = "quality"
        wrong_target = await workflow_engine._unchanged_rework_delivery(
            session, resumed, {"commit": old_head})
        check("adoption baseline only guards its target node", wrong_target == {})

        check("legacy nested git receipt is supported",
              workflow_engine._output_git_head(
                  {"gitDelivery": {"commit": old_head.upper()}}) == old_head)

        review_node = am.NodeRun(
            id="node-review-feedback", run_id=run.id, node_key="review",
            node_type="ai_review", attempt=1, state="failed",
            idempotency_key="run-progress:review:1", error="short UI error",
            output={"review": {
                "summary": "review summary",
                "findings": [
                    {"severity": "major", "file": "src/f%02d.js" % i,
                     "line": i + 1, "message": "finding-%02d " % i + "x" * 400}
                    for i in range(100)
                ],
            }})
        feedback = workflow_engine._rework_evidence(review_node)
        check("review rework receives every structured finding",
              "finding-00" in feedback and "finding-99" in feedback,
              feedback[-240:])
        check("review rework feedback stays bounded",
              len(feedback) <= workflow_engine._REWORK_FEEDBACK_MAX, len(feedback))
        continuation_feedback = workflow_runs._continuation_rework_feedback(
            [
                {"key": "implement", "type": "ai"},
                {"key": "review", "type": "ai_review", "config": {
                    "onFailure": {"retryFrom": "implement", "maxRounds": 2},
                }},
            ], {"review": review_node}, "implement")
        check("history continuation inherits structured review evidence",
              "finding-00" in continuation_feedback
              and "finding-99" in continuation_feedback,
              continuation_feedback[-240:])
        check("unrelated continuation target receives no review evidence",
              workflow_runs._continuation_rework_feedback(
                  [{"key": "review", "type": "ai_review", "config": {
                      "onFailure": {"retryFrom": "implement"},
                  }}], {"review": review_node}, "quality") == "")
        review_node.state = "succeeded"
        check("successful review is not misclassified as rework evidence",
              workflow_runs._continuation_rework_feedback(
                  [{"key": "review", "type": "ai_review", "config": {
                      "onFailure": {"retryFrom": "implement"},
                  }}], {"review": review_node}, "implement") == "")
        review_node.state = "failed"
        review_node.output = {}
        check("ordinary failure keeps the concise fallback",
              workflow_engine._rework_evidence(review_node) == "short UI error")

        conflict = workflow_engine._merge_conflict_rework_feedback({
            "conflict": True,
            "branch": "soduwork/task-progress",
            "target": "main",
            "output": "CONFLICT (content): Merge conflict in src/app.js\n"
                      "Automatic merge failed; fix conflicts and commit the result.",
        })
        check("merge conflict feedback names the writable and protected branches",
              "soduwork/task-progress" in conflict and "main" in conflict,
              conflict)
        check("merge conflict feedback forbids pushing the protected target",
              "不要直接修改或推送受保护目标分支" in conflict,
              conflict)
        check("merge conflict feedback preserves bounded Git diagnostics",
              "src/app.js" in conflict and len(conflict) <= workflow_engine._REWORK_FEEDBACK_MAX,
              conflict)

        retry_version = am.PluginVersion(
            id="pv-conflict-retry", plugin_id="p-conflict-retry", version="1.0.0",
            checksum="d" * 64, trust_state="approved", enabled=True,
            workflow={"nodes": [{"key": "implement", "type": "ai"}]})
        retry_run = am.WorkflowRun(
            id="run-conflict-retry", task_id="task-conflict-retry",
            plugin_id="p-conflict-retry", plugin_version_id=retry_version.id,
            binding_id="binding-conflict-retry", state="failed", current_nodes=[],
            context={"reworkFeedback": {"implement": "合并有冲突，已回退"}})
        retry_source = am.NodeRun(
            id="node-conflict-retry-1", run_id=retry_run.id,
            node_key="implement", node_type="ai", attempt=1, state="failed",
            idempotency_key="run-conflict-retry:implement:1",
            input={"reworkFeedback": "合并有冲突，已回退"},
            output={"failureKind": "contract", "gitDelivery": {
                "branch": "soduwork/task-conflict-retry", "target": "main",
                "commit": old_head}})
        # Manual retry must refer to a live, executable requirement.
        retry_task = models.Task(
            id=retry_run.task_id, title="Merge conflict retry", status="doing")
        session.add_all([retry_task, retry_version, retry_run, retry_source])
        await session.commit()
        retried = await workflow_runs.retry_failed_gate(
            session, retry_run, actor="tester", node_key="implement")
        retained = str(dict(retried.input or {}).get("reworkFeedback") or "")
        check("manual AI retry retains and enriches merge-conflict context",
              "soduwork/task-conflict-retry" in retained
              and "受保护目标分支" in retained,
              retained)

    print("\nrework delivery progress smoke: %d passed, %d failed" % (passed, failed))
    return 1 if failed else 0


async def main() -> int:
    try:
        return await check_progress()
    finally:
        # Close pooled SQLite handles even when an assertion or service raises.
        await engine.dispose()


try:
    sys.exit(asyncio.run(main()))
finally:
    _temporary.cleanup()
