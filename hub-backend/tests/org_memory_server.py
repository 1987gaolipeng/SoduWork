"""Loopback-only org-memory HTTP fixture with the real API and authentication.

Run with the development Python environment. The first JSON line reports a
random local URL and a token for this disposable fixture only. No configured
Hub database, credentials, models, background jobs or real users are used.
"""
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile


async def serve(root: Path) -> None:
    # Set these before importing app.config/app.db; never inherit the real DB.
    os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + (root / "test.db").as_posix()
    os.environ["AUTH_SECRET"] = "org-memory-fixture-only-" + secrets.token_hex(32)
    os.environ["CLUSTER_REDIS_URL"] = ""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

    from fastapi import Depends, FastAPI, HTTPException
    import uvicorn
    from app import models, automation_models as am
    from app.api.memory_records import admin_router, router
    from app.auth import sign_token
    from app.db import Base, SessionLocal, engine, get_session
    from app.deps import current_user
    from app.memory_record_models import MemoryRecord
    from app.project_context_models import ProjectMemoryCapsule
    from app.services import device_auth, org_memory, task_status, tasks as task_service
    from app.services.rbac import user_to_api

    async with engine.begin() as connection:
        tables = [model.__table__ for model in (
            models.OrgUnit, models.User, models.Role, models.Client, models.AppSetting,
            models.Task, models.Milestone, models.Project, models.Repo, models.Attachment,
            models.AiSchedule, MemoryRecord, ProjectMemoryCapsule,
            am.WorkflowRun, am.ExecutionSession, am.ArtifactVersion, am.ApprovalRequest,
            am.TaskCodeTarget,
        )]
        await connection.run_sync(lambda c: Base.metadata.create_all(c, tables=tables))
    async with SessionLocal() as session:
        session.add(models.OrgUnit(id="fixture-org", name="Isolated organization"))
        session.add(models.User(id="fixture-admin", username="fixture-admin", org_id="fixture-org",
                                display_name="Fixture administrator", is_super=True, is_active=True))
        session.add_all([
            models.User(id="fixture-colleague", username="fixture-colleague", org_id="fixture-org", is_active=True),
            models.OrgUnit(id="fixture-other-org", name="Other isolated organization"),
            models.User(id="fixture-other", username="fixture-other", org_id="fixture-other-org", is_active=True),
            models.Client(id="fixture-device", user_ref="fixture-admin", auth_state="active"),
            models.Client(id="fixture-colleague-device", user_ref="fixture-colleague", auth_state="active"),
            models.Client(id="fixture-other-device", user_ref="fixture-other", auth_state="active"),
        ])
        # Exercise creation beside an archived default without reviving it.
        session.add(MemoryRecord(
            id="fixture-archived", scope="org", owner_user_id="", org_id="fixture-org",
            memory_key="default", title="Archived fixture", summary="Historical fixture content",
            fields={"summary": "Historical fixture content"}, archived=True, revision=3,
        ))
        await session.commit()
        device_token = device_auth.issue_session(await session.get(models.Client, "fixture-device"))[0]

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    token = sign_token("fixture-admin", ttl_hours=1)

    @asynccontextmanager
    async def lifespan(app):
        print(json.dumps({
            "ready": True, "fixtureOnly": True, "url": f"http://127.0.0.1:{port}",
            "token": token, "deviceToken": device_token,
            "orgId": "fixture-org", "userId": "fixture-admin",
        }), flush=True)
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.include_router(admin_router)
    app.include_router(router)

    @app.post("/_fixture/work/{action}")
    async def work(action: str, user=Depends(current_user), session=Depends(get_session)):
        """Fixture control only; the production completion/memory services are real."""
        if not user.is_super:
            raise HTTPException(403, "Fixture administrator required")
        if action in {"complete", "new"}:
            sources = ([
                ("one", "fixture-admin", "fixture-device", "fixture-org", "团队已完成：月度交付规范"),
                ("two", "fixture-colleague", "fixture-colleague-device", "fixture-org", "团队已完成：回归验收流程"),
                ("foreign", "fixture-other", "fixture-other-device", "fixture-other-org", "其他组织隔离内容"),
            ] if action == "complete" else [
                ("future", "fixture-colleague", "fixture-colleague-device", "fixture-org", "后续新完成的共享工作"),
            ])
            for key, uid, cid, oid, title in sources:
                rid = "fixture-work-" + key
                if await session.get(models.Task, rid):
                    continue
                task = models.Task(id=rid, owner_client_id=cid, title=title, status="doing", shared_org_id=oid,
                                   created_by=uid, note="Shared delivery facts and review evidence",
                                   acceptance_criteria=["Review results and evidence"])
                session.add(task)
                await session.flush()
                if not await task_status.mark(session, task, "done", why="isolated fixture completion"):
                    raise HTTPException(500, "Fixture completion did not pass its actual lifecycle gate")
            await session.commit()
        elif action == "withdraw":
            item = await session.get(models.Task, "fixture-work-one")
            if item and item.status == "done":
                await task_service.update_task(session, "fixture-device", item.id, {"status": "todo", "triageStage": "clarifying"})
        else:
            raise HTTPException(404, "Unknown isolated fixture action")
        value = await org_memory.for_client(session, await session.get(models.Client, "fixture-device"))
        await session.commit()
        return {"fixtureOnly": True, **value}

    @app.get("/healthz")
    async def health():
        return {"ok": True, "fixtureOnly": True}

    @app.get("/api/v1/admin/me")
    async def me(user=Depends(current_user)):
        return {**user_to_api(user), "permissions": sorted(user._perms)}

    @app.get("/api/v1/admin/orgs")
    async def orgs(user=Depends(current_user)):
        return {"ok": True, "items": [{"id": user.org_id, "name": "Isolated organization", "parentId": None}]}

    try:
        await uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")).serve(sockets=[sock])
    finally:
        sock.close()
        await engine.dispose()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="soduwork-org-memory-fixture-") as directory:
        asyncio.run(serve(Path(directory)))
