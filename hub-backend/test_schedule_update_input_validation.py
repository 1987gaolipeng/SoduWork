"""Numeric/timezone request boundaries through authenticated, isolated HTTP."""
import importlib
from pathlib import Path
import unittest

import httpx
from fastapi import FastAPI, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import admin, client_updates, personal_schedules
from app.api.schedule_contract import apply_schedule_update
from app.auth import sign_token
from app.db import Base, get_session
from app.services import device_auth, schedule_timing, schedules

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


INVALID_NUMBERS = ["abc", "3.5", 3.5, 3.0, True, False, {}, [], [1],
                   2 ** 31, -(2 ** 31) - 1, 2 ** 63, 10 ** 100, " "]
NUMBER_FIELDS = ("atHour", "atMinute", "weekday", "retryLimit", "retryDelayMinutes")
SCHEDULE_BODY = {"title": "Synthetic schedule", "assigneeId": "local:pi",
                 "ownerClientId": "device", "every": "daily", "timeZone": "UTC"}


class ScheduleUpdateInputTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        tables = [model.__table__ for model in (
            models.OrgUnit, models.Role, models.User, models.Client,
            models.AiSchedule, models.AuditLog, models.ClientRelease,
            models.ClientUpdateAttempt,
        )]
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tables))
        async with self.sessions() as session:
            session.add_all([
                models.User(id="admin", username="admin", is_super=True, is_active=True),
                models.User(id="reader", username="reader", is_active=True),
                models.Client(id="device", user_ref="admin", auth_state="active"),
                models.Client(id="other", user_ref="reader", auth_state="active"),
            ])
            await session.flush()
            session.add_all([
                models.AiSchedule(id="schedule", title="Original", owner_client_id="device",
                                  assignee_id="local:pi", at_hour=9, time_zone="UTC", retry_count=2),
                models.ClientUpdateAttempt(id="attempt", client_id="device", release_id="fixture",
                                           target_version="1.2.3", state="downloading", progress=20,
                                           detail={"fixture": "preserved"}),
            ])
            await session.commit()
            self.device_headers = {"Authorization": "Device " + device_auth.issue_session(
                await session.get(models.Client, "device"))[0]}
            self.other_headers = {"Authorization": "Device " + device_auth.issue_session(
                await session.get(models.Client, "other"))[0]}
        self.admin_headers = {"Authorization": "Bearer " + sign_token("admin", 1)}
        self.app = FastAPI()
        self.app.include_router(admin.router)
        self.app.include_router(personal_schedules.router, prefix="/api/v1")
        self.app.include_router(client_updates.router)

        async def db():
            async with self.sessions() as session:
                yield session

        self.app.dependency_overrides[get_session] = db
        self.http = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app, raise_app_exceptions=False),
            base_url="http://isolated",
        )

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def schedule_request(self, method, body, *, personal=False):
        prefix = "/api/v1/schedules" if personal else "/api/v1/admin/ai-schedules"
        path = prefix + ("/schedule" if method == "PUT" else "")
        return await self.http.request(method, path, json=body,
            headers=self.device_headers if personal else self.admin_headers)

    async def test_invalid_schedule_numbers_reject_create_and_update_without_writes(self):
        for personal in (False, True):
            for method in ("POST", "PUT"):
                for field in NUMBER_FIELDS:
                    for value in INVALID_NUMBERS:
                        with self.subTest(personal=personal, method=method, field=field, value=value):
                            response = await self.schedule_request(method,
                                {**SCHEDULE_BODY, field: value}, personal=personal)
                            self.assertEqual(response.status_code, 400, response.text)
                            self.assertIn(field, response.json()["detail"])
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.AiSchedule)), 1)
            row = await session.get(models.AiSchedule, "schedule")
            self.assertEqual((row.title, row.at_hour, row.time_zone, row.retry_count),
                             ("Original", 9, "UTC", 2))
            self.assertEqual(await session.scalar(select(func.count()).select_from(models.AuditLog)), 0)

    async def test_valid_schedule_inputs_keep_strings_defaults_clamps_and_partial_updates(self):
        for personal in (False, True):
            created = await self.schedule_request("POST", {**SCHEDULE_BODY,
                "atHour": " 8 ", "atMinute": "30", "weekday": "2",
                "retryLimit": "3", "retryDelayMinutes": "10"}, personal=personal)
            self.assertEqual(created.status_code, 200, created.text)
            self.assertEqual([created.json()[key] for key in NUMBER_FIELDS], [8, 30, 2, 3, 10])
            updated = await self.schedule_request("PUT", {"atHour": 99, "atMinute": -1,
                "weekday": 0, "retryLimit": 99, "retryDelayMinutes": "0"}, personal=personal)
            self.assertEqual(updated.status_code, 200, updated.text)
            self.assertEqual([updated.json()[key] for key in NUMBER_FIELDS], [23, 0, 1, 10, 1])
            for empty in (None, ""):
                reset = await self.schedule_request("PUT", {key: empty for key in NUMBER_FIELDS},
                                                     personal=personal)
                self.assertEqual(reset.status_code, 200, reset.text)
                self.assertEqual([reset.json()[key] for key in NUMBER_FIELDS], [0, 0, 1, 0, 5])
            zero = await self.schedule_request("PUT", {"retryDelayMinutes": 0}, personal=personal)
            self.assertEqual(zero.status_code, 200, zero.text)
            self.assertEqual(zero.json()["retryDelayMinutes"], 5)
            partial = await self.schedule_request("PUT", {"title": "Renamed"}, personal=personal)
            self.assertEqual(partial.status_code, 200, partial.text)
            self.assertEqual(partial.json()["timeZone"], "UTC")
            self.assertEqual(partial.json()["retryDelayMinutes"], 5)

    async def test_calendar_collections_validate_elements_and_keep_explicit_clears(self):
        for field in ("weekdays", "monthDays"):
            for value in INVALID_NUMBERS:
                with self.subTest(field=field, value=value):
                    response = await self.schedule_request("PUT", {field: [value]})
                    self.assertEqual(response.status_code, 400, response.text)
            for empty in ([], None, ""):
                response = await self.schedule_request("PUT", {field: empty})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()[field], [])
        response = await self.schedule_request("PUT", {"every": "weekly", "weekdays": ["1", 3, 7]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["weekdays"], [1, 3, 7])

    async def test_timezones_reject_malformed_writes_but_keep_legacy_rows_readable(self):
        invalid = ("../foo", "/etc/passwd", "Unknown/Zone", "UTC\x00", "UTC" + "x" * 64,
                   {}, [], False, 1, " ")
        for personal in (False, True):
            for method in ("POST", "PUT"):
                for value in invalid:
                    with self.subTest(personal=personal, method=method, value=value):
                        response = await self.schedule_request(method,
                            {**SCHEDULE_BODY, "timeZone": value}, personal=personal)
                        self.assertEqual(response.status_code, 400, response.text)
                        self.assertIn("timeZone", response.json()["detail"])
            for value, expected in (("America/New_York", "America/New_York"), (" UTC ", "UTC"),
                                    (None, "Asia/Shanghai"), ("", "Asia/Shanghai")):
                response = await self.schedule_request("PUT", {"timeZone": value}, personal=personal)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["timeZone"], expected)
        async with self.sessions() as session:
            row = await session.get(models.AiSchedule, "schedule")
            row.time_zone = "../legacy"
            await session.commit()
        for path, headers in (("/api/v1/admin/ai-schedules", self.admin_headers),
                              ("/api/v1/schedules", self.device_headers)):
            response = await self.http.get(path, headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()[0]["timeZone"], "Asia/Shanghai")
        response = await self.schedule_request("PUT", {"title": "Legacy renamed"})
        self.assertEqual(response.status_code, 200, response.text)
        async with self.sessions() as session:
            self.assertEqual((await session.get(models.AiSchedule, "schedule")).time_zone, "../legacy")

    async def test_json_exponent_overflow_is_400_for_numbers_and_collections(self):
        for field in (*NUMBER_FIELDS, "weekdays", "monthDays"):
            value = "[1e309]" if field in ("weekdays", "monthDays") else "1e309"
            content = '{"title":"Changed", "' + field + '":' + value + '}'
            response = await self.http.put("/api/v1/admin/ai-schedules/schedule", content=content,
                headers={**self.admin_headers, "Content-Type": "application/json"})
            self.assertEqual(response.status_code, 400, response.text)
        response = await self.http.post("/api/v1/client-updates/attempts/attempt/events",
            content='{"state":"downloading","progress":1e309}',
            headers={**self.device_headers, "Content-Type": "application/json"})
        self.assertEqual(response.status_code, 400, response.text)

    async def test_progress_validation_preserves_state_and_device_authorization(self):
        path = "/api/v1/client-updates/attempts/attempt/events"
        for value in INVALID_NUMBERS:
            response = await self.http.post(path, headers=self.device_headers,
                json={"state": "downloading", "progress": value, "detail": {"changed": True}})
            self.assertEqual(response.status_code, 400, response.text)
            self.assertIn("progress", response.json()["detail"])
        async with self.sessions() as session:
            row = await session.get(models.ClientUpdateAttempt, "attempt")
            self.assertEqual((row.state, row.progress, row.detail, row.completed_at),
                             ("downloading", 20, {"fixture": "preserved"}, None))
        for headers, expected in (({}, 401), (self.other_headers, 404)):
            response = await self.http.post(path, headers=headers,
                json={"state": "downloading", "progress": "abc"})
            self.assertEqual(response.status_code, expected, response.text)
        conflict = await self.http.post(path, headers=self.device_headers,
            json={"state": "unknown-state", "progress": "abc"})
        self.assertEqual(conflict.status_code, 409, conflict.text)
        for value, expected in ((None, 20), ("", 20), (-3, 20), ("35", 35), (900, 100)):
            response = await self.http.post(path, headers=self.device_headers,
                json={"state": "downloading", "progress": value})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["attempt"]["progress"], expected)


class ScheduleInputAtomicityTests(unittest.TestCase):
    def test_numeric_and_timezone_validation_precedes_object_mutation(self):
        for field, value in (("retryDelayMinutes", {}), ("atHour", float("inf")),
                             ("monthDays", [float("inf")]), ("timeZone", "../foo")):
            schedule = models.AiSchedule(title="Original", at_hour=9, time_zone="UTC")
            with self.subTest(field=field), self.assertRaises(HTTPException) as error:
                apply_schedule_update(schedule, {"title": "Changed", field: value})
            self.assertEqual(error.exception.status_code, 400)
            self.assertEqual((schedule.title, schedule.at_hour, schedule.time_zone), ("Original", 9, "UTC"))

    def test_historical_calendar_lists_tolerate_nonfinite_entries(self):
        self.assertEqual(schedule_timing.clean_weekdays([1, float("inf"), "bad", 3]), [1, 3])
        self.assertEqual(schedule_timing.clean_month_days([1, float("inf"), "bad", 31]), [1, 31])
        for value in ("../foo", "/absolute", "UTC\x00", "Unknown/Zone"):
            self.assertEqual(schedules.clean_time_zone(value), "Asia/Shanghai")


if __name__ == "__main__":
    unittest.main()
