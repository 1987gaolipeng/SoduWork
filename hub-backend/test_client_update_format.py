"""Release regression: format selection follows the running installation."""
import os
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import client_updates as api
from app.db import Base, get_session
from app.deps import current_client
from app.models import Client, ClientRelease, ClientUpdateAttempt


class FormatSelectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="soduwork-update-format-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        patch_root = patch.object(api.contract, "release_root", return_value=root)
        patch_root.start()
        self.addCleanup(patch_root.stop)
        artifact = b"format-fixture\n" * 100000
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=[
                Client.__table__, ClientRelease.__table__, ClientUpdateAttempt.__table__]))
        async with self.sessions() as session:
            session.add(Client(id="test-device", name="isolated", app_version="1.13.1"))
            for fmt in ("deb", "rpm", "tar.gz"):
                (root / fmt).write_bytes(artifact)
                session.add(ClientRelease(id=fmt, version="1.13.2", channel="stable",
                    platform="linux", arch="x64", enabled=True,
                    artifact_name=f"SoduWork-1.13.2-linux.{fmt}", artifact_size=len(artifact),
                    artifact_path=fmt, sha256=hashlib.sha256(artifact).hexdigest(), signature="fixture", key_id="test-key"))
            await session.commit()
        app = FastAPI()
        app.include_router(api.router)

        async def session_override():
            async with self.sessions() as session:
                yield session

        async def client_override():
            return Client(id="test-device", name="isolated", app_version="1.13.1")

        app.dependency_overrides[get_session] = session_override
        app.dependency_overrides[current_client] = client_override
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        # Other contract tests cover Ed25519; keep this regression about selection.
        self.trust = patch.object(api.contract, "assert_trusted_release")
        self.trust.start()

    async def asyncTearDown(self):
        self.trust.stop()
        await self.http.aclose()
        await self.engine.dispose()

    async def check(self, fmt=None, **params):
        values = dict(current="1.13.1", platform="linux", arch="x64", **params)
        if fmt is not None:
            values["format"] = fmt
        return await self.http.get("/api/v1/client-updates/check", params=values)

    async def test_each_format_selects_its_own_artifact_even_with_other_pending_attempt(self):
        for fmt in ("deb", "rpm", "tar.gz"):
            response = await self.check(fmt)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["manifest"]["releaseId"], fmt)

    async def test_missing_format_never_falls_back_to_another_package(self):
        response = await self.check("appimage")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["hasUpdate"])

    async def test_supported_client_without_format_keeps_previous_preference(self):
        response = await self.check()
        self.assertEqual(response.json()["manifest"]["releaseId"], "deb")

    async def test_invalid_format_rejected(self):
        for fmt in ("exe", "../rpm", "zip"):
            self.assertEqual((await self.check(fmt)).status_code, 400)
        response = await self.http.get("/api/v1/client-updates/check",
            params=dict(current="1.13.1", platform="win32", format="rpm"))
        self.assertEqual(response.status_code, 400)

    async def test_wrong_target_attempt_is_not_marked_installed(self):
        await self.check("deb")
        response = await self.http.get("/api/v1/client-updates/check",
            params=dict(current="1.13.2", platform="linux", format="rpm"))
        self.assertFalse(response.json()["hasUpdate"])
        from sqlalchemy import select
        async with self.sessions() as session:
            rows = (await session.execute(select(ClientUpdateAttempt))).scalars().all()
            self.assertEqual([row.state for row in rows], ["available"])


if __name__ == "__main__":
    unittest.main()
