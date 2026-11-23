"""Team task request types through authenticated, isolated device HTTP."""
import importlib
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import clients
from app.db import Base, get_session
from app.services import device_auth

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


OWN_ORG = "11111111-1111-4111-8111-111111111111"
CHILD_ORG = "22222222-2222-4222-8222-222222222222"
INBOX = {"toInbox": True}
ASSIGNMENT = {"assigneeUserId": "team-input-member"}


class TeamTaskInputValidationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add_all([
                models.OrgUnit(id=OWN_ORG, name="Own organization"),
                models.OrgUnit(id=CHILD_ORG, name="Child organization", parent_id=OWN_ORG),
                models.Role(id="team-input-manager-role", name="Manager", permissions=["task.dispatch"]),
                models.User(id="team-input-manager", username="team-input-manager", org_id=OWN_ORG,
                            role_id="team-input-manager-role", is_active=True, auth_version=1),
                models.User(id="team-input-member", username="team-input-member", org_id=OWN_ORG,
                            is_active=True, auth_version=1),
                models.Client(id="manager-input-device", user_ref="team-input-manager", auth_state="active"),
                models.Client(id="member-input-device", user_ref="team-input-member", auth_state="active"),
            ])
            await session.commit()
            self.headers = {}
            for who, device_id in (("manager", "manager-input-device"), ("member", "member-input-device")):
                device = await session.get(models.Client, device_id)
                self.headers[who] = {"Authorization": "Device " + device_auth.issue_session(device)[0]}
        app = FastAPI()
        app.include_router(clients.router)

        async def db():
            async with self.sessions() as session:
                yield session

        app.dependency_overrides[get_session] = db
        self.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://isolated",
        )
        publisher = patch("app.realtime.hub.publish", new_callable=AsyncMock)
        self.publish = publisher.start()
        self.addCleanup(publisher.stop)

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def request(self, body, *, who="manager"):
        return await self.http.post("/api/v1/team/tasks", json=body,
                                    headers=self.headers[who] if who else {})

    async def assert_no_task_writes(self):
        async with self.sessions() as session:
            for model in (models.Task, models.TaskEvent, models.MateMessage, models.TaskNotificationOutbox):
                with self.subTest(table=model.__tablename__):
                    self.assertEqual(await session.scalar(select(func.count()).select_from(model)), 0)
        self.publish.assert_not_awaited()

    async def test_non_string_titles_return_400_before_inbox_or_assignment_writes(self):
        for route in (INBOX, ASSIGNMENT):
            for value in ({}, {"value": "title"}, [], ["title"], 0, 1, 1.5, True, False):
                with self.subTest(route=route, value=value):
                    response = await self.request({**route, "title": value})
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertIn("title", response.json()["detail"])
        await self.assert_no_task_writes()

    async def test_invalid_team_org_id_types_and_lengths_return_400_without_writes(self):
        invalid = [{}, {"value": OWN_ORG}, [], [OWN_ORG], 0, 1, 1.5, True, False, "x" * 37]
        for value in invalid:
            with self.subTest(value=value):
                response = await self.request({**INBOX, "title": "Synthetic task", "teamOrgId": value})
                self.assertEqual(response.status_code, 400, response.text)
                self.assertIn("teamOrgId", response.json()["detail"])
        await self.assert_no_task_writes()

    async def test_missing_null_and_blank_titles_keep_existing_required_error(self):
        for route in (INBOX, ASSIGNMENT):
            for extra in ({}, {"title": None}, {"title": ""}, {"title": " \t\n "}):
                response = await self.request({**route, **extra})
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(response.json()["detail"], "请填需求标题")
        await self.assert_no_task_writes()

    async def test_inbox_creation_keeps_own_child_and_default_organization(self):
        cases = [({}, OWN_ORG), ({"teamOrgId": None}, OWN_ORG), ({"teamOrgId": ""}, OWN_ORG),
                 ({"teamOrgId": OWN_ORG}, OWN_ORG), ({"teamOrgId": CHILD_ORG}, CHILD_ORG)]
        for index, (extra, expected_org) in enumerate(cases):
            title = f"Synthetic inbox task {index}"
            response = await self.request({**INBOX, **extra, "title": f"  {title}\t"})
            self.assertEqual(response.status_code, 200, response.text)
            result = response.json()
            self.assertTrue(result["ok"])
            self.assertEqual(result["created"], 1)
            self.assertTrue(result["toInbox"])
            self.assertEqual(result["tasks"][0]["title"], title)
            async with self.sessions() as session:
                task = await session.get(models.Task, result["tasks"][0]["id"])
                self.assertEqual((task.title, task.pool_org_id, task.owner_client_id, task.created_by),
                                 (title, expected_org, None, "team-input-manager"))
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.Task)), len(cases))
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.TaskEvent)), len(cases))

    async def test_normal_member_assignment_persists_trimmed_title_and_notifications(self):
        for route in (ASSIGNMENT, {"assigneeUserIds": ["team-input-member"]}):
            response = await self.request({**route, "title": "  Synthetic assigned task \n"})
            self.assertEqual(response.status_code, 200, response.text)
            result = response.json()
            self.assertTrue(result["ok"])
            self.assertEqual((result["created"], result["assignees"], result["skipped"]), (1, 1, []))
            async with self.sessions() as session:
                task = await session.get(models.Task, result["tasks"][0]["id"])
                self.assertEqual((task.title, task.assignee_user_id, task.owner_client_id, task.created_by),
                                 ("Synthetic assigned task", "team-input-member", "member-input-device",
                                  "team-input-manager"))
                self.assertIsNone(task.pool_org_id)
                events = list((await session.scalars(select(models.TaskEvent).where(
                    models.TaskEvent.task_id == task.id, models.TaskEvent.kind == "created"))).all())
                self.assertEqual(len(events), 1)
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.Task)), 2)
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.MateMessage)), 2)
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.TaskNotificationOutbox)), 2)

    async def test_authentication_and_management_permission_precede_type_validation(self):
        for route in (INBOX, ASSIGNMENT):
            for extra in ({"title": {}}, {"title": "Synthetic task", "teamOrgId": []}):
                for who, expected in ((None, 401), ("member", 400)):
                    response = await self.request({**route, **extra}, who=who)
                    self.assertEqual(response.status_code, expected, response.text)
                    if who:
                        self.assertEqual(response.json()["detail"], "无团队管理权限")
        await self.assert_no_task_writes()


if __name__ == "__main__":
    unittest.main()
