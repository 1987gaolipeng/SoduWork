"""Stage update discovery uses real signed artifacts and an isolated database."""
import base64
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import AsyncMock, patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import Depends, FastAPI, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import client_updates as api
from app.db import Base, get_session
from app.deps import current_client
from app.models import Client, ClientRelease, ClientUpdateAttempt, User


class BetaUpdateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="soduwork-beta-update-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        key = Ed25519PrivateKey.generate()
        self.private = base64.b64encode(key.private_bytes(
            serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
            serialization.NoEncryption())).decode()
        self.public = base64.b64encode(key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
        for mock in (patch.object(api.contract, "release_root", return_value=self.root),
                     patch.object(api.contract, "trusted_public_keys", return_value={"beta-test": self.public}),
                     patch.dict(os.environ, {"SODUWORK_PUBLIC_DOWNLOAD_CHANNEL": "beta"})):
            mock.start()
            self.addCleanup(mock.stop)
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda conn: Base.metadata.create_all(conn, tables=[
                Client.__table__, ClientRelease.__table__, ClientUpdateAttempt.__table__]))
        async with self.sessions() as session:
            session.add(Client(id="beta-device", name="isolated", platform="win32",
                               app_version="1.13.11-beta.532"))
            await session.commit()
        self.previous = await self.release("1.13.11-beta.532")
        self.latest = await self.release("1.13.11-beta.533")
        self.historical = await self.release("1.13.11")
        app = FastAPI()
        app.include_router(api.router)

        async def session_override():
            async with self.sessions() as session:
                yield session

        async def device_override(session=Depends(get_session)):
            return await session.get(Client, "beta-device")

        app.dependency_overrides[get_session] = session_override
        app.dependency_overrides[current_client] = device_override
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def release(self, version, *, channel="beta", arch="x64", enabled=True, trusted=True):
        release_id = str(uuid.uuid4())
        data = (version.encode() + b" signed fixture\n") * 100
        artifact = self.root / release_id
        artifact.write_bytes(data)
        row = ClientRelease(id=release_id, version=version, channel=channel,
            platform="win32", arch=arch, enabled=enabled,
            artifact_name=f"SoduWork-{version}-Setup.exe", artifact_path=release_id,
            artifact_size=len(data), sha256=hashlib.sha256(data).hexdigest(),
            signature="", key_id="beta-test", min_version="1.13.11-beta.532")
        async with self.sessions() as session:
            session.add(row)
            await session.flush()
            row.signature = api.contract.sign(api.contract.manifest_payload(row), self.private)
            if not trusted:
                row.signature = base64.b64encode(bytes(64)).decode()
            await session.commit()
        return row

    async def check(self, current="1.13.11-beta.532", channel="stable"):
        response = await self.http.get("/api/v1/client-updates/check", params={
            "current": current, "channel": channel, "platform": "win32", "arch": "x64"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def pending(self, release):
        async with self.sessions() as session:
            session.add(ClientUpdateAttempt(id=str(uuid.uuid4()), client_id="beta-device",
                release_id=release.id, current_version="1.13.11-beta.532",
                target_version=release.version, requested_by="auto", state="downloaded", progress=100))
            await session.commit()

    async def test_legacy_stage_request_discovers_signed_beta_and_downloads_exact_bytes(self):
        result = await self.check()
        self.assertTrue(result["hasUpdate"])
        self.assertFalse(result["manualInstallRequired"])
        manifest = result["manifest"]
        self.assertEqual(manifest["releaseId"], self.latest.id)
        self.assertEqual(manifest["channel"], "beta")
        payload = {key: value for key, value in manifest.items() if key != "signature"}
        self.assertTrue(api.contract.verify(payload, manifest["signature"], self.public))
        downloaded = await self.http.get(manifest["artifact"]["url"])
        self.assertEqual(downloaded.status_code, 200)
        self.assertEqual(hashlib.sha256(downloaded.content).hexdigest(), self.latest.sha256)

    async def test_explicit_beta_request_selects_same_release(self):
        self.assertEqual((await self.check(channel="beta"))["manifest"]["releaseId"], self.latest.id)

    async def test_production_stable_request_never_enters_beta(self):
        with patch.dict(os.environ, {"SODUWORK_PUBLIC_DOWNLOAD_CHANNEL": "stable"}):
            self.assertFalse((await self.check())["hasUpdate"])
            stable = await self.release("1.13.12", channel="stable")
            self.assertEqual((await self.check())["manifest"]["releaseId"], stable.id)

    async def test_stable_client_on_stage_is_not_silently_switched_to_beta(self):
        self.assertFalse((await self.check(current="1.13.10"))["hasUpdate"])

    async def test_current_beta_never_falls_through_to_unsuffixed_history(self):
        for channel in ("stable", "beta"):
            self.assertFalse((await self.check("1.13.11-beta.533", channel))["hasUpdate"])
            self.assertFalse((await self.check("1.13.11-beta.534", channel))["hasUpdate"])

    async def test_historical_pending_attempt_cannot_override_beta_selection(self):
        await self.pending(self.historical)
        self.assertEqual((await self.check())["manifest"]["releaseId"], self.latest.id)

    async def test_historical_pending_attempt_does_not_offer_update_to_latest_beta(self):
        await self.pending(self.historical)
        self.assertFalse((await self.check("1.13.11-beta.533"))["hasUpdate"])

    async def test_pre_identity_versions_discover_beta_but_require_manual_installation(self):
        for current in ("1.13.11-beta.3", "1.13.11-beta.531"):
            result = await self.check(current)
            self.assertTrue(result["hasUpdate"])
            self.assertTrue(result["manualInstallRequired"])
            self.assertEqual(result["manifest"]["minVersion"], "1.13.11-beta.532")

    async def test_beta_numbers_order_numerically(self):
        await self.release("1.14.0-beta.9")
        newest = await self.release("1.14.0-beta.10")
        self.assertEqual((await self.check())["manifest"]["releaseId"], newest.id)

    async def test_untrusted_disabled_and_other_arch_candidates_are_excluded(self):
        await self.release("1.13.11-beta.534", trusted=False)
        await self.release("1.13.11-beta.535", enabled=False)
        await self.release("1.13.11-beta.536", arch="arm64")
        self.assertEqual((await self.check())["manifest"]["releaseId"], self.latest.id)

    async def test_admin_default_uses_stage_beta_and_explicit_history_is_rejected(self):
        user = User(id="admin", username="fixture", is_super=True)
        with patch.object(api.audit, "log", new_callable=AsyncMock):
            async with self.sessions() as session:
                with self.assertRaises(HTTPException) as rejected:
                    await api.request_client_update("beta-device", {"releaseId": self.historical.id}, user, session)
                self.assertEqual(rejected.exception.status_code, 409)
                result = await api.request_client_update("beta-device", {}, user, session)
                self.assertEqual(result["release"]["id"], self.latest.id)
                attempts = (await session.execute(select(ClientUpdateAttempt))).scalars().all()
                self.assertEqual([row.release_id for row in attempts], [self.latest.id])


if __name__ == "__main__":
    unittest.main()
