"""HTTP contracts for alert channels and platform notification settings."""
import asyncio
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.account_models import EmailRateLimit
from app.api import admin, admin_mail
from app.auth import sign_token
from app.db import Base, get_session
from app.services.notify import ALERT_URL_KEY


class AlertChannelSettingsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        db_dir = tempfile.TemporaryDirectory()
        self.addCleanup(db_dir.cleanup)
        engine = create_async_engine("sqlite+aiosqlite:///" + (Path(db_dir.name) / "alerts.db").as_posix())
        self.addAsyncCleanup(engine.dispose)
        self.sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as conn:
            tables = [model.__table__ for model in (
                models.User, models.OrgUnit, models.Role, models.AppSetting, models.AuditLog, EmailRateLimit)]
            await conn.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tables))
        async with self.sessions() as session:
            session.add(models.User(id="fixture-admin", username="fixture-admin", is_super=True))
            await session.commit()

        async def isolated_session():
            async with self.sessions() as session:
                yield session

        app = FastAPI()
        app.include_router(admin.router)
        app.include_router(admin_mail.router)
        app.dependency_overrides[get_session] = isolated_session
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                      base_url="http://fixture/api/v1/admin/",
                                      headers={"Authorization": "Bearer " + sign_token("fixture-admin")})
        self.addAsyncCleanup(self.http.aclose)

    async def test_department_permissions_allow_reads_but_only_superusers_save_platform_settings(self):
        async with self.sessions() as session:
            role = models.Role(id="settings-role", name="Settings operator",
                               permissions=["integration.manage", "identity.manage"])
            session.add_all([role, models.OrgUnit(id="root", name="Root"),
                             models.OrgUnit(id="team", name="Team", parent_id="root")])
            session.add(models.User(id="settings-operator", username="operator", role_id=role.id, org_id="team"))
            await session.commit()
        operator = {"Authorization": "Bearer " + sign_token("settings-operator")}
        cases = [
            ("alert-config", {"url": "https://example.invalid/fixture"}, {"url": ""}),
            ("mail-settings", {"senderName": "Fixture sender", "username": "sender@example.invalid",
                               "senderAddress": "sender@example.invalid"}, {"senderName": "Other sender"}),
        ]
        for path, initial, edit in cases:
            with self.subTest(path=path):
                saved = await self.http.put(path, json=initial)
                self.assertEqual(saved.status_code, 200, saved.text)
                before = await self.http.get(path, headers=operator)
                self.assertEqual(before.status_code, 200, before.text)
                denied = await self.http.put(path, json=edit, headers=operator)
                self.assertEqual(denied.status_code, 403, denied.text)
                after = await self.http.get(path)
                self.assertEqual(after.json(), before.json())
                if path == "alert-config":
                    self.assertTrue(after.json()["configured"])
                    async with self.sessions() as session:
                        self.assertEqual((await session.get(models.AppSetting, ALERT_URL_KEY)).value, initial["url"])
                else:
                    self.assertEqual(after.json()["senderName"], initial["senderName"])

    async def test_admins_share_one_test_send_and_rejected_attempts_do_not_extend_cooldown(self):
        async with self.sessions() as session:
            session.add(models.User(id="second-admin", username="second-admin", is_super=True))
            await session.commit()
        headers = [{"Authorization": "Bearer " + sign_token(uid)}
                   for uid in ("fixture-admin", "second-admin")]
        start = datetime(2026, 1, 1, tzinfo=timezone.utc)
        with patch("app.services.email_auth.now", return_value=start) as clock, \
             patch("app.services.notify.alert", new_callable=AsyncMock, return_value=True) as send:
            replies = await asyncio.gather(*(self.http.post("alert-config/test", headers=h) for h in headers))
            self.assertCountEqual([res.status_code for res in replies], [200, 429])
            self.assertEqual(send.await_count, 1)
            rejected = next(h for h, res in zip(headers, replies) if res.status_code == 429)
            clock.return_value = start + timedelta(seconds=29)
            retry = await self.http.post("alert-config/test", headers=rejected)
            self.assertEqual(retry.status_code, 429)
            self.assertGreater(int(retry.headers["Retry-After"]), 0)
            self.assertEqual(send.await_count, 1)
            async with self.sessions() as session:
                counts = (await session.scalars(select(EmailRateLimit.count))).all()
                self.assertCountEqual(counts, [1, 1])  # Accepted user and shared channel only.
            clock.return_value = start + timedelta(seconds=30)
            self.assertTrue((await self.http.post("alert-config/test", headers=rejected)).json()["ok"])
            self.assertEqual(send.await_count, 2)

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
