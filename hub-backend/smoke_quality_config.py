# -*- coding: utf-8 -*-
"""Offline tests bind quality gates to immutable implementation outputs and restore that evidence
before retry. Ordinary Git delivery needs URL and target branch, not a Hub-local project
checkout.
"""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-qualitycfg.db")
for sfx in ("", "-shm", "-wal"):
    try:
        os.remove(DB + sfx)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import automation_models as am  # noqa: E402
from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import code_delivery, workflow_engine, workflow_runs  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


async def main():
    await init_db()
    async with SessionLocal() as s:
        s.add(models.Client(id="c-qc", name="机"))
        s.add(models.Project(id="p-qc", name="项目", owner_user_id="u1"))
        # Deliberately omit a Hub project directory to exercise remote Runner deployment.
        s.add(models.Repo(id="r-qc", project_id="p-qc", name="仓", git_url="https://x/repo.git",
                          default_branch="main", merge_branch="main", server_dir=""))
        s.add(models.Task(id="t-qc", title="建站", status="doing", owner_client_id="c-qc",
                          project_id="p-qc", repo_id="r-qc"))
        s.add(am.PluginVersion(id="pv-qc", plugin_id="pl-qc", version="1", checksum="x",
                               trust_state="approved",
                               workflow={"nodes": [
                                   {"key": "implement", "type": "ai",
                                    "outputs": [{"key": "code", "kind": "git", "required": True}]},
                                   {"key": "quality", "type": "quality",
                                    "dependsOn": ["implement"],
                                    "config": {"commands": []}},
                               ]}))
        run = am.WorkflowRun(id="run-qc", task_id="t-qc", plugin_id="pl-qc",
                             plugin_version_id="pv-qc", binding_id="b-qc", state="failed")
        s.add(run)
        s.add(am.NodeRun(id="n-impl", run_id="run-qc", node_key="implement", node_type="ai",
                         attempt=3, state="succeeded", idempotency_key="run-qc:implement:3",
                         output={"gitBranch": "feature/site", "gitHead": "beef1234"},
                         executor={"provider": "runner", "runnerId": "rx", "ref": "ref-qc"}))
        s.add(am.NodeRun(id="n-q", run_id="run-qc", node_key="quality", node_type="quality",
                         attempt=3, state="failed", idempotency_key="run-qc:quality:3"))
        await s.commit()

    # Verify no Hub-local directory dependency.
    async with SessionLocal() as s:
        run = await s.get(am.WorkflowRun, "run-qc")
        task = await s.get(models.Task, "t-qc")
        repo = await s.get(models.Repo, "r-qc")
        nr = await s.get(am.NodeRun, "n-q")
        node = {"key": "quality", "type": "quality", "config": {"commands": []}}
        chk("① 仓库地址和目标分支足以判定为 Runner 代码交付",
            code_delivery._delivery_ready(repo))
        try:
            await workflow_engine._start_quality(s, run, task, nr, node)
            chk("① 没有不可变代码版本时质量门禁拒绝运行", False, "居然没抛")
        except ValueError as e:
            chk("① 拒绝原因是缺少固定代码版本而不是 Hub 目录",
                "固定代码版本" in str(e) and "服务端合并目录" not in str(e), str(e))

    # Restore fixed-version evidence before retrying quality.
    called = {}

    async def fake_recover(session, run, task, rows):
        called["yes"] = True

    real = workflow_runs._recover_code_candidate
    workflow_runs._recover_code_candidate = fake_recover
    try:
        async with SessionLocal() as s:
            run = await s.get(am.WorkflowRun, "run-qc")
            node = await workflow_runs._retry_failed_gate(
                s, run, "冒烟", allowed={"quality"})
            chk("② quality 重试放行并新建 attempt", node.attempt == 4, node.attempt)
        chk("② quality 重试前先恢复代码版本（原来只有 human_review 有）",
            called.get("yes") is True)
    finally:
        workflow_runs._recover_code_candidate = real

    print(f"\n{ok} PASS / {fail} FAIL")
    return fail


if __name__ == "__main__":
    rc = asyncio.run(main())
    sys.exit(1 if rc else 0)
