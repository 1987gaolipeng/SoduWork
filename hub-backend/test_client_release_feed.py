"""Isolated HTTP, signed-artifact and authorization coverage for the stable feed."""
import base64
import hashlib
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import client_release_feed as feed, client_updates, download
from app.config import get_settings
from app.db import Base, get_session
from app.models import ClientRelease
from app.services import client_updates as contract


class ReleaseFeedTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda conn: Base.metadata.create_all(
                conn, tables=[ClientRelease.__table__]))
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        key = Ed25519PrivateKey.generate()
        self.private = base64.b64encode(key.private_bytes_raw()).decode()
        public = base64.b64encode(key.public_key().public_bytes_raw()).decode()
        for patcher in (
            patch.object(get_settings(), "client_release_read_token", "fixture-feed-token"),
            patch.object(get_settings(), "hub_public_url", "https://fixture.invalid"),
            patch.object(contract, "release_root", return_value=self.root),
            patch.object(contract, "trusted_public_keys", return_value={"feed-test": public}),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.app = FastAPI()
        self.app.include_router(feed.router)
        self.app.include_router(download.router)
        self.app.include_router(client_updates.admin_router)

        async def session_dependency():
            async with self.sessions() as session:
                yield session

        self.app.dependency_overrides[get_session] = session_dependency
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),
                                     base_url="https://fixture.invalid")
        self.addAsyncCleanup(self.http.aclose)
        self.headers = {"Authorization": "Bearer fixture-feed-token"}

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def add_release(self, identity, version="1.2.3", *, fmt="exe",
                          platform="win32", arch="x64", enabled=True,
                          channel="stable", broken=""):
        name = f"SoduWork-{version}-{platform}-{arch}.{fmt}"
        data = f"installer-{identity}".encode()
        row = ClientRelease(
            id=identity, version=version, platform=platform, arch=arch,
            channel=channel, artifact_name=name, artifact_path=f"{identity}/{name}",
            artifact_size=len(data), sha256=hashlib.sha256(data).hexdigest(),
            signature="", key_id="feed-test", notes="## 改进\n- 测试说明",
            mandatory=False, min_version="", enabled=enabled, created_by="fixture",
            created_at=datetime(2026, 10, 23, 8, tzinfo=timezone.utc))
        row.signature = contract.sign(contract.manifest_payload(row), self.private)
        if broken == "signature":
            row.signature = "invalid"
        path = self.root / row.artifact_path
        if broken != "missing":
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"corrupt" if broken == "integrity" else data)
        async with self.sessions() as session:
            session.add(row)
            await session.commit()
        return row

    async def get_feed(self):
        response = await self.http.get("/api/v1/client-releases", headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        return response

    async def test_authentication_is_header_only_and_disabled_without_configuration(self):
        for authorization in (None, "Basic fixture-feed-token", "Bearer wrong", "Bearer 中文", "Bearer "):
            headers = {} if authorization is None else {
                "Authorization": authorization.encode("utf-8")}
            response = await self.http.get(
                "/api/v1/client-releases?token=fixture-feed-token", headers=headers)
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.headers["www-authenticate"], "Bearer")
        with patch.object(get_settings(), "client_release_read_token", ""):
            response = await self.http.get("/api/v1/client-releases", headers=self.headers)
            self.assertEqual(response.status_code, 503)

    async def test_history_fields_download_and_no_database_writes(self):
        await self.add_release("old", "1.2.2", enabled=False)
        row = await self.add_release("new")
        await self.add_release("beta", "9.0.0", channel="beta")
        statements = []
        event.listen(self.engine.sync_engine, "before_cursor_execute",
                     lambda conn, cursor, statement, params, ctx, many: statements.append(statement))
        response = await self.get_feed()
        body = response.json()
        self.assertEqual(response.headers["content-type"], "application/json; charset=utf-8")
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertIsNone(body["nextCursor"])
        self.assertEqual(body["product"], "SoduWork")
        self.assertEqual(body["schemaVersion"], 1)
        self.assertTrue(datetime.fromisoformat(body["generatedAt"]).tzinfo)
        self.assertEqual([item["id"] for item in body["releases"]], ["new", "old"])
        new, old = body["releases"]
        self.assertEqual(new["artifactName"], row.artifact_name)
        self.assertEqual(new["artifactSize"], row.artifact_size)
        self.assertEqual(new["sha256"], row.sha256)
        self.assertEqual(new["notes"], row.notes)
        self.assertEqual(new["createdAt"], "2026-10-23T08:00:00Z")
        self.assertNotIn("artifactPath", new)
        self.assertTrue(new["isCurrent"])
        self.assertFalse(old["enabled"])
        self.assertFalse(old["isCurrent"])
        self.assertEqual(new["downloadUrl"],
                         "https://fixture.invalid/api/v1/download/client/releases/new")
        result = await self.http.get(new["downloadUrl"])
        self.assertEqual(result.content, b"installer-new")
        self.assertEqual((await self.http.get(old["downloadUrl"])).status_code, 404)
        self.assertEqual(len(statements), 3)  # feed plus two download lookups
        self.assertTrue(all(statement.lstrip().upper().startswith("SELECT")
                            for statement in statements))

    async def test_current_per_format_arch_and_platform_with_semantic_versions(self):
        for identity, version in (("nine", "1.2.9"), ("ten", "1.2.10")):
            await self.add_release(identity, version)
        await self.add_release("deb", fmt="deb", platform="linux")
        await self.add_release("tar", fmt="tar.gz", platform="linux")
        await self.add_release("arm", fmt="dmg", platform="darwin", arch="arm64")
        await self.add_release("intel", fmt="dmg", platform="darwin")
        items = (await self.get_feed()).json()["releases"]
        current = {item["id"] for item in items if item["isCurrent"]}
        self.assertEqual(current, {"ten", "deb", "tar", "arm", "intel"})
        self.assertEqual(next(item["format"] for item in items if item["id"] == "tar"), "tar.gz")

    async def test_invalid_or_unavailable_newer_packages_do_not_become_current(self):
        await self.add_release("valid")
        for index, broken in enumerate(("signature", "missing", "integrity"), start=4):
            await self.add_release(broken, f"1.2.{index}", broken=broken)
        await self.add_release("disabled", "1.2.8", enabled=False)
        items = (await self.get_feed()).json()["releases"]
        self.assertEqual(len(items), 5)
        self.assertEqual([item["id"] for item in items if item["isCurrent"]], ["valid"])

    async def test_snapshot_changes_on_toggle_and_uses_configured_origin(self):
        row = await self.add_release("toggle")
        first = (await self.get_feed()).json()
        second = (await self.get_feed()).json()
        self.assertEqual(first["snapshotId"], second["snapshotId"])
        async with self.sessions() as session:
            stored = await session.get(ClientRelease, row.id)
            stored.enabled = False
            await session.commit()
        third = (await self.get_feed()).json()
        self.assertNotEqual(first["snapshotId"], third["snapshotId"])
        self.assertFalse(third["releases"][0]["enabled"])
        self.assertFalse(third["releases"][0]["isCurrent"])
        with patch.object(get_settings(), "hub_public_url", "https://hub.example.test/"):
            fourth = (await self.get_feed()).json()
        self.assertTrue(fourth["releases"][0]["downloadUrl"].startswith("https://hub.example.test/"))

    async def test_empty_feed_and_token_cannot_modify_releases_or_read_admin(self):
        self.assertEqual((await self.get_feed()).json()["releases"], [])
        self.assertEqual((await self.http.post("/api/v1/client-releases", headers=self.headers)).status_code, 405)
        for method, path in (("GET", "/api/v1/admin/client-releases"),
                             ("PATCH", "/api/v1/admin/client-releases/any")):
            response = await self.http.request(method, path, headers=self.headers)
            self.assertEqual(response.status_code, 401)

    async def test_feed_requires_an_explicit_valid_public_origin(self):
        for origin in ("", "ftp://fixture.invalid", "https://user:password@fixture.invalid",
                       "https://fixture.invalid?token=fixture", "https://fixture.invalid#section",
                       "https://[invalid", "https://fixture.invalid:not-a-port"):
            with self.subTest(origin=origin), patch.object(get_settings(), "hub_public_url", origin):
                response = await self.http.get("/api/v1/client-releases", headers=self.headers)
                self.assertEqual(response.status_code, 503)
                self.assertNotIn("downloadUrl", response.text)


if __name__ == "__main__":
    unittest.main()
