"""User lists and admin PATCH replies surface the effective allowance (issue #935).

An effective quota assignment wins admission and the quota management page.
User lists and PATCH responses must therefore show the same effective numbers
instead of the legacy personal override alone. Service-level checks against an
isolated in-memory database; no HTTP and no live data.
"""
import importlib
import json
import os
import secrets
import unittest
from pathlib import Path

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", secrets.token_hex(32))
os.environ.setdefault("ADMIN_PASS", secrets.token_hex(16))

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.db import Base
from app.services import client_access, rbac
from app.services import quota_plans as qp

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)

CUSTOM_8000 = {"mode": "custom", "revision": 1,
               "custom": {"totalLimit": 8000, "models": [], "restrictModels": False}}
ASSIGNMENT_VIEW = {"mode": "custom", "limit": 8000, "quotaSource": "assignment",
                   "planId": "custom", "planName": "个人配置"}


class QuotaUserListMergeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add(models.User(id="u1", username="u1", display_name="U1",
                                    org_id="team", is_active=True, auth_version=1))
            await session.commit()

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def set_assignment(self, session, grant):
        row = await session.get(models.AppSetting, qp.GRANT_PREFIX + "u1")
        if row is None:
            session.add(models.AppSetting(key=qp.GRANT_PREFIX + "u1",
                                          value=json.dumps(grant, ensure_ascii=False)))
        else:
            row.value = json.dumps(grant, ensure_ascii=False)
        await session.commit()

    async def drop_assignment(self, session):
        row = await session.get(models.AppSetting, qp.GRANT_PREFIX + "u1")
        if row is not None:
            await session.delete(row)
            await session.commit()

    async def listed_token_quota(self, session):
        users = await rbac.list_users(session, None)
        return next(u["tokenQuota"] for u in users if u["id"] == "u1")

    async def test_assignment_wins_in_user_list(self):
        async with self.sessions() as session:
            await self.set_assignment(session, CUSTOM_8000)
            self.assertEqual(await self.listed_token_quota(session), ASSIGNMENT_VIEW)

    async def test_legacy_override_without_assignment(self):
        async with self.sessions() as session:
            await client_access.save_user_quota(session, "u1", {"mode": "limited", "limit": 5000})
            await session.commit()
            self.assertEqual(await self.listed_token_quota(session),
                             {"mode": "limited", "limit": 5000, "quotaSource": "legacy"})

    async def test_assignment_wins_over_stored_override(self):
        async with self.sessions() as session:
            await self.set_assignment(session, CUSTOM_8000)
            await client_access.save_user_quota(session, "u1", {"mode": "limited", "limit": 99999})
            await session.commit()
            self.assertEqual(await self.listed_token_quota(session), ASSIGNMENT_VIEW)
            # Admission reads the same effective number the list now shows.
            status = await client_access.quota_status(session, "u1")
            self.assertEqual(status["limit"], 8000)

    async def test_patch_reply_surfaces_effective_assignment(self):
        async with self.sessions() as session:
            await self.set_assignment(session, CUSTOM_8000)
            await session.commit()
            reply = await rbac.update_user(session, "u1",
                                           {"tokenQuota": {"mode": "limited", "limit": 99999}})
            self.assertEqual(reply["tokenQuota"], ASSIGNMENT_VIEW)

    async def test_patch_reply_keeps_override_shape_without_assignment(self):
        async with self.sessions() as session:
            await self.drop_assignment(session)
            reply = await rbac.update_user(session, "u1",
                                           {"tokenQuota": {"mode": "limited", "limit": 5000}})
            self.assertEqual(reply["tokenQuota"], {"mode": "limited", "limit": 5000})

    async def test_deleted_or_inherit_assignment_falls_back_to_override(self):
        async with self.sessions() as session:
            await client_access.save_user_quota(session, "u1", {"mode": "limited", "limit": 5000})
            await self.set_assignment(session, {"mode": "inherit", "revision": 3})
            await session.commit()
            self.assertEqual(await self.listed_token_quota(session),
                             {"mode": "limited", "limit": 5000, "quotaSource": "legacy"})


if __name__ == "__main__":
    unittest.main()
