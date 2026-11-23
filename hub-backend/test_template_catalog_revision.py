"""Stale catalogs cannot replace committed administrator changes."""
import os
import unittest

os.environ.setdefault("AUTH_SECRET", "synthetic-template-revision-test-secret")
os.environ.setdefault("ADMIN_PASS", "synthetic-template-revision-password")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app.models import AppSetting
from app.services import template_catalog_revision as catalog


class CatalogTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as connection:
            await connection.run_sync(AppSetting.__table__.create)
        self.sessions = async_sessionmaker(self.engine)

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_stale_update_does_not_overwrite_winner(self):
        async with self.sessions() as db:
            await catalog.replace(db, "templates", None, "original")
            await db.commit()
        async with self.sessions() as first, self.sessions() as second:
            before = await catalog.read(first, "templates")
            other = await catalog.read(second, "templates")
            await catalog.replace(first, "templates", before, "administrator A")
            await first.commit()
            with self.assertRaises(catalog.CatalogConflict):
                await catalog.replace(second, "templates", other, "administrator B")
            await second.rollback()
            self.assertEqual(await catalog.read(second, "templates"), "administrator A")

    async def test_competing_initial_creation_preserves_first_catalog(self):
        async with self.sessions() as db:
            await catalog.replace(db, "templates", None, "first")
            await db.commit()
        async with self.sessions() as db:
            with self.assertRaises(catalog.CatalogConflict):
                await catalog.replace(db, "templates", None, "second")
            self.assertEqual(await catalog.read(db, "templates"), "first")

    async def test_revision_tracks_contents(self):
        self.assertEqual(catalog.revision(None), catalog.revision(""))
        self.assertNotEqual(catalog.revision("first"), catalog.revision("second"))

    async def test_routes_require_revision_and_preserve_winner(self):
        from unittest.mock import AsyncMock, patch
        from fastapi import HTTPException
        from app.api.admin_schedules import list_automation_templates, save_automation_templates
        async with self.sessions() as db:
            initial = await list_automation_templates(user=None, session=db)
            with self.assertRaises(HTTPException) as missing:
                await save_automation_templates(body={"items": []}, user=None, session=db)
            self.assertEqual(missing.exception.status_code, 428)
            with patch("app.services.audit.log", new=AsyncMock()):
                saved = await save_automation_templates(body={"items": [{"id": "first", "name": "First"}], "revision": initial["revision"]}, user=None, session=db)
                with self.assertRaises(HTTPException) as stale:
                    await save_automation_templates(body={"items": [], "revision": initial["revision"]}, user=None, session=db)
            self.assertEqual(stale.exception.status_code, 409)
            current = await list_automation_templates(user=None, session=db)
            self.assertEqual(current, saved)

    async def test_date_changes_require_latest_revision_and_preserve_valid_range(self):
        from unittest.mock import AsyncMock, patch
        from fastapi import HTTPException
        from app.api.admin_schedules import list_automation_templates, save_automation_templates
        with patch("app.services.audit.log", new=AsyncMock()):
            async with self.sessions() as db:
                initial = await list_automation_templates(user=None, session=db)
                template = {"id": "campaign", "name": "Campaign", "startDate": "2030-12-01", "endDate": "2030-12-31"}
                saved = await save_automation_templates(body={"items": [template], "revision": initial["revision"]}, user=None, session=db)
                extended = {**saved["items"][0], "endDate": "2031-01-31"}
                with self.assertRaises(HTTPException) as stale:
                    await save_automation_templates(body={"items": [extended], "revision": initial["revision"]}, user=None, session=db)
                self.assertEqual(stale.exception.status_code, 409)
                current = await list_automation_templates(user=None, session=db)
                self.assertEqual(current, saved)
                updated = await save_automation_templates(body={"items": [extended], "revision": current["revision"]}, user=None, session=db)
                self.assertEqual(updated["items"][0]["startDate"], "2030-12-01")
                self.assertEqual(updated["items"][0]["endDate"], "2031-01-31")
                with self.assertRaises(HTTPException) as invalid:
                    await save_automation_templates(body={"items": [{**extended, "endDate": "2030-11-30"}], "revision": updated["revision"]}, user=None, session=db)
                self.assertEqual(invalid.exception.status_code, 400)
                self.assertEqual(await list_automation_templates(user=None, session=db), updated)


if __name__ == "__main__":
    unittest.main()
