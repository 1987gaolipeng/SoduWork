"""Exercise concurrent HTTP catalog writes on independent file-backed database connections."""
import asyncio
import importlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import Depends, FastAPI
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.api import admin, config, environments, tasks
from app.auth import sign_token
from app.db import Base, get_session
from app.deps import current_client


class CatalogWriteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        for f in (Path(__file__).parent / "app").glob("*models.py"):
            importlib.import_module("app." + f.stem)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.engine = create_async_engine("sqlite+aiosqlite:///" + (Path(self.temp.name) / "db").as_posix())
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with self.sessions.begin() as session:
            session.add_all([models.User(id="owner", username="test-owner", is_super=True, is_active=True, auth_version=1),
                             models.Client(id="device", user_ref="owner", auth_state="active"),
                             models.Project(id="p", name="First"), models.Project(id="q", name="Second"),
                             models.Repo(id="visible", name="Repo A", project_id="p"),
                             models.Repo(id="outside", name="Repo B", project_id="q"),
                             models.Task(id="task", title="Plan", project_id="p", owner_client_id="device",
                                         owner_user_id="owner")])

        async def db():
            async with self.sessions() as session:
                yield session

        async def device(session=Depends(get_session)):
            return await session.get(models.Client, "device")

        app = FastAPI()
        for router in (admin.router, environments.router, tasks.router, config.router):
            app.include_router(router)
        app.dependency_overrides.update({get_session: db, current_client: device})
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://isolated",
                                      headers={"Authorization": "Bearer " + sign_token("owner", 1)})
        self.addAsyncCleanup(self.http.aclose)

    async def test_duplicate_writes_have_one_winner(self):
        cases = [
            ("environments", {"name": "Release", "key": "release"}, am.Environment, am.Environment.key),
            ("roles", {"name": "Release"}, models.Role, models.Role.name),
            ("domains", {"name": "Release"}, models.Domain, models.Domain.name),
            ("integrations", {"name": "Release", "type": "generic"}, models.Integration, models.Integration.name),
            ("projects", {"name": "Release", "ownerUserId": "owner"}, models.Project, models.Project.name),
        ]
        for path, payload, table, column in cases:
            with self.subTest(path=path):
                responses = await asyncio.gather(*(self.http.post("/api/v1/admin/" + path, json=payload)
                                                   for _ in range(4)))
                self.assertEqual(sorted(r.status_code for r in responses), [200, 409, 409, 409])
                async with self.sessions() as session:
                    count = await session.scalar(select(func.count()).select_from(table).where(
                        column == (payload.get("key") or payload["name"])))
                    self.assertEqual(count, 1)

    async def test_invalid_milestone_list_preserves_plan_until_explicit_clear(self):
        route = "/api/v1/tasks/task/milestones"
        response = await self.http.put(route, json={"items": [{"title": "Keep"}, {"title": ""}]})
        self.assertEqual(response.status_code, 200)
        saved = response.json()["items"]
        self.assertEqual([item["title"] for item in saved], ["Keep"])
        for items in (["Keep"], [{"title": "Changed"}, None], [{"title": ""}, {"title": "  "}]):
            with self.subTest(items=items):
                self.assertEqual((await self.http.put(route, json={"items": items})).status_code, 400)
                self.assertEqual((await self.http.get(route)).json()["items"], saved)
        cleared = await self.http.put(route, json={"items": []})
        self.assertEqual(cleared.status_code, 200)
        self.assertEqual((await self.http.get(route)).json()["items"], [])

    async def test_milestone_edits_validate_every_reference_before_replacing_the_plan(self):
        route = "/api/v1/tasks/task/milestones"
        good = {"title": "First", "repoId": "visible", "agentId": "worker", "agentType": "agent", "model": "chat"}
        roster = {"agents": [{"id": "worker"}], "squads": [], "defaultModel": "chat", "models": []}
        with patch.object(tasks, "list_ai_agents", AsyncMock(return_value=roster)):
            accepted = await self.http.put(route, json={"items": [good]})
            self.assertEqual(accepted.status_code, 200, accepted.text)
            saved = accepted.json()["items"]
            for key, val, status in (("repoId", "missing", 404), ("repoId", "outside", 404),
                                     ("agentType", "unknown", 422), ("agentType", "squad", 422),
                                     ("agentId", "missing", 422), ("model", "missing", 422)):
                with self.subTest(key=key, value=val):
                    denied = await self.http.put(route, json={"items": [{"title": "Changed"}, {**good, key: val}]})
                    self.assertEqual(denied.status_code, status, denied.text)
                    self.assertEqual((await self.http.get(route)).json()["items"], saved)

    async def test_config_rejects_unknown_bad_types_and_stale_or_missing_revisions(self):
        route = "/api/v1/config"
        for payload in ({"unknown": 1}, {"automationConversationV1": 99}, {"automationConversationV1": True},
                        {"petVisible": "false"}, {"locale": "unknown"}, {"fontScale": "gigantic"},
                        {"remind": "unexpected"}, {"shortcutBindings": {"send": []}}):
            self.assertEqual((await self.http.put(route, json=payload)).status_code, 422)
        options = (await self.http.get(route, params={"withRevision": "true"})).json()
        self.assertNotIn("unknown", options)
        revision = options["_configRevision"]
        peer = models.Client(id="other-device", user_ref="owner", config={})
        peer_version = (await config.get_config(peer, withRevision=True))["_configRevision"]
        wrong_device = await self.http.put(route, json={"theme": "gray", "_configRevision": peer_version})
        self.assertEqual(wrong_device.status_code, 409)

        writes = await asyncio.gather(*(self.http.put(route, json={"theme": label, "_configRevision": revision})
                                        for label in ("blue", "green")))
        self.assertEqual(sorted(r.status_code for r in writes), [200, 409])
        self.assertEqual((await self.http.put(route, json={"theme": "orange"})).status_code, 428)
        stored = (await self.http.get(route)).json()
        self.assertIn(stored["theme"], ["blue", "green"])
        self.assertNotIn("_configRevision", stored)
