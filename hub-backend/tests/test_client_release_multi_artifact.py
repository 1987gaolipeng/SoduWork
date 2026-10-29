"""Verify coexisting release formats and public Linux downloads. Artifact identity includes
artifact_name, allowing deb/rpm/tar.gz alternatives for the same target version. Update checks
prefer deb, rpm, tar.gz, then appimage; public downloads use the same release source.
"""
import hashlib
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import client_updates as client_updates_api
from app.api import download
from app.db import Base, get_session
from app.models import ClientRelease
from app.services import client_updates as contract


def _trust_stub():
    """Bypass ed25519 verification; keep bundle<->payload equality checks real."""
    return patch.object(contract, "assert_trusted_release",
                        side_effect=lambda candidate: contract.manifest_payload(candidate))


def _installer(root: Path, name: str, size=2 * 1024 * 1024):
    path = root / name
    path.write_bytes(b"0" * size)
    return path


def _bundle(installer, *, version="1.12.69", artifact_name=None, release_id=None):
    data = installer.read_bytes()
    if release_id is None:
        # Give each artifact its own UUID; an existing ID must remain immutable.
        release_id = str(__import__("uuid").uuid5(
            __import__("uuid").NAMESPACE_URL, f"{version}/{artifact_name or installer.name}"))
    return {
        "schema": 1,
        "releaseId": release_id,
        "version": version,
        "channel": "stable",
        "platform": "linux",
        "arch": "x64",
        "artifact": {
            "name": artifact_name or installer.name,
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "url": f"/api/v1/client-updates/artifacts/{release_id}",
        },
        "mandatory": False,
        "minVersion": "",
        "notes": "",
        "publishedAt": "2026-10-12T08:00:00Z",
        "keyId": "fixture-release-key",
        "signature": "irrelevant",
    }


def _release_row(release_id, version, name, *, enabled=True, platform="linux", arch="x64"):
    # Use fixed b"00" content and its matching SHA-256 for real integrity checks.
    return ClientRelease(
        id=release_id, version=version, channel="stable", platform=platform,
        arch=arch, artifact_name=name,
        artifact_path=f"stable/{platform}/{arch}/{version}/{name}",
        artifact_size=2, sha256=hashlib.sha256(b"00").hexdigest(),
        key_id="fixture-release-key", signature="s" * 88,
        notes="", mandatory=False, min_version="", enabled=enabled,
        created_by="test", created_at=None)


class _SqliteIsolated(unittest.IsolatedAsyncioTestCase):
    """Shared fixtures: in-memory database and temporary release_root."""

    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(lambda connection: Base.metadata.create_all(
                connection, tables=[ClientRelease.__table__]))
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.root = Path(self._tmpdir.name)
        patcher = patch.object(contract, "release_root", return_value=self.root)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def _app(self, releases):
        async with self.sessions() as session:
            session.add_all(releases)
            await session.commit()
        for row in releases:
            target = contract.safe_artifact_path(row.artifact_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"00")
        app = FastAPI()
        app.include_router(download.router)

        async def session_override():
            async with self.sessions() as session:
                yield session

        app.dependency_overrides[download.get_session] = session_override
        return app


class FormatRankTests(unittest.TestCase):
    def test_preference_order(self):
        self.assertEqual(contract.format_rank("SoduWork-1.2.3-linux.deb"), 0)
        self.assertEqual(contract.format_rank("SoduWork-1.2.3-linux-x64.rpm"), 1)
        self.assertEqual(contract.format_rank("SoduWork-1.2.3-linux.tar.gz"), 2)
        self.assertEqual(contract.format_rank("SoduWork-1.2.3-linux-x64.AppImage"), 3)
        self.assertEqual(contract.format_rank("SoduWork-1.2.3-Setup.exe"), 4)


