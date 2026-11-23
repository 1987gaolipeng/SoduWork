"""Exercise archive ownership and transaction failures using independent SQLite connections."""
import asyncio
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import Depends, FastAPI
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.api import plugins
from app.db import Base, get_session
from app.deps import current_user
from app.services import plugin_drafts, plugin_packages, plugin_service


class ImportRollbackTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.packages = Path(tmp.name, "packages")
        self.packages.mkdir()
        self.enterContext(patch.object(plugin_packages, "package_root", return_value=str(self.packages)))
        engine = create_async_engine("sqlite+aiosqlite:///" + str(Path(tmp.name, "test.db")))
        self.addAsyncCleanup(engine.dispose)
        self.sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.user = models.User(id="author", username="author", display_name="Author")
        self.data = plugin_drafts.build({"template": "method", "key": "business", "name": "Business",
                                        "version": "1.0.0", "description": "Summarize progress",
                                        "instructions": "Check progress and submit a report."})

    async def install(self, session, org="company"):
        return await plugin_service.install(session, self.data, self.user, org)

    def archives(self):
        return {file for file in self.packages.rglob("*") if file.is_file()}

    async def test_failed_first_import_and_retry(self):
        async with self.sessions() as session:
            with patch.object(session, "commit", AsyncMock(side_effect=RuntimeError("commit failed"))):
                with self.assertRaisesRegex(RuntimeError, "commit failed"):
                    await self.install(session)
            self.assertEqual(self.archives(), set())
            self.assertIsNone(await session.scalar(select(am.PluginVersion)))
            self.assertIsNone(await session.scalar(select(am.Plugin)))
            retry = await self.install(session)
            self.assertTrue(retry["created"])
            row = await session.get(am.PluginVersion, retry["versionId"])
            self.assertEqual(Path(row.package_path).read_bytes(), self.data)

    async def test_failure_never_unlinks_an_existing_legacy_publication(self):
        parsed = plugin_packages.parse(self.data)
        async with self.sessions() as session:
            result = await self.install(session)
            version = await session.get(am.PluginVersion, result["versionId"])
            await plugin_service.approve_version(session, version, True, "Reviewer")
            archive = Path(version.package_path)
            legacy = archive.with_name(parsed["checksum"] + ".soduwork-plugin")
            archive.rename(legacy)
            version.package_path = str(legacy)
            await session.commit()
        async with self.sessions() as session:
            with patch.object(session, "commit", AsyncMock(side_effect=RuntimeError("commit failed"))):
                with self.assertRaisesRegex(RuntimeError, "commit failed"):
                    await self.install(session, "another-company")
            self.assertEqual(self.archives(), {legacy})
            self.assertFalse((await self.install(session))["created"])
            self.assertEqual(plugin_packages.parse_file(str(legacy))["checksum"], parsed["checksum"])

    async def test_simultaneous_import_survives_another_requests_rollback(self):
        first_ready = asyncio.Event()
        second_started = asyncio.Event()

        async def losing_import():
            async with self.sessions() as session:
                async def fail_commit():
                    first_ready.set()
                    await second_started.wait()
                    raise RuntimeError("commit failed")

                with patch.object(session, "commit", fail_commit):
                    with self.assertRaisesRegex(RuntimeError, "commit failed"):
                        await self.install(session)

        async def winning_import():
            await first_ready.wait()
            async with self.sessions() as session:
                second_started.set()
                return await self.install(session)

        _, result = await asyncio.wait_for(asyncio.gather(losing_import(), winning_import()), 10)
        async with self.sessions() as session:
            version = await session.get(am.PluginVersion, result["versionId"])
            archive = Path(version.package_path)
            self.assertEqual(self.archives(), {archive})
            self.assertEqual(archive.read_bytes(), self.data)
            self.assertFalse((await self.install(session))["created"])

    async def test_lost_commit_response_preserves_new_publication(self):
        async with self.sessions() as session:
            commit = session.commit

            async def lose_response():
                await commit()
                raise RuntimeError("response lost")

            with patch.object(session, "commit", lose_response):
                with self.assertRaisesRegex(RuntimeError, "response lost"):
                    await self.install(session)
            retry = await self.install(session)
            self.assertFalse(retry["created"])
            version = await session.get(am.PluginVersion, retry["versionId"])
            self.assertEqual(Path(version.package_path).read_bytes(), self.data)

    async def test_bulk_import_retains_successful_files_and_reports_failed_files(self):
        app = FastAPI()
        app.include_router(plugins.router)

        async def database():
            async with self.sessions() as session:
                yield session

        async def admin(session=Depends(get_session)):
            user = await session.get(models.User, self.user.id)
            user._perms = {"plugin.manage"}
            return user

        async with self.sessions() as session:
            session.add(models.User(id=self.user.id, username="admin", is_super=True))
            await session.commit()

        app.dependency_overrides[get_session] = database
        app.dependency_overrides[current_user] = admin

        def fail_first_write(mapper, connection, version):
            if version.version == "2.0.0" and version.package_path:
                raise RuntimeError("archive commit failed")

        event.listen(am.PluginVersion, "before_update", fail_first_write)
        self.addCleanup(event.remove, am.PluginVersion, "before_update", fail_first_write)
        rejected = plugin_drafts.build({"template": "method", "key": "business", "name": "Business",
                                        "version": "2.0.0", "description": "Second version",
                                        "instructions": "Check progress and submit a report."})
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as http:
            response = await http.post("/api/v1/admin/plugins/bulk-import", data={"rightsConfirmed": "true"},
                                       files=[("files", ("rejected.zip", rejected)),
                                              ("files", ("accepted.zip", self.data))])
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual((body["imported"], body["failed"]), (1, 1))
        self.assertEqual(body["items"][0]["error"], "archive commit failed")
        archive, = self.archives()
        self.assertEqual(archive.read_bytes(), self.data)
