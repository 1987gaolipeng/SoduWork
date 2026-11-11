# -*- coding: utf-8 -*-
"""A repo context must not turn a prototype gate into code review."""
import asyncio
import os
import sys
from types import SimpleNamespace

DB = os.path.abspath(".smoke-review-mode.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import (code_delivery, release_control, workflow_contracts,
                          workflow_engine, workflow_runs)  # noqa: E402

passed = failed = 0


def check(name, value, extra=""):
    global passed, failed
    if value:
        passed += 1
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name + (" << " + str(extra)[:240] if extra else ""))


WORKFLOW = {"nodes": [
    {"key": "refine", "type": "ai",
     "outputs": [{"key": "requirements", "kind": "file", "required": True}]},
    {"key": "prototype", "type": "ai", "dependsOn": ["refine"],
     "outputs": [{"key": "prototype", "kind": "file", "required": True}]},
    {"key": "validate", "type": "validate", "dependsOn": ["prototype"]},
    {"key": "review", "type": "human_review", "dependsOn": ["validate"],
     "config": {"action": "review"}},
]}


async def seed():
    await init_db()
    async with SessionLocal() as session:
        session.add(models.Task(
            id="task-review-mode", title="Prototype", status="doing",
            repo_id="repo-is-context-not-output"))
        session.add(am.PluginVersion(
            id="version-review-mode", plugin_id="plugin-review-mode",
            version="1.0.0", checksum="review-mode", trust_state="approved",
            workflow=WORKFLOW))
        session.add(am.WorkflowRun(
            id="run-review-mode", task_id="task-review-mode",
            plugin_id="plugin-review-mode", plugin_version_id="version-review-mode",
            binding_id="binding-review-mode", state="running"))
        rows = [
            ("refine", "ai", "ref-requirements", "Requirements and acceptance criteria."),
            ("prototype", "ai", "ref-prototype", "Interactive HTML prototype."),
            ("validate", "validate", "", ""),
        ]
        for key, kind, ref, text in rows:
            output = ({"ref": ref, "outputReceipt": {"ref": ref, "text": text}}
                      if ref else {"checks": [{"state": "passed"}]})
            session.add(am.NodeRun(
                id="node-" + key, run_id="run-review-mode", node_key=key,
                node_type=kind, attempt=1, state="succeeded", output=output,
                idempotency_key=f"run-review-mode:{key}:1"))
        session.add(am.NodeRun(
            id="node-review", run_id="run-review-mode", node_key="review",
            node_type="human_review", attempt=1, state="queued",
            idempotency_key="run-review-mode:review:1"))
        session.add(am.WorkflowOutbox(
            id="outbox-review", run_id="run-review-mode",
            node_run_id="node-review", topic="node.execute",
            payload={"nodeKey": "review"}))
        await session.commit()


async def main():
    await seed()
    review_node = WORKFLOW["nodes"][-1]
    check("repo-backed prototype remains file review",
          not workflow_contracts.review_requires_code(WORKFLOW, review_node))
    code_flow = {"nodes": [
        {"key": "implement", "type": "ai",
         "outputs": [{"key": "code", "kind": "git", "required": True}]},
        {"key": "review", "type": "human_review", "dependsOn": ["implement"]},
    ]}
    check("declared Git output requires code review",
          workflow_contracts.review_requires_code(code_flow, code_flow["nodes"][-1]))
    explicit = {"nodes": [
        {"key": "write", "type": "ai"},
        {"key": "review", "type": "human_review", "dependsOn": ["write"],
         "config": {"requireCodeVersion": True}},
    ]}
    check("explicit code contract overrides inference",
          workflow_contracts.review_requires_code(explicit, explicit["nodes"][-1]))

    async with SessionLocal() as session:
        run = await session.get(am.WorkflowRun, "run-review-mode")
        version = await session.get(am.PluginVersion, "version-review-mode")
        refs, text = await workflow_engine._review_material(
            session, run, version, review_node)
        check("transitive refs are collected",
              refs == ["ref-requirements", "ref-prototype"], refs)
        check("transitive summaries are collected",
              "acceptance criteria" in text and "Interactive HTML" in text, text)

    calls = {"code": 0, "output": None, "gate": None}
    real_output = release_control.ensure_current_output
    real_request = release_control.ensure_request
    real_code = code_delivery.check

    async def fake_output(session, task, **kwargs):
        calls["output"] = kwargs
        return SimpleNamespace(id="artifact-files", kind="files", commit_sha=""), True

    async def fake_request(session, task, artifact, action,
                           environment_id="", context=None):
        calls["gate"] = dict(context or {})
        return SimpleNamespace(id="approval-files", status="pending")

    async def fail_code(*args, **kwargs):
        calls["code"] += 1
        raise AssertionError("file gate invoked code delivery")

    release_control.ensure_current_output = fake_output
    release_control.ensure_request = fake_request
    code_delivery.check = fail_code
    try:
        async with SessionLocal() as session:
            outbox = await session.get(am.WorkflowOutbox, "outbox-review")
            await workflow_engine._execute_node(session, outbox)
            row = await session.get(am.NodeRun, "node-review")
            check("review waits for a human", row.state == "waiting_human", row.state)
            check("all refs are scoped into one review artifact",
                  calls["output"]["source_refs"] ==
                  ["ref-requirements", "ref-prototype"], calls["output"])
            check("review artifact is scoped to this workflow run",
                  calls["output"]["workflow_run_id"] == "run-review-mode",
                  calls["output"])
            check("code delivery is not invoked", calls["code"] == 0, calls["code"])
            check("gate carries workflow context",
                  calls["gate"].get("workflowRunId") == "run-review-mode" and
                  calls["gate"].get("nodeKey") == "review", calls["gate"])
    finally:
        release_control.ensure_current_output = real_output
        release_control.ensure_request = real_request
        code_delivery.check = real_code

    recovered = {"count": 0}
    real_recover = workflow_runs._recover_code_candidate

    async def fail_recover(*args, **kwargs):
        recovered["count"] += 1
        raise AssertionError("file review tried to recover Git")

    workflow_runs._recover_code_candidate = fail_recover
    try:
        async with SessionLocal() as session:
            run = await session.get(am.WorkflowRun, "run-review-mode")
            row = await session.get(am.NodeRun, "node-review")
            run.state, run.error = "failed", "old gate failure"
            row.state, row.error, row.output = "failed", "old gate failure", {}
            await session.commit()
        async with SessionLocal() as session:
            run = await session.get(am.WorkflowRun, "run-review-mode")
            retry = await workflow_runs._retry_failed_gate(
                session, run, "smoke", {"human_review"}, "review")
            check("retry creates attempt two", retry.attempt == 2, retry.attempt)
        check("file retry never recovers Git", recovered["count"] == 0,
              recovered["count"])
    finally:
        workflow_runs._recover_code_candidate = real_recover

    print(f"\n{passed} PASS / {failed} FAIL")
    return failed


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(main()) else 0)
