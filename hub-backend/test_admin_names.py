"""Admin name validation through the HTTP routes and independent database sessions."""
import asyncio
import tempfile
import unittest
from pathlib import Path

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import admin
from app.auth import sign_token
from app.db import Base, get_session


class AdminNameTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        engine = create_async_engine(f"sqlite+aiosqlite:///{Path(temp.name).as_posix()}/names.db")
        self.addAsyncCleanup(engine.dispose)
        self.sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as conn:
            tables = [model.__table__ for model in
                      (models.User, models.OrgUnit, models.Role, models.Integration, models.AuditLog)]
            await conn.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tables))
        async with self.sessions() as session:
            session.add(models.User(id="admin", username="admin", is_super=True))
            await session.commit()

        async def session_for_request():
            async with self.sessions() as session:
                yield session

        app = FastAPI()
        app.include_router(admin.router)
        app.dependency_overrides[get_session] = session_for_request
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test/api/v1/admin/",
                                      headers={"Authorization": "Bearer " + sign_token("admin")})
        self.addAsyncCleanup(self.http.aclose)

    async def create_org(self, name, parent=None):
        response = await self.http.post("orgs", json={"name": name, "parentId": parent})
        self.assertEqual(response.status_code, 200)
        return response.json()["id"]

    async def test_names_are_trimmed_and_bounded_on_create_and_rename(self):
        maximum = "组" * 64
        for route in ("orgs", "roles", "integrations"):
            response = await self.http.post(route, json={"name": f"\u3000{maximum}\t"})
            self.assertEqual(response.status_code, 200, route)
            self.assertEqual(response.json()["name"], maximum)
            path = f"{route}/{response.json()['id']}"
            for invalid in ("", " \t\u3000", maximum + "组"):
                self.assertEqual((await self.http.post(route, json={"name": invalid})).status_code, 422, route)
                if route != "integrations":
                    self.assertEqual((await self.http.patch(path, json={"name": invalid})).status_code, 422, route)
            if route != "integrations":
                self.assertEqual((await self.http.patch(path, json={"name": "  新名称 "})).json()["name"], "新名称")

    async def test_control_characters_cannot_be_stored_in_organization_names(self):
        org = await self.create_org("قسم الأبحاث")
        for control in ("\0", "\x1b", "\n", "\x85", "\u2028", "\u202e", "\u2067"):
            with self.subTest(control=repr(control)):
                body = {"name": f"First{control}Last"}
                self.assertEqual((await self.http.post("orgs", json=body)).status_code, 422)
                self.assertEqual((await self.http.patch(f"orgs/{org}", json=body)).status_code, 422)
        async with self.sessions() as session:
            self.assertEqual(list(await session.scalars(select(models.OrgUnit.name))), ["قسم الأبحاث"])

    async def test_rename_and_move_check_the_destination_before_writing(self):
        first = await self.create_org("One")
        second = await self.create_org("Two")
        child = await self.create_org("Team", first)
        await self.create_org("Team", second)
        for changes in ({"name": "Two", "parentId": ""}, {"parentId": second}):
            self.assertEqual((await self.http.patch(f"orgs/{child}", json=changes)).status_code, 409)
        async with self.sessions() as session:
            row = await session.get(models.OrgUnit, child)
            self.assertEqual((row.name, row.parent_id), ("Team", first))
        moved = await self.http.patch(f"orgs/{child}", json={"parentId": second, "name": " Other "})
        self.assertEqual((moved.json()["name"], moved.json()["parentId"]), ("Other", second))
        self.assertEqual((await self.http.patch(f"orgs/{child}", json={"name": "Other"})).status_code, 200)

    async def test_existing_padded_sibling_and_legacy_duplicates(self):
        async with self.sessions() as session:
            session.add(models.OrgUnit(id="legacy", name="\u3000Team\t"))
            await session.commit()
        self.assertEqual((await self.http.post("orgs", json={"name": " Team "})).status_code, 409)
        async with self.sessions() as session:
            session.add(models.OrgUnit(name="Team"))
            await session.commit()
        sorted_row = await self.http.patch("orgs/legacy", json={"sort": 3})
        self.assertEqual(sorted_row.json()["name"], "\u3000Team\t")
        renamed = await self.http.patch("orgs/legacy", json={"name": "Other"})
        self.assertEqual(renamed.json()["name"], "Other")

    async def test_concurrent_sibling_creates_commit_once(self):
        responses = await asyncio.gather(*(self.http.post("orgs", json={"name": name})
                                           for name in ("Team", " Team ")))
        self.assertEqual(sorted(response.status_code for response in responses), [200, 409])
        async with self.sessions() as session:
            self.assertEqual(list(await session.scalars(select(models.OrgUnit.name))), ["Team"])


if __name__ == "__main__":
    unittest.main()
