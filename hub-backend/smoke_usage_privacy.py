"""Usage API organization-isolation regression using only an in-memory database and synthetic
identities.
"""
import asyncio
import os
from datetime import datetime, timezone

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["AUTH_SECRET"] = "usage-privacy-fixture-signing-key-for-isolated-tests"
os.environ["ADMIN_PASS"] = "usage-privacy-fixture-admin-password"

import httpx
from fastapi import FastAPI

from app import automation_models as am, models
from app.api.usage import router
from app.auth import sign_token
from app.db import Base, SessionLocal, engine


async def main():
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    now = datetime.now(timezone.utc)
    async with SessionLocal() as session:
        session.add_all([
            models.OrgUnit(id="org-a", name="A"),
            models.OrgUnit(id="org-child", name="A child", parent_id="org-a"),
            models.OrgUnit(id="org-b", name="B"),
            models.Role(id="reader", name="Reader", permissions=["client.view", "task.view"]),
            models.User(id="leader", username="leader", org_id="org-a", role_id="reader"),
            models.User(id="child", username="child", org_id="org-child"),
            models.User(id="foreign", username="foreign", org_id="org-b", role_id="reader"),
            models.User(id="empty", username="empty", role_id="reader"),
            models.User(id="denied", username="denied", org_id="org-a"),
            models.User(id="super", username="super", is_super=True),
            models.Client(id="client-a", name="A device", user_ref="leader"),
            models.Client(id="client-child", name="Child device", user_ref="child"),
            models.Client(id="client-b", name="Foreign device", user_ref="foreign"),
            models.Task(id="task-a", title="A", owner_client_id="client-a"),
            models.Task(id="task-child", title="Child", owner_client_id="client-child"),
            models.Task(id="task-b", title="Foreign", owner_client_id="client-b"),
            am.RunnerNode(id="runner-a", client_id="client-a", host="A-host", org_id="org-a"),
            am.RunnerNode(id="runner-b", client_id="client-b", host="Foreign-host", org_id="org-b"),
            am.RunnerNode(id="shared-child", client_id="", org_id="org-child", host="Child-host"),
            am.RunnerNode(id="personal-a", client_id="", org_id="org-a", owner_user_id="leader"),
        ])
        for ref, runner, task, tokens in [
            ("a", "runner-a", "task-a", 10),
            ("foreign-on-a", "runner-a", "task-b", 900),
            ("b", "runner-b", "task-b", 800),
            ("child", "shared-child", "task-child", 20),
            ("local-a", "backend-local", "task-a", 30),
            ("local-b", "backend-local", "task-b", 700),
            ("personal", "personal-a", "task-a", 40),
        ]:
            session.add(am.ExecutionSession(
                ref=ref, runner_id=runner, task_id=task, host=runner + "-host",
                state="done", started_at=now, metadata_={"usage": {"total": tokens}}))
        await session.commit()

    app = FastAPI()
    app.include_router(router)
    checks = 0
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        async def get(path, uid=None):
            return await client.get(path, headers={"Authorization": "Bearer " + sign_token(uid)} if uid else {})

        runners = "/api/v1/admin/usage/runners"
        detail = "/api/v1/admin/usage/tasks/"
        for path in [runners, detail + "task-a"]:
            assert (await get(path)).status_code == 401
            assert (await get(path, "denied")).status_code == 403
            checks += 2
        response = await get(detail + "task-b", "leader")
        assert response.status_code in {403, 404}, "跨部门任务明细不得返回会话或主机"
        checks += 1
        assert (await get(detail + "task-child", "leader")).status_code == 200
        assert (await get(detail + "missing", "super")).status_code == 404
        checks += 2
        response = await get(runners, "leader")
        assert response.status_code == 200
        rows = {row["runnerId"]: row for row in response.json()["runners"]}
        assert set(rows) == {"runner-a", "shared-child", "personal-a", "backend-local"}, rows.keys()
        assert rows["runner-a"]["usage"]["total"] == 10, "共享节点不得混入其他部门任务用量"
        assert rows["backend-local"]["usage"]["total"] == 30, "后端本机也必须按任务隔离"
        assert "Foreign" not in response.text
        checks += 5
        rows = {row["runnerId"]: row for row in (await get(runners, "foreign")).json()["runners"]}
        assert set(rows) == {"runner-b", "backend-local"}, "任务可见不能扩大到其他部门执行节点"
        assert rows["backend-local"]["usage"]["total"] == 700
        checks += 2
        assert (await get(runners, "empty")).json()["runners"] == []
        assert (await get(detail + "task-a", "empty")).status_code in {403, 404}
        checks += 2
        rows = {row["runnerId"]: row for row in (await get(runners, "super")).json()["runners"]}
        assert rows["runner-a"]["usage"]["total"] == 910
        assert rows["backend-local"]["usage"]["total"] == 730
        assert "runner-b" in rows
        assert (await get(detail + "task-b", "super")).status_code == 200
        checks += 4
    await engine.dispose()
    print(f"smoke_usage_privacy: {checks} assertions passed")


if __name__ == "__main__":
    asyncio.run(main())
