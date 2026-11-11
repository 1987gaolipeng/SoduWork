# -*- coding: utf-8 -*-
"""Disposable SQLite proof for deployment FIFO and multi-Hub start leases."""
from __future__ import annotations

import atexit
import asyncio
import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone


ROOT = os.path.abspath(os.path.dirname(__file__))
SMOKE_ROOT = tempfile.mkdtemp(prefix="soduwork-deployment-fifo-")
SMOKE_DB = os.path.join(SMOKE_ROOT, ".smoke-deployment-fifo.db")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + SMOKE_DB.replace("\\", "/")
atexit.register(lambda: shutil.rmtree(SMOKE_ROOT, ignore_errors=True))
sys.path.insert(0, ROOT)

from app import automation_models as am  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import deployments, resource_leases  # noqa: E402


checks = 0


def ok(condition, message):
    global checks
    if not condition:
        raise AssertionError(message)
    checks += 1


async def main():
    await init_db()
    now = datetime.now(timezone.utc)
    async with SessionLocal() as session:
        session.add_all([
            am.DeploymentTarget(
                id="target-a-1", repo_id="repo-a", environment_id="env-live",
                name="A first", provider="runner-command", enabled=True),
            am.DeploymentTarget(
                id="target-a-2", repo_id="repo-a", environment_id="env-live",
                name="A second", provider="runner-command", enabled=True),
            am.DeploymentTarget(
                id="target-b-1", repo_id="repo-b", environment_id="env-live",
                name="B first", provider="runner-command", enabled=True),
            am.DeploymentTarget(
                id="target-c-1", repo_id="repo-c", environment_id="env-live",
                name="C first", provider="runner-command", enabled=True),
            am.DeploymentRun(
                id="run-old-a", task_id="task-old", artifact_version_id="artifact-old",
                environment_id="env-live", target_id="target-a-1", state="queued",
                attempt=1, idempotency_key="artifact-old:target-a-1",
                created_at=now - timedelta(minutes=3)),
            am.DeploymentRun(
                id="run-old-b", task_id="task-old", artifact_version_id="artifact-old",
                environment_id="env-live", target_id="target-a-2", state="queued",
                attempt=1, idempotency_key="artifact-old:target-a-2",
                created_at=now - timedelta(minutes=3)),
            am.DeploymentRun(
                id="run-new", task_id="task-new", artifact_version_id="artifact-new",
                environment_id="env-live", target_id="target-a-1", state="queued",
                attempt=1, idempotency_key="artifact-new:target-a-1",
                created_at=now - timedelta(minutes=1)),
            am.DeploymentRun(
                id="run-other-repo", task_id="task-other", artifact_version_id="artifact-other",
                environment_id="env-live", target_id="target-b-1", state="queued",
                attempt=1, idempotency_key="artifact-other:target-b-1", created_at=now),
        ])
        await session.commit()

    started = []
    original_start = deployments._start

    async def fake_start(session, run):
        started.append(run.id)
        run.state, run.started_at, run.error = "running", now, ""
        await session.commit()

    deployments._start = fake_start
    try:
        async with SessionLocal() as session:
            new = await session.get(am.DeploymentRun, "run-new")
            ok(not await deployments._try_start(session, new),
               "a newer artifact started before the older release group")
            view = deployments.run_api(new)
            ok(new.state == "queued" and view["queue"].get("state") ==
               "waiting_previous_release", "the waiting reason is not visible in the API")
            ok(started == [], "the blocked deployment reached the provider")

        async with SessionLocal() as session:
            old_a = await session.get(am.DeploymentRun, "run-old-a")
            old_b = await session.get(am.DeploymentRun, "run-old-b")
            ok(await deployments._try_start(session, old_a),
               "the oldest release group did not start")
            ok(await deployments._try_start(session, old_b),
               "targets in the same artifact group were not allowed in parallel")
            new = await session.get(am.DeploymentRun, "run-new")
            ok(not await deployments._try_start(session, new),
               "the next artifact started while the previous artifact was running")

        async with SessionLocal() as session:
            old_a = await session.get(am.DeploymentRun, "run-old-a")
            old_b = await session.get(am.DeploymentRun, "run-old-b")
            old_a.state = old_b.state = "succeeded"
            old_a.finished_at = old_b.finished_at = now
            await session.commit()
            new = await session.get(am.DeploymentRun, "run-new")
            ok(await deployments._try_start(session, new),
               "the next artifact did not start after the prior group became terminal")
            ok(not deployments.run_api(new)["queue"],
               "the queue reason remained after the deployment started")

        async with SessionLocal() as session:
            other = await session.get(am.DeploymentRun, "run-other-repo")
            ok(await deployments._try_start(session, other),
               "a different repository in the same environment was incorrectly blocked")

        async with SessionLocal() as setup:
            setup.add(am.DeploymentRun(
                id="run-leased", task_id="task-leased", artifact_version_id="artifact-leased",
                environment_id="env-live", target_id="target-c-1", state="queued",
                attempt=1, idempotency_key="artifact-leased:target-c-1",
                created_at=now + timedelta(minutes=1)))
            await setup.commit()
        async with SessionLocal() as owner:
            lease = await resource_leases.acquire(
                owner, "deployment-start", "run-leased", owner="hub-a", ttl_seconds=60)
            async with SessionLocal() as rival:
                leased = await rival.get(am.DeploymentRun, "run-leased")
                ok(not await deployments._try_start(rival, leased),
                   "a second Hub acquired the same deployment start")
                ok("run-leased" not in started,
                   "the provider was called while another Hub owned the start lease")
            await resource_leases.release(owner, lease)
        async with SessionLocal() as recovered:
            leased = await recovered.get(am.DeploymentRun, "run-leased")
            ok(await deployments._try_start(recovered, leased),
               "a released deployment lease could not be resumed")
            ok(started.count("run-leased") == 1,
               "one deployment run was started more than once")
    finally:
        deployments._start = original_start
        await engine.dispose()


asyncio.run(main())
print(f"deployment FIFO: {checks} checks passed")
