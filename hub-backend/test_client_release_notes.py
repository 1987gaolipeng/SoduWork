"""Isolated SQLite/ASGI coverage; never reads or mutates the business database."""
import os
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["AUTH_SECRET"] = "isolated-release-note-tests-secret"
os.environ["ADMIN_PASS"] = "isolated-release-note-tests-password"
import unittest
from types import SimpleNamespace
import httpx
from fastapi import FastAPI, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app.api import client_release_notes as api
from app.models import ClientRelease, AuditLog
from app.release_note_models import ClientReleaseNote
from app.db import Base, get_session
from app.deps import current_client


def translations():
    return {locale: {"summary": locale + " summary", "sections": [
        {"id": "features", "title": locale, "items": [{"id": "one", "text": "<script>plain text</script>"}]}]}
        for locale in ("zh-CN", "en-US")}


class NotesTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        __import__("asyncio").get_running_loop().set_debug(False)
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=[
                ClientRelease.__table__, ClientReleaseNote.__table__, AuditLog.__table__]))
        self.app = FastAPI()
        self.app.include_router(api.router)
        self.app.include_router(api.admin_router)
        self.authorized = True
        async def session():
            async with self.sessions() as value:
                yield value
        async def actor():
            if not self.authorized:
                raise HTTPException(403, "forbidden")
            return SimpleNamespace(id="publisher", username="publisher")
        self.app.dependency_overrides[get_session] = session
        self.app.dependency_overrides[current_client] = actor
        for route in api.admin_router.routes:
            for dependency in route.dependant.dependencies:
                if dependency.call is not get_session:
                    self.app.dependency_overrides[dependency.call] = actor
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        async with self.sessions() as db:
            for ident, version, enabled, platform in [
                ("a", "1.2.0", True, "win32"), ("b", "1.2.0", True, "win32"),
                ("c", "1.3.0", True, "win32"), ("d", "1.1.0", False, "win32"),
                ("e", "1.0.0", True, "darwin"), ("f", "0.9.0", True, "win32")]:
                db.add(ClientRelease(id=ident, version=version, channel="stable", platform=platform,
                    arch="x64", artifact_name=ident + ".exe", artifact_path="fixture", artifact_size=1,
                    sha256="a" * 64, signature="unchanged-signature", key_id="fixture", notes="legacy original",
                    enabled=enabled))
            await db.commit()

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def put(self, **values):
        return await self.http.put('/api/v1/admin/client-release-notes/1.2.0', json={
            "locales": translations(), "status": "published", "expectedRevision": 0, **values})

    async def listing(self, **query):
        return await self.http.get('/api/v1/client-release-notes', params={"current": "1.2.0", **query})

    async def test_language_filter_pagination_and_signed_rows_unchanged(self):
        self.assertEqual((await self.put()).status_code, 200)
        result = (await self.listing(locale="en-US", limit=1)).json()
        self.assertEqual(result["releases"][0]["summary"], "en-US summary")
        self.assertEqual(result["nextOffset"], 1)
        second = (await self.listing(offset=1)).json()["releases"]
        self.assertEqual([r["version"] for r in second], ["0.9.0"])
        self.assertEqual(second[0]["locale"], "und")
        self.assertEqual((await self.listing(locale="zh-CN")).json()["releases"][0]["summary"], "zh-CN summary")
        async with self.sessions() as db:
            row = await db.get(ClientRelease, "a")
            self.assertEqual(row.notes, "legacy original")
            self.assertEqual(row.signature, "unchanged-signature")

    async def test_draft_idempotence_revision_and_publication(self):
        self.assertEqual((await self.put(status="draft")).status_code, 200)
        self.assertEqual((await self.put(status="draft")).json()["revision"], 1)
        self.assertEqual((await self.listing(version="1.2.0")).json()["releases"], [])
        self.assertEqual((await self.put()).status_code, 409)
        self.assertEqual((await self.put(expectedRevision=1)).status_code, 200)
        self.assertEqual((await self.listing(version="1.2.0")).json()["releases"][0]["revision"], 2)

    async def test_published_history_survives_disabled_installer_and_unreleased_cannot_publish(self):
        self.assertEqual((await self.put()).status_code, 200)
        async with self.sessions() as db:
            for ident in ("a", "b"):
                row = await db.get(ClientRelease, ident)
                row.enabled = False
            await db.commit()
        self.assertEqual(len((await self.listing(version="1.2.0")).json()["releases"]), 1)
        result = await self.http.put('/api/v1/admin/client-release-notes/9.0.0', json={
            "locales": translations(), "status": "published", "expectedRevision": 0})
        self.assertEqual(result.status_code, 409)

    async def test_validation_auth_and_missing_translation(self):
        content = translations()
        content["en-US"]["sections"][0]["items"][0]["id"] = "different"
        self.assertEqual((await self.put(locales=content)).status_code, 422)
        content = translations(); del content["en-US"]
        self.assertEqual((await self.put(locales=content)).status_code, 422)
        self.assertEqual((await self.listing(current="invalid")).status_code, 422)
        self.authorized = False
        self.assertEqual((await self.put()).status_code, 403)
        self.assertEqual((await self.listing()).status_code, 403)


class MigrationTests(unittest.TestCase):
    def test_migration_creates_and_removes_only_localized_table(self):
        import importlib.util
        from pathlib import Path
        from sqlalchemy import create_engine, inspect
        from alembic.migration import MigrationContext
        from alembic.operations import Operations
        file = Path(__file__).parent / "migrations/versions/0069_client_release_notes.py"
        spec = importlib.util.spec_from_file_location("release_notes_migration", file)
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)
        engine = create_engine("sqlite:///:memory:")
        with engine.begin() as connection:
            with Operations.context(MigrationContext.configure(connection)):
                migration.upgrade()
                self.assertIn("client_release_note", inspect(connection).get_table_names())
                columns = {c["name"] for c in inspect(connection).get_columns("client_release_note")}
                self.assertEqual(columns, {"version", "channel", "locales", "revision", "status", "published_at", "updated_at"})
                migration.downgrade()
                self.assertEqual(inspect(connection).get_table_names(), [])
        engine.dispose()


if __name__ == '__main__':
    unittest.main()
