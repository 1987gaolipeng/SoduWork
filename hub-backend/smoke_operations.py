"""Offline operations read-model and bounded telemetry smoke."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import tempfile


_tmp = tempfile.TemporaryDirectory(prefix="soduwork-operations-")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + (Path(_tmp.name) / ".smoke-operations.db").as_posix()

from app import automation_models as am  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.services import operations, runtime_telemetry  # noqa: E402


checks = 0


def ok(value, message: str) -> None:
    global checks
    if not value:
        raise AssertionError(message)
    checks += 1


async def main() -> None:
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    runtime_telemetry.reset_for_test()
    runtime_telemetry.record("GET", "/api/v1/tasks/{id}", 200, 22, "r-good")
    runtime_telemetry.record("GET", "/api/v1/tasks/{id}", 503, 320, "r-bad", "TimeoutError")
    runtime_telemetry.record("GET", "/assets/app.js", 200, 2, "asset")
    report = runtime_telemetry.summary()
    ok(report["requests"] == 2 and report["errors"] == 1,
       "telemetry count/error aggregation is wrong")
    ok(report["recentErrors"][0]["requestId"] == "r-bad",
       "correlation id missing from recent errors")
    ok(report["routes"][0]["route"] == "/api/v1/tasks/{id}",
       "framework route was not retained")

    async with SessionLocal() as session:
        session.add(am.RunnerNode(id="runner-offline", host="build-01", dispatch_mode="accepting"))
        session.add(am.WorkflowRun(task_id="task-1", plugin_id="p", plugin_version_id="v",
                                   state="failed", error="quality gate failed"))
        session.add(am.ExecutionSession(task_id="task-1", ref="ref-1", state="running"))
        session.add(am.ApprovalRequest(task_id="task-1", artifact_version_id="a", action="accept",
                                       environment_id="env", policy_id="policy", status="pending",
                                       required_count=1, created_by="u"))
        await session.commit()
        data = await operations.overview(session)
        ok(data["database"]["ready"], "database readiness failed")
        ok(data["hub"]["mode"] == "single-control-plane",
           "cluster boundary must be explicit")
        ok(data["work"]["workflow"]["failed"] == 1 and data["work"]["pendingApprovals"] == 1,
           "workflow/approval counts are wrong")
        ok(data["work"]["executions"]["running"] == 1,
           "execution session count is wrong")
        ok(data["runners"]["total"] == 1 and data["runners"]["online"] == 0,
           "runner topology is wrong")
        ok("workRoot" not in data["runners"]["items"][0] and
           "authState" not in data["runners"]["items"][0],
           "operations view leaked runner internals")
        ok(any(x["title"] == "没有可接活的 Runner" for x in data["blockers"]),
           "offline runner blocker missing")
        ok(data["recentFailures"][0]["error"] == "quality gate failed",
           "recent failure evidence missing")
    await engine.dispose()


try:
    asyncio.run(main())
finally:
    try:
        asyncio.run(engine.dispose())
    except Exception:
        pass
    _tmp.cleanup()

print(f"operations telemetry: {checks} checks passed")
