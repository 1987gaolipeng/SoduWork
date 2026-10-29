"""Loopback Hub for the desktop/Runner handoff E2E; no business data or models."""
import asyncio
import json
from pathlib import Path
import socket
import sys
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_conversation_handoffs import HandoffTests, WORK, AGENTS
from app.api import attachments, cloud_conversations
from app.services import model_catalog
import uvicorn


async def main():
    control = Path(sys.argv[1]).resolve()
    fixture = HandoffTests("test_security_two_phase_real_execution_and_restart")
    await fixture.asyncSetUp()
    fixture.app.include_router(attachments.router)
    fixture.app.include_router(cloud_conversations.router)
    fixture.runner.agents = [{"key": key, "name": item["displayName"], "auth": "authed"}
                            for key, item in AGENTS.items()]
    if "--browser" in sys.argv:
        # Only this isolated test app exposes state controls. Credentials and
        # database ownership are unrelated to the running desktop or real Hub.
        from datetime import datetime, timezone
        from app import db, models
        from app.api import cloud_environments
        from app.automation_models import RunnerNode
        from app.services import runner_hub
        from fastapi import HTTPException
        fixture.app.include_router(cloud_environments.router)
        async with db.SessionLocal() as session:
            # HandoffTests.asyncSetUp already seeds the in-memory cloud runner.
            # Reuse that row instead of inserting the same primary key twice;
            # browser mode must be repeatable alongside the native fixture.
            runner_row = await session.get(RunnerNode, "cloud")
            if runner_row is None:
                runner_row = RunnerNode(id="cloud")
                session.add(runner_row)
            runner_row.client_id = ""
            runner_row.org_id = "org"
            runner_row.owner_user_id = fixture.owner.id
            runner_row.enroll_name = "隔离验收执行机"
            runner_row.host = "fixture-cloud"
            runner_row.os = "test"
            runner_row.auth_state = "active"
            runner_row.agents = fixture.runner.agents
            runner_row.work_root = fixture.runner.work_root
            runner_row.max_concurrent = 4
            runner_row.dispatch_mode = "accepting"
            runner_row.last_seen_at = datetime.now(timezone.utc)
            role = await session.get(models.Role, "fixture-cloud-manager")
            if role is None:
                session.add(models.Role(id="fixture-cloud-manager", name="Isolated cloud manager", permissions=["runner.manage"]))
            await session.commit()

        @fixture.app.post("/__fixture/state")
        async def browser_state(body: dict):
            if set(body) - {"manage", "online", "paused"} or any(type(value) is not bool for value in body.values()):
                raise HTTPException(400, "Invalid isolated fixture state")
            if "manage" in body:
                async with db.SessionLocal() as session:
                    user = await session.get(models.User, "owner")
                    user.role_id = "fixture-cloud-manager" if body["manage"] else None
                    await session.commit()
            if "online" in body:
                if body["online"]:
                    runner_hub._RUNNERS["cloud"] = fixture.runner
                else:
                    runner_hub._RUNNERS.pop("cloud", None)
            if "paused" in body:
                fixture.runner.dispatch_mode = "paused" if body["paused"] else "accepting"
            return {"ok": True}
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    base = "http://127.0.0.1:" + str(sock.getsockname()[1])
    server = uvicorn.Server(uvicorn.Config(fixture.app, log_level="error", access_log=False))
    with patch.object(model_catalog, "resolve", AsyncMock(return_value={
            "base": "http://127.0.0.1:1/v1", "key": "fixture-only", "model": "fixture-model"})):
        task = asyncio.create_task(server.serve(sockets=[sock]))
        try:
            while not server.started:
                if task.done():
                    await task
                    raise RuntimeError("Isolated Hub failed to start")
                await asyncio.sleep(.02)
            (control / "ready.json").write_text(json.dumps({"hub": base,
                "clientId": fixture.client.id, "session": fixture.token,
                "work": str(WORK)}), encoding="utf-8")
            while not (control / "stop").exists() and not task.done():
                await asyncio.sleep(.1)
        finally:
            server.should_exit = True
            await task
            await fixture.asyncTearDown()
            (control / "calls.json").write_text(json.dumps(fixture.peer.calls), encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())