class MultiArtifactImportTests(_SqliteIsolated):
    async def test_same_version_three_formats_coexist(self):
        with _trust_stub():
            async with self.sessions() as session:
                for name in ("SoduWork-1.12.69-linux.deb",
                             "SoduWork-1.12.69-linux.rpm",
                             "SoduWork-1.12.69-linux.tar.gz"):
                    installer = _installer(self.root, name)
                    row, created = await contract.import_signed_release(
                        session, _bundle(installer, artifact_name=name), installer,
                        enabled=True, created_by="test")
                    self.assertTrue(created, name)
                await session.commit()
                ids = (await session.execute(select(ClientRelease.id))).scalars().all()
                self.assertEqual(len(ids), 3)

    async def test_exact_retry_is_idempotent(self):
        with _trust_stub():
            async with self.sessions() as session:
                installer = _installer(self.root, "SoduWork-1.12.69-linux.deb")
                first, created = await contract.import_signed_release(
                    session, _bundle(installer), installer, created_by="test")
                await session.commit()
                again, created_again = await contract.import_signed_release(
                    session, _bundle(installer), installer, created_by="test")
                self.assertFalse(created_again)
                self.assertEqual(first.id, again.id)

    async def test_same_artifact_name_other_bytes_rejected(self):
        with _trust_stub():
            async with self.sessions() as session:
                installer = _installer(self.root, "SoduWork-1.12.69-linux.deb")
                await contract.import_signed_release(
                    session, _bundle(installer), installer, created_by="test")
                await session.commit()
                installer.write_bytes(b"9" * (2 * 1024 * 1024))
                with self.assertRaisesRegex(contract.UpdateContractError,
                                            "already exists"):
                    await contract.import_signed_release(
                        session, _bundle(installer), installer, created_by="test")


class ReleaseRowsOrderTests(_SqliteIsolated):
    async def _rows(self, releases):
        async with self.sessions() as session:
            session.add_all(releases)
            await session.commit()
        with _trust_stub():
            async with self.sessions() as session:
                return await client_updates_api._release_rows(session, "stable", "linux", "x64")

    async def test_same_version_prefers_deb(self):
        rows = await self._rows([
            _release_row("r-tgz", "1.12.69", "SoduWork-1.12.69-linux.tar.gz"),
            _release_row("r-rpm", "1.12.69", "SoduWork-1.12.69-linux.rpm"),
            _release_row("r-deb", "1.12.69", "SoduWork-1.12.69-linux.deb"),
        ])
        self.assertEqual([row.id for row in rows], ["r-deb", "r-rpm", "r-tgz"])

    async def test_newer_version_first(self):
        rows = await self._rows([
            _release_row("r-old", "1.12.68", "SoduWork-1.12.68-linux.deb"),
            _release_row("r-new", "1.12.69", "SoduWork-1.12.69-linux.rpm"),
        ])
        self.assertEqual([row.id for row in rows], ["r-new", "r-old"])


class LinuxDownloadRouteTests(_SqliteIsolated):
    async def test_info_lists_newest_version_formats(self):
        app = await self._app([
            _release_row("r-old", "1.12.68", "SoduWork-1.12.68-linux.deb"),
            _release_row("r-deb", "1.12.69", "SoduWork-1.12.69-linux.deb"),
            _release_row("r-rpm", "1.12.69", "SoduWork-1.12.69-linux.rpm"),
        ])
        with _trust_stub():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                         base_url="http://test") as client:
                data = (await client.get("/api/v1/download/client/linux/info")).json()
        self.assertTrue(data["available"])
        self.assertEqual(data["version"], "1.12.69")
        self.assertEqual(sorted(data["formats"]), ["deb", "rpm"])
        self.assertEqual(data["formats"]["deb"]["filename"], "SoduWork-1.12.69-linux.deb")

    async def test_download_serves_enabled_trusted_release(self):
        app = await self._app([
            _release_row("r-deb", "1.12.69", "SoduWork-1.12.69-linux.deb"),
        ])
        with _trust_stub():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                         base_url="http://test") as client:
                response = await client.get("/api/v1/download/client/linux/deb")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"00")

    async def test_unknown_format_rejected(self):
        app = await self._app([])
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://test") as client:
            response = await client.get("/api/v1/download/client/linux/exe")
        self.assertEqual(response.status_code, 404)

    async def test_disabled_release_not_served(self):
        app = await self._app([
            _release_row("r-deb", "1.12.69", "SoduWork-1.12.69-linux.deb", enabled=False),
        ])
        with _trust_stub():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                         base_url="http://test") as client:
                info = (await client.get("/api/v1/download/client/linux/info")).json()
                response = await client.get("/api/v1/download/client/linux/deb")
        self.assertFalse(info["available"])
        self.assertEqual(response.status_code, 404)


