"""Verify repository and deployment-target lifetimes through independent HTTP sessions."""
import asyncio
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi import FastAPI
import httpx
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.api import admin_projects, environments
from app.auth import sign_token
from app.db import Base, get_session
from app.services import repository_catalog


class RepositoryTargetIntegrityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        url = os.environ.get("REPO_TARGET_TEST_POSTGRES_URL")
        if url:
            schema = "repo_target_" + uuid4().hex
            control = create_async_engine(url)
            self.addAsyncCleanup(control.dispose)
            async with control.begin() as conn:
                await conn.execute(text(f'CREATE SCHEMA "{schema}"'))

            async def drop_schema():
                async with control.begin() as conn:
                    await conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))

            self.addAsyncCleanup(drop_schema)
            engine = create_async_engine(url, connect_args={"server_settings": {"search_path": schema}})
        else:
            engine = create_async_engine(f"sqlite+aiosqlite:///{Path(temp.name) / 'hub.db'}")
        self.addAsyncCleanup(engine.dispose)
        self.sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as conn:
            tables = [model.__table__ for model in (
                models.OrgUnit, models.Role, models.User, models.Repo, models.AuditLog,
                am.Environment, am.DeploymentTarget)]
            await conn.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tables))
        async with self.sessions() as session:
            session.add_all([
                models.User(id="admin", username="admin", is_super=True),
                models.Repo(id="source", project_id="project", name="Source"),
                models.Repo(id="destination", project_id="project", name="Destination"),
                am.Environment(id="env", key="test", name="Test"),
                am.DeploymentTarget(id="existing", repo_id="source", environment_id="env", name="Existing",
                                    config={"argv": ["deploy"]}),
                am.DeploymentTarget(id="legacy", repo_id="missing", environment_id="env", name="Legacy orphan"),
            ])
            await session.commit()

        async def db():
            async with self.sessions() as session:
                yield session

        app = FastAPI()
        app.include_router(admin_projects.router, prefix="/api/v1/admin")
        app.include_router(environments.router)
        app.dependency_overrides[get_session] = db
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture/api/v1/admin/",
                                      headers={"Authorization": "Bearer " + sign_token("admin")})
        self.addAsyncCleanup(self.http.aclose)

    async def test_referenced_repo_is_preserved_and_unreferenced_delete_is_idempotent(self):
        self.assertEqual((await self.http.delete("repos/source")).status_code, 409)
        for _ in range(2):
            self.assertEqual((await self.http.delete("repos/destination")).status_code, 200)
        async with self.sessions() as session:
            self.assertIsNotNone(await session.get(models.Repo, "source"))
            self.assertIsNone(await session.get(models.Repo, "destination"))
            self.assertEqual((await session.get(am.DeploymentTarget, "legacy")).repo_id, "missing")

    async def race(self, *, rebind, delete_first):
        async def target_write():
            if rebind:
                return await self.http.patch("deployment-targets/existing", json={"repoId": "destination"})
            return await self.http.post("deployment-targets", json={
                "repoId": "destination", "environmentId": "env", "config": {"argv": ["deploy"]}})

        # Hold the first request immediately after the database grants its real lock.
        # Let the second request pass its route-level reads before it competes for that lock.
        first_locked, second_entered, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        lock = repository_catalog.lock_deployment_repository

        async def observed_lock(session, rid):
            if first_locked.is_set():
                second_entered.set()
                return await lock(session, rid)
            repo = await lock(session, rid)
            first_locked.set()
            await release.wait()
            return repo

        async def remove():
            return await self.http.delete("repos/destination")

        first, second = (remove, target_write) if delete_first else (target_write, remove)
        with patch.object(repository_catalog, "lock_deployment_repository", observed_lock):
            leader = asyncio.create_task(first())
            try:
                await asyncio.wait_for(first_locked.wait(), 5)
                follower = asyncio.create_task(second())
                await asyncio.wait_for(second_entered.wait(), 5)
                done, _ = await asyncio.wait({follower}, timeout=0.15)
                self.assertFalse(done, "the competing request must wait until the first transaction finishes")
            finally:
                release.set()
            a, b = await asyncio.wait_for(asyncio.gather(leader, follower), 10)
        self.assertEqual(a.status_code, 200, a.text)
        if delete_first:
            self.assertEqual(b.status_code, 422, b.text)
            self.assertIn("代码仓库不存在", b.json()["detail"])
        else:
            self.assertEqual(b.status_code, 409, b.text)
        async with self.sessions() as session:
            target_repos = list(await session.scalars(select(am.DeploymentTarget.repo_id)))
            self.assertEqual(target_repos.count("missing"), 1)
            self.assertEqual(target_repos.count("destination"), 0 if delete_first else 1)
            self.assertEqual(await session.get(models.Repo, "destination") is None, delete_first)
            if rebind:
                self.assertEqual((await session.get(am.DeploymentTarget, "existing")).repo_id,
                                 "source" if delete_first else "destination")

    async def test_create_precedes_delete(self):
        await self.race(rebind=False, delete_first=False)

    async def test_delete_precedes_create(self):
        await self.race(rebind=False, delete_first=True)

    async def test_rebind_precedes_delete(self):
        await self.race(rebind=True, delete_first=False)

    async def test_delete_precedes_rebind(self):
        await self.race(rebind=True, delete_first=True)
