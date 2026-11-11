# -*- coding: utf-8 -*-
"""Redeploy an existing artifact after deployment scripts or environment configuration change.

An explicit redeploy creates a new attempt rather than returning the prior idempotent
success. Reject concurrent deployments and recheck approvals so redeploy cannot bypass
environment authorization. Run offline with an isolated temporary database.
"""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-redeploy.db")
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
from app.services import deployments  # noqa: E402

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
    async with SessionLocal() as s:
        s.add(models.Client(id="c-rd", name="机"))
        s.add(models.Task(id="t-rd", title="发布", status="doing", owner_client_id="c-rd"))
        s.add(models.Repo(id="r-rd", project_id="p-rd", name="仓", git_url="x",
                          default_branch="main"))
        s.add(am.Environment(id="e-test", key="test", name="测试环境", sort=10,
                             promotion_policy={"autoStart": True}))
        s.add(am.Environment(id="e-prod", key="production", name="生产环境", sort=20,
                             promotion_policy={"autoStart": True, "requires": ["test"],
                                               "requiresApproval": True}))
        s.add(am.DeploymentTarget(id="tg-test", repo_id="r-rd", environment_id="e-test",
                                  name="测试实例", config={"argv": ["sh", "d.sh", "test"]}))
        s.add(am.DeploymentTarget(id="tg-prod", repo_id="r-rd", environment_id="e-prod",
                                  name="生产实例", config={"argv": ["sh", "d.sh", "production"]}))
        s.add(am.DeploymentTarget(id="tg-virgin", repo_id="r-rd", environment_id="e-test",
                                  name="从没发过的实例", config={"argv": ["sh", "d.sh", "test"]}))
        s.add(am.ArtifactVersion(id="av-rd", task_id="t-rd", seq=1, kind="code",
                                 commit_sha="abc1234def", checksum="ck1", state="merged"))
        # Prepare a successful testing deployment with prior attempts.
        s.add(am.DeploymentRun(id="dr-old-fail", task_id="t-rd", artifact_version_id="av-rd",
                               environment_id="e-test", target_id="tg-test", state="failed",
                               attempt=1, idempotency_key="av-rd:tg-test", commit_sha="abc1234def"))
        s.add(am.DeploymentRun(id="dr-old-ok", task_id="t-rd", artifact_version_id="av-rd",
                               environment_id="e-test", target_id="tg-test", state="succeeded",
                               attempt=2, idempotency_key="av-rd:tg-test", commit_sha="abc1234def"))
        # Prepare a successful production deployment with recorded approval.
        s.add(am.DeploymentRun(id="dr-prod-ok", task_id="t-rd", artifact_version_id="av-rd",
                               environment_id="e-prod", target_id="tg-prod", state="succeeded",
                               attempt=1, idempotency_key="av-rd:tg-prod", commit_sha="abc1234def"))
        await s.commit()

    # Reject targets never previously deployed.
    async with SessionLocal() as s:
        tg = await s.get(am.DeploymentTarget, "tg-virgin")
        out = await deployments.redeploy_target(s, tg, who="冒烟")
        chk("从没成功发布过的目标不能重发", not out.get("ok") and "没有可重发" in out.get("error", ""),
            out)

    # Redeployment increments the attempt number.
    async with SessionLocal() as s:
        tg = await s.get(am.DeploymentTarget, "tg-test")
        out = await deployments.redeploy_target(s, tg, who="冒烟")
        chk("有成功历史的目标可以重发", out.get("ok"), out)
        run = out.get("run") or {}
        chk("重发的 attempt 在原有基础上 +1", run.get("attempt") == 3, run)
        chk("重发沿用同一个产物与提交", run.get("commit") == "abc1234def", run)
    async with SessionLocal() as s:
        row = (await s.execute(select(am.DeploymentRun).where(
            am.DeploymentRun.idempotency_key == "av-rd:tg-test"
        ).order_by(am.DeploymentRun.attempt.desc()).limit(1))).scalar_one()
        chk("重发生成了新的 DeploymentRun（queued，等执行机）",
            row.attempt == 3 and row.state == "queued", (row.attempt, row.state))
        chk("重发标记与操作者留在 result 里",
            dict(row.result or {}).get("redeploy") is True
            and dict(row.result or {}).get("requestedBy") == "冒烟", row.result)
        ev = (await s.execute(select(models.TaskEvent).where(
            models.TaskEvent.task_id == "t-rd",
            models.TaskEvent.kind == "release.redeploy_requested"))).scalars().all()
        chk("任务时间线记了 redeploy_requested 事件", len(ev) == 1,
            [e.kind for e in ev])

    # Reject another redeployment while the new attempt is queued.
    async with SessionLocal() as s:
        tg = await s.get(am.DeploymentTarget, "tg-test")
        out = await deployments.redeploy_target(s, tg, who="冒烟")
        chk("在途（queued/running）时拒绝再次重发",
            not out.get("ok") and "进行中" in out.get("error", ""), out)

    # Reject approval-required environments without an approval record.
    async with SessionLocal() as s:
        tg = await s.get(am.DeploymentTarget, "tg-prod")
        out = await deployments.redeploy_target(s, tg, who="冒烟")
        chk("需要审批的环境没有历史批准就不能重发",
            not out.get("ok") and "批准" in out.get("error", ""), out)

    # Allow redeployment after verifying the existing approval.
    async with SessionLocal() as s:
        s.add(am.ApprovalRequest(id="ar-rd", task_id="t-rd", artifact_version_id="av-rd",
                                 action="deploy", environment_id="e-prod", status="approved"))
        await s.commit()
    async with SessionLocal() as s:
        tg = await s.get(am.DeploymentTarget, "tg-prod")
        out = await deployments.redeploy_target(s, tg, who="冒烟")
        chk("产物当时的发布批准仍在 -> 重发放行（不重开审批）", out.get("ok"), out)
        chk("生产重发 attempt=2", (out.get("run") or {}).get("attempt") == 2, out.get("run"))

    # Reject disabled targets.
    async with SessionLocal() as s:
        tg = await s.get(am.DeploymentTarget, "tg-test")
        tg.enabled = False
        await s.commit()
        out = await deployments.redeploy_target(s, tg, who="冒烟")
        chk("停用的目标不能重发", not out.get("ok") and "停用" in out.get("error", ""), out)

    print(f"\n{ok} PASS / {fail} FAIL")
    return fail


if __name__ == "__main__":
    rc = asyncio.run(main())
    sys.exit(1 if rc else 0)