class MacDownloadRouteTests(_SqliteIsolated):
    async def test_info_lists_both_arches_newest_version(self):
        app = await self._app([
            _release_row("m-old", "1.12.68", "SoduWork-1.12.68-mac-arm64.dmg",
                         platform="darwin", arch="arm64"),
            _release_row("m-arm", "1.12.69", "SoduWork-1.12.69-mac-arm64.dmg",
                         platform="darwin", arch="arm64"),
            _release_row("m-x64", "1.12.69", "SoduWork-1.12.69-mac-x64.dmg",
                         platform="darwin", arch="x64"),
        ])
        with _trust_stub():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                         base_url="http://test") as client:
                data = (await client.get("/api/v1/download/client/mac/info")).json()
                arm = await client.get("/api/v1/download/client/mac/arm64")
                intel = await client.get("/api/v1/download/client/mac/x64")
        self.assertTrue(data["available"])
        self.assertEqual(data["version"], "1.12.69")
        self.assertEqual(sorted(data["arches"]), ["arm64", "x64"])
        self.assertEqual(data["arches"]["arm64"]["filename"], "SoduWork-1.12.69-mac-arm64.dmg")
        self.assertEqual(arm.status_code, 200)
        self.assertEqual(arm.content, b"00")
        self.assertEqual(intel.headers["content-type"], "application/x-apple-diskimage")

    async def test_unknown_arch_rejected(self):
        app = await self._app([])
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://test") as client:
            response = await client.get("/api/v1/download/client/mac/ppc64")
        self.assertEqual(response.status_code, 404)


class WindowsDownloadRouteTests(_SqliteIsolated):
    """Windows public downloads share Linux/macOS sourcing: prefer release channels, then directory
    fallback.
    """

    async def test_prefers_release_channel_newest(self):
        app = await self._app([
            _release_row("w-old", "1.12.57", "SoduWork-1.12.57-Setup.exe",
                         platform="win32", arch="x64"),
            _release_row("w-new", "1.12.67", "SoduWork-1.12.67-Setup.exe",
                         platform="win32", arch="x64"),
        ])
        with _trust_stub():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                         base_url="http://test") as client:
                info = (await client.get("/api/v1/download/client/info")).json()
                response = await client.get("/api/v1/download/client")
        self.assertTrue(info["available"])
        self.assertEqual(info["version"], "1.12.67")
        self.assertEqual(info["artifactFilename"], "SoduWork-1.12.67-Setup.exe")
        self.assertEqual(info["filename"], "SoduWork-Setup.exe")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"00")

    async def test_falls_back_to_downloads_dir_without_releases(self):
        app = await self._app([])
        downloads = Path(self._tmpdir.name) / "downloads"
        downloads.mkdir()
        (downloads / "SoduWork-1.12.55-Setup.exe").write_bytes(b"legacy")
        with patch.object(download, "_DIR", downloads):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                         base_url="http://test") as client:
                info = (await client.get("/api/v1/download/client/info")).json()
                response = await client.get("/api/v1/download/client")
        self.assertTrue(info["available"])
        self.assertEqual(info["version"], "1.12.55")
        self.assertEqual(response.content, b"legacy")
        self.assertEqual(info["filename"], "SoduWork-Setup.exe")
        self.assertIn('filename="SoduWork-Setup.exe"', response.headers["content-disposition"])


class PublicDownloadSurfaceTests(unittest.TestCase):
    def test_excluded_mobile_packages_have_no_download_routes(self):
        paths = {route.path for route in download.router.routes}
        self.assertFalse(any('/mobile' in route for route in paths))


if __name__ == "__main__":
    unittest.main()
