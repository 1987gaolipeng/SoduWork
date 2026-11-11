# -*- coding: utf-8 -*-
"""Runner terminal events advance their exact workflow node without waiting for a scan."""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-workflow-terminal-wakeup.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import automation_models as am, models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import resource_leases, workflow_engine  # noqa: E402

ok = fail = 0


def chk(name, condition, extra=""):
    global ok, fail
    if condition:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + (" << " + str(extra)[:300] if extra else ""))


async def main():
    await init_db()
    old_load = workflow_engine.ai_exec.load
    old_status = workflow_engine.ai_exec.status_sync

    async def fake_load(_session):
        return {}

    def fake_status(_ctx, ref):
        return {"ok": True, "done": True, "running": False, "error": "",
                "attachments": [], "artifactUrl": "", "ref": ref}

    workflow_engine.ai_exec.load = fake_load
    workflow_engine.ai_exec.status_sync = fake_status
    try:
        async with SessionLocal() as session:
            session.add(models.Client(id="c-terminal-wakeup", name="Wakeup"))
            session.add(models.Task(
                id="t-terminal-wakeup", title="Terminal wakeup", status="doing",
                owner_client_id="c-terminal-wakeup"))
            session.add(am.PluginVersion(
                id="pv-terminal-wakeup", plugin_id="p-terminal-wakeup", version="1",
                checksum="x", trust_state="approved",
                workflow={"nodes": [{"key": "work", "type": "ai"}]}))
            session.add(am.WorkflowRun(
                id="run-terminal-wakeup", task_id="t-terminal-wakeup",
                plugin_id="p-terminal-wakeup", plugin_version_id="pv-terminal-wakeup",
                binding_id="b-terminal-wakeup", state="running"))
            session.add(am.NodeRun(
                id="node-terminal-wakeup", run_id="run-terminal-wakeup",
                node_key="work", node_type="ai", attempt=1, state="running",
                idempotency_key="run-terminal-wakeup:work:1",
                started_at=workflow_engine._now(),
                executor={"provider": "runner", "runnerId": "runner-wakeup",
                          "ref": "ref-terminal-wakeup"}))
            await session.commit()

        async with SessionLocal() as session:
            result = await workflow_engine.reconcile_terminal_execution(
                session, "run-terminal-wakeup", "node-terminal-wakeup",
                "ref-terminal-wakeup")
        async with SessionLocal() as session:
            run = await session.get(am.WorkflowRun, "run-terminal-wakeup")
            node = await session.get(am.NodeRun, "node-terminal-wakeup")
            task = await session.get(models.Task, "t-terminal-wakeup")
        chk("terminal event advances the exact running node", result.get("advanced")
            and node.state == "succeeded", (result, node.state))
        chk("the workflow closes immediately", run.state == "succeeded", run.state)
        chk("task status follows the completed workflow", task.status == "done", task.status)

        async with SessionLocal() as session:
            again = await workflow_engine.reconcile_terminal_execution(
                session, "run-terminal-wakeup", "node-terminal-wakeup",
                "ref-terminal-wakeup")
        chk("duplicate terminal events are idempotent", again.get("ok")
            and again.get("idempotent"), again)

        async with SessionLocal() as session:
            lease = await resource_leases.acquire(
                session, "workflow-run", "run-terminal-wakeup",
                owner="smoke-holder", ttl_seconds=60)
            busy = await workflow_engine.reconcile_terminal_execution(
                session, "run-terminal-wakeup", "node-terminal-wakeup",
                "ref-terminal-wakeup")
            await resource_leases.release(session, lease)
        chk("a concurrent owner yields to the durable workflow lease",
            not busy.get("ok") and busy.get("retry")
            and busy.get("reason") == "workflow-busy", busy)
    finally:
        workflow_engine.ai_exec.load = old_load
        workflow_engine.ai_exec.status_sync = old_status

    print(f"WORKFLOW_TERMINAL_WAKEUP_OK: {ok} assertions")
    if fail:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
