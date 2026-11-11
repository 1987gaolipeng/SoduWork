# -*- coding: utf-8 -*-
"""Recover merge authorization when a new commit invalidates the previous approval.

A commit made after approval invalidates the authorization by design. The already-completed
approval gate does not reopen, so the merge gate must request authorization for the latest
version and enter waiting_human. Polling resumes the merge after approval, preserving the
authorization boundary without requiring manual ticket recreation.

Run offline with a stubbed merge operation and no real Git access.
"""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-reauth.db")
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
from app.services import code_delivery, release_control, workflow_engine, workflow_runs  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra) if extra else ""))


async def main():
    await init_db()
    merged = {"n": 0}

    async def fake_merge(session, task, who="SoduWork"):
        merged["n"] += 1
        return {"ok": True, "merged": True, "branch": "develop"}

    code_delivery.merge_approved = fake_merge          # Stub Git operations to keep the test offline.

    async with SessionLocal() as s:
        s.add(models.Client(id="c-ra", name="测试机"))
        s.add(models.User(id="u-ra", username="boss", display_name="老板", password_hash="x"))
        s.add(models.Project(id="prj-ra", name="测试项目", owner_user_id="u-ra"))
        t = models.Task(id="t-ra", title="修个 bug", status="doing",
                        owner_client_id="c-ra", repo_id="r-ra", project_id="prj-ra")
        s.add(t)
        ver = am.PluginVersion(id="pv-ra", plugin_id="p-ra", version="1", checksum="ra",
                               trust_state="approved", enabled=True,
                               workflow={"nodes": [{"key": "merge", "type": "merge", "name": "合并"}]})
        run = am.WorkflowRun(id="r-run", task_id="t-ra", plugin_id="p-ra",
                             plugin_version_id="pv-ra", binding_id="b-ra",
                             state="running", current_nodes=["merge"])
        nr = am.NodeRun(id="n-merge", run_id="r-run", node_key="merge", node_type="merge",
                        state="queued", attempt=1, idempotency_key="m1")
        box = am.WorkflowOutbox(run_id="r-run", node_run_id="n-merge", topic="node.execute",
                                payload={"nodeKey": "merge", "attempt": 1})
        # Prepare an approved v1 superseded by a new v2 candidate.
        a1 = am.ArtifactVersion(id="a1", task_id="t-ra", seq=1, kind="code",
                                commit_sha="oldsha", checksum="c1", state="superseded")
        a2 = am.ArtifactVersion(id="a2", task_id="t-ra", seq=2, kind="code",
                                commit_sha="newsha", checksum="c2", state="candidate")
        old_req = am.ApprovalRequest(id="q-old", task_id="t-ra", artifact_version_id="a1",
                                     action="merge", status="approved", required_count=1,
                                     policy_snapshot={"separationOfDuties": False})
        s.add_all([ver, run, nr, box, a1, a2, old_req])
        await s.commit()

        # The merge node requests renewed approval instead of failing permanently.
        await workflow_engine._execute_node(s, box)
        nr = await s.get(am.NodeRun, "n-merge")
        chk("★不再钉死（不是 failed）", nr.state != "failed", nr.state)
        chk("转成等人重新授权", nr.state == "waiting_human", nr.state)
        rid = (nr.output or {}).get("requestId") or ""
        chk("★为新版本自动补了一张合并授权票", bool(rid), nr.output)
        req = await s.get(am.ApprovalRequest, rid)
        chk("补的票绑的是**新**版本", req is not None and req.artifact_version_id == "a2",
            req and req.artifact_version_id)
        chk("旧票原样保留（历史不被改写）",
            (await s.get(am.ApprovalRequest, "q-old")).status == "approved")
        evs = (await s.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id == "t-ra",
            models.TaskEvent.kind == "plugin.reauth_required"))).scalars().all()
        chk("时间线上说了要重新授权", len(evs) == 1)
        chk("这一步还没真合并", merged["n"] == 0, merged["n"])

        # Approval returns the merge node to the queue.
        req.status = "approved"
        await s.commit()
        await workflow_engine._poll_node(s, await s.get(am.WorkflowRun, "r-run"), nr)
        chk("★批完自动放回执行队列", nr.state == "queued", nr.state)
        boxes = (await s.execute(select(am.WorkflowOutbox).where(
            am.WorkflowOutbox.node_run_id == "n-merge",
            am.WorkflowOutbox.status == "pending"))).scalars().all()
        chk("真的排了一条重执行", len(boxes) == 1, len(boxes))

        # The next execution performs the now-authorized merge.
        await workflow_engine._execute_node(s, boxes[0])
        nr = await s.get(am.NodeRun, "n-merge")
        chk("★这次合并成功", nr.state == "succeeded", (nr.state, nr.error))
        chk("合并只发生一次", merged["n"] == 1, merged["n"])

        # Previously failed merge gates remain explicitly retryable.
        chk("merge 在 RETRYABLE_GATE_TYPES 里",
            "merge" in workflow_runs.RETRYABLE_GATE_TYPES)

    print("\nmerge reauth smoke: %d passed, %d failed" % (ok, fail))
    return 1 if fail else 0


sys.exit(asyncio.run(main()))
