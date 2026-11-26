"""Repository source ownership through the administration create and edit forms."""
import os
import secrets
import unittest

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", secrets.token_hex(32))
os.environ.setdefault("ADMIN_PASS", secrets.token_hex(20))

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import admin, repositories
from app.schemas import IntegrationCreate, IntegrationUpdate


class RepositorySourceOwnership(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(engine.dispose)
        async with engine.begin() as conn:
            for model in (models.OrgUnit, models.Integration, models.AuditLog):
                await conn.run_sync(model.__table__.create)
        self.session = async_sessionmaker(engine, expire_on_commit=False)()
        self.addAsyncCleanup(self.session.close)
        self.session.add_all([
            models.OrgUnit(id="team", name="Team"),
            models.OrgUnit(id="child", name="Child", parent_id="team"),
            models.OrgUnit(id="other", name="Other"),
        ])
        await self.session.commit()
        self.user = models.User(id="admin", username="admin", org_id="team", is_super=False)

    async def create(self, name, provider, **config):
        body = IntegrationCreate(name=name, type=provider, config=config)
        return await admin.create_integration(body, self.user, self.session)

    async def edit(self, source, **config):
        body = IntegrationUpdate(config=config)
        return await admin.update_integration(source["id"], body, self.user, self.session)

    async def test_creator_can_save_the_first_pull_account_and_rotate_a_legacy_account(self):
        source = await self.create("New GitLab", "gitlab", base_url="https://scm.example")
        credentials = {"user": "reader", "secret": secrets.token_hex(16)}
        await repositories.save_pull_account(source["id"], credentials, self.user, self.session)
        row = await self.session.get(models.Integration, source["id"], populate_existing=True)
        self.assertEqual(row.config["orgId"], "team")
        self.assertEqual(row.config["pullAuth"], credentials)

        row.config = {**row.config, "orgId": " team "}
        await self.session.commit()
        await repositories.save_pull_account(source["id"], {"user": "new-reader"}, self.user, self.session)
        await self.session.refresh(row)
        self.assertEqual(row.config["orgId"].strip(), "team")
        self.assertEqual(row.config["pullAuth"], {**credentials, "user": "new-reader"})

    async def test_scoped_form_defaults_owner_and_preserves_it_on_edit(self):
        for provider in ("GitLab", "GitHub"):
            with self.subTest(provider=provider):
                source = await self.create(provider, provider, base_url="https://scm.example")
                self.assertEqual(source["config"]["orgId"], "team")
                edited = await self.edit(source, project="example")
                self.assertEqual(edited["config"], {**source["config"], "project": "example"})
                moved = await self.edit(source, orgId=" child ")
                self.assertEqual(moved["config"]["orgId"], "child")
        child = await self.create("Child source", "gitlab", orgId=" child ")
        self.assertEqual(child["config"]["orgId"], "child")

    async def test_scoped_writes_check_current_and_requested_owner(self):
        with self.assertRaises(HTTPException) as rejected:
            await self.create("Other source", "gitlab", orgId="other")
        self.assertEqual(rejected.exception.status_code, 403)
        source = await self.create("Team source", "gitlab")
        for requested in ("other", "", None):
            with self.subTest(requested=requested), self.assertRaises(HTTPException) as rejected:
                await self.edit(source, orgId=requested)
            self.assertEqual(rejected.exception.status_code, 403)
        self.user.org_id = "other"
        with self.assertRaises(HTTPException) as rejected:
            await self.edit(source, project="different")
        self.assertEqual(rejected.exception.status_code, 403)
        stored = await self.session.get(models.Integration, source["id"], populate_existing=True)
        self.assertEqual(stored.config, {"orgId": "team"})

    async def test_global_sources_and_other_provider_types(self):
        self.user.org_id = None
        with self.assertRaises(HTTPException) as rejected:
            await self.create("No scope", "github")
        self.assertEqual(rejected.exception.status_code, 403)
        generic = await self.create("Webhook", "generic")
        self.assertNotIn("orgId", generic["config"])
        self.user.is_super = True
        legacy = await self.create("Global GitHub", "github")
        self.assertNotIn("orgId", legacy["config"])
        for owner in ("absent", ["team"]):
            with self.subTest(owner=owner), self.assertRaises(HTTPException) as rejected:
                await self.edit(legacy, orgId=owner)
            self.assertEqual(rejected.exception.status_code, 400)
        assigned = await self.edit(legacy, orgId=" child ")
        self.assertEqual(assigned["config"]["orgId"], "child")
