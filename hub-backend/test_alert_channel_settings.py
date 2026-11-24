"""HTTP contract for write-only delivery alert destinations."""
import unittest

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import admin
from app.auth import sign_token
from app.db import Base, get_session
from app.services.notify import ALERT_URL_KEY


class AlertChannelSettingsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(engine.dispose)
        self.sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as conn:
            tables = [model.__table__ for model in (
                models.User, models.OrgUnit, models.Role, models.AppSetting, models.AuditLog)]
            await conn.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tables))
        async with self.sessions() as session:
            session.add(models.User(id="fixture-admin", username="fixture-admin", is_super=True))
            await session.commit()

        async def isolated_session():
            async with self.sessions() as session:
                yield session

        app = FastAPI()
        app.include_router(admin.router)
        app.dependency_overrides[get_session] = isolated_session
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                      base_url="http://fixture/api/v1/admin/",
                                      headers={"Authorization": "Bearer " + sign_token("fixture-admin")})
        self.addAsyncCleanup(self.http.aclose)

    async def test_configured_state_survives_legacy_save_and_explicit_removal(self):
        self.assertEqual((await self.http.get("alert-config")).json(), {"url": "", "configured": False, "usesPlainHttp": False})
        legacy = "http://example.invalid/fixture-private-path"
        async with self.sessions() as session:
            session.add(models.AppSetting(key=ALERT_URL_KEY, value=legacy))
            await session.commit()
        masked = (await self.http.get("alert-config")).json()
        self.assertTrue(masked["configured"])
        self.assertTrue(masked["url"])
        self.assertTrue(masked["usesPlainHttp"])
        self.assertEqual(masked["url"], "••••••••")
        destinations = [legacy, "https://fixture-other.invalid/hook?access_token=fixture-only"]
        for destination in destinations:
            saved = await self.http.put("alert-config", json={"url": destination})
            self.assertEqual(saved.json(), {"ok": True, "configured": True})
            summary = {**masked, "usesPlainHttp": destination.startswith("http://")}
            self.assertEqual((await self.http.get("alert-config")).json(), summary)
            for body in [{}, {"url": None}, {"url": masked["url"]}]:
                self.assertTrue((await self.http.put("alert-config", json=body)).json()["configured"])
            self.assertEqual((await self.http.get("alert-config")).json(), summary)
            for invalid in [[], "ftp://invalid.invalid", "https://example.invalid/" + "a" * 600]:
                self.assertEqual((await self.http.put("alert-config", json={"url": invalid})).status_code, 422)
            async with self.sessions() as session:
                self.assertEqual((await session.get(models.AppSetting, ALERT_URL_KEY)).value, destination)
        cleared = await self.http.put("alert-config", json={"url": ""})
        self.assertEqual(cleared.json(), {"ok": True, "configured": False})
        self.assertEqual((await self.http.get("alert-config")).json(), {"url": "", "configured": False, "usesPlainHttp": False})
        async with self.sessions() as session:
            self.assertEqual((await session.get(models.AppSetting, ALERT_URL_KEY)).value, "")
            details = (await session.scalars(select(models.AuditLog.detail))).all()
            self.assertCountEqual(details, [{"configured": True}, {"configured": True}, {"configured": False}])
