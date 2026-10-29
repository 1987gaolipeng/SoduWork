# -*- coding: utf-8 -*-
"""Regression checks for public module contracts."""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-revoke.db")
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
from app.services import release_control  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:280] if extra else ""))


async def _seed():
    await init_db()
    async with SessionLocal() as s:
        s.add(models.Client(id="c-rv", name="机"))
        u = models.User(id="u-rv", username="admin-rv", display_name="超管", is_super=True)
        s.add(u)
        s.add(models.Task(id="t-rv", title="撤回冒烟", status="doing",
                          owner_client_id="c-rv", created_by="u-rv",
                          requester_user_id="u-rv"))
        s.add(am.PluginVersion(id="pv-rv", plugin_id="pl-rv", version="1", checksum="x",
                               trust_state="approved",
                               workflow={"nodes": [
                                   {"key": "spec", "type": "spec",
                                    "config": {"files": ["requirements.md"]}},
                                   {"key": "impl", "type": "ai", "dependsOn": ["spec"]},
                               ]}))
        await s.commit()


async def main():
    await _seed()

    # Revoke a baseline approval across request, artifact, and workflow state.
    async with SessionLocal() as s:
        task = await s.get(models.Task, "t-rv")
        art = am.ArtifactVersion(id="av-rv", task_id="t-rv", seq=1, kind="requirement",
                                 checksum="c1", state="baselined")
        s.add(art)
        req = am.ApprovalRequest(id="ar-rv", task_id="t-rv", artifact_version_id="av-rv",
                                 action="baseline", status="approved")
        s.add(req)
        s.add(am.ApprovalAssignment(request_id="ar-rv", user_id="u-rv", user_name="超管",
                                    sources=[{"type": "requester"}]))
        s.add(am.ApprovalDecision(request_id="ar-rv", user_id="u-rv", user_name="超管",
                                  decision="approve", note="当时批的"))
        run = am.WorkflowRun(id="run-rv", task_id="t-rv", plugin_id="pl-rv",
                             plugin_version_id="pv-rv", binding_id="b", state="running")
        s.add(run)
        s.add(am.NodeRun(id="n-spec", run_id="run-rv", node_key="spec", node_type="spec",
                         attempt=1, state="succeeded", idempotency_key="run-rv:spec:1",
                         output={"requestId": "ar-rv", "artifactVersionId": "av-rv"}))
        s.add(am.NodeRun(id="n-impl", run_id="run-rv", node_key="impl", node_type="ai",
                         attempt=1, state="running", idempotency_key="run-rv:impl:1",
                         executor={"kind": "ai", "ref": "ref-impl-rv",
                                   "provider": "local", "runnerId": ""}))
        await s.commit()

    stopped = []
    from app.services import ai_exec
    real_stop = ai_exec.stop_sync
    ai_exec.stop_sync = lambda ctx, ref: (stopped.append(ref) or {"ok": True})
    try:
        async with SessionLocal() as s:
            task = await s.get(models.Task, "t-rv")
            u = await s.get(models.User, "u-rv")
            out = await release_control.revoke_approval(s, task, u, "ar-rv", note="")
            chk("撤回必须写原因", not out.get("ok") and out.get("reason") == "note", out)
            out = await release_control.revoke_approval(s, task, u, "ar-rv", note="批错了，范围要改")
            chk("批准的基线可以撤回", out.get("ok"), out)
            chk("流程侧做了 rework（下游作废重排）", out.get("reworked") is True, out)
        chk("★在跑的下游 AI 先被叫停再作废", stopped == ["ref-impl-rv"], stopped)
    finally:
        ai_exec.stop_sync = real_stop
    async with SessionLocal() as s:
        req = await s.get(am.ApprovalRequest, "ar-rv")
        art = await s.get(am.ArtifactVersion, "av-rv")
        impl = await s.get(am.NodeRun, "n-impl")
        spec = await s.get(am.NodeRun, "n-spec")
        run = await s.get(am.WorkflowRun, "run-rv")
        chk("票标 revoked、历史决策保留", req.status == "revoked"
            and len(await release_control._decisions(s, "ar-rv")) == 1, req.status)
        chk("产出状态回退（baselined → candidate）", art.state == "candidate", art.state)
        chk("受影响节点作废（spec/impl → rework）",
            spec.state == "rework" and impl.state == "rework", (spec.state, impl.state))
        chk("run 回到 running 等重排", run.state == "running", run.state)
        ev = (await s.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id == "t-rv",
            models.TaskEvent.kind == "release.revoked"))).scalars().all()
        chk("时间线记了 release.revoked", len(ev) == 1)

    # Reapproval creates a new request rather than reviving the revoked one.
    async with SessionLocal() as s:
        task = await s.get(models.Task, "t-rv")
        art = await s.get(am.ArtifactVersion, "av-rv")
        fresh = await release_control.ensure_request(s, task, art, "baseline")
        chk("重审开的是新票，不复活 revoked 那张", fresh.id != "ar-rv"
            and fresh.status == "pending", (fresh.id, fresh.status))
        # Reject repeated revocation.
        u = await s.get(models.User, "u-rv")
        out = await release_control.revoke_approval(s, task, u, "ar-rv", note="再撤一次")
        chk("已撤回的票不能再撤", not out.get("ok") and out.get("reason") == "status", out)

    # Reject revocation after code merge.
    async with SessionLocal() as s:
        s.add(am.ArtifactVersion(id="av-mg", task_id="t-rv", seq=2, kind="code",
                                 commit_sha="beef", checksum="c2", state="merged"))
        s.add(am.ApprovalRequest(id="ar-mg", task_id="t-rv", artifact_version_id="av-mg",
                                 action="merge", status="approved"))
        s.add(am.ApprovalAssignment(request_id="ar-mg", user_id="u-rv", user_name="超管",
                                    sources=[{"type": "requester"}]))
        await s.commit()
    async with SessionLocal() as s:
        task = await s.get(models.Task, "t-rv")
        u = await s.get(models.User, "u-rv")
        out = await release_control.revoke_approval(s, task, u, "ar-mg", note="想反悔")
        chk("★代码已合并的授权拒绝撤回（只能向前修复）",
            not out.get("ok") and out.get("reason") == "irreversible"
            and "向前修复" in out.get("error", ""), out)

    # Reject revocation after deployment is queued.
    async with SessionLocal() as s:
        s.add(am.ArtifactVersion(id="av-dp", task_id="t-rv", seq=3, kind="code",
                                 commit_sha="cafe", checksum="c3", state="tested"))
        s.add(am.ApprovalRequest(id="ar-dp", task_id="t-rv", artifact_version_id="av-dp",
                                 action="deploy", environment_id="e-p", status="approved"))
        s.add(am.ApprovalAssignment(request_id="ar-dp", user_id="u-rv", user_name="超管",
                                    sources=[{"type": "requester"}]))
        s.add(am.DeploymentRun(id="dr-rv", task_id="t-rv", artifact_version_id="av-dp",
                               environment_id="e-p", target_id="tg", state="running",
                               attempt=1, idempotency_key="av-dp:tg"))
        await s.commit()
    async with SessionLocal() as s:
        task = await s.get(models.Task, "t-rv")
        u = await s.get(models.User, "u-rv")
        out = await release_control.revoke_approval(s, task, u, "ar-dp", note="发错了")
        chk("★发布已排入/进行中的授权拒绝撤回（指去回滚）",
            not out.get("ok") and out.get("reason") == "irreversible"
            and "回滚" in out.get("error", ""), out)

    # Revoking review cancels its pending merge authorization.
    async with SessionLocal() as s:
        s.add(am.ArtifactVersion(id="av-rw", task_id="t-rv", seq=4, kind="code",
                                 commit_sha="f00d", checksum="c4", state="reviewed"))
        s.add(am.ApprovalRequest(id="ar-rw", task_id="t-rv", artifact_version_id="av-rw",
                                 action="review", status="approved"))
        s.add(am.ApprovalRequest(id="ar-rw-m", task_id="t-rv", artifact_version_id="av-rw",
                                 action="merge", status="pending"))
        s.add(am.ApprovalAssignment(request_id="ar-rw", user_id="u-rv", user_name="超管",
                                    sources=[{"type": "requester"}]))
        await s.commit()
    async with SessionLocal() as s:
        task = await s.get(models.Task, "t-rv")
        u = await s.get(models.User, "u-rv")
        out = await release_control.revoke_approval(s, task, u, "ar-rw", note="审漏了一处")
        chk("代码 review 撤回放行（未合并）", out.get("ok"), out)
        m = await s.get(am.ApprovalRequest, "ar-rw-m")
        chk("★级联取消了当时自动开出的 merge 票", m.status == "cancelled", m.status)

    print(f"\n{ok} PASS / {fail} FAIL")
    return fail


if __name__ == "__main__":
    sys.exit(1 if asyncio.run(main()) else 0)
