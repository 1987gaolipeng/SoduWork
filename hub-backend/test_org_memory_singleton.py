"""Isolated service, HTTP and migration checks; never uses the configured DB."""
import os
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
os.environ["AUTH_SECRET"] = "org-memory-test-signing-key-not-for-production"

import asyncio
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch
import uuid

from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import DateTime, bindparam, create_engine, select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api.memory_records import admin_router
from app.auth import sign_token
from app.db import get_session
from app.memory_record_models import MemoryRecord
from app.services import memory_records as svc


def body(summary="current", **changes):
    return {"confirmed": True, "title": "Organization", "fields": {"summary": summary}, **changes}


def record(rid, org="org-a", key=None, archived=False, **extra):
    return MemoryRecord(
        id=rid, scope="org", org_id=org, owner_user_id="", memory_key=key or rid,
        title=rid, summary=rid, fields={"summary": rid}, archived=archived,
        revision=1, source_meta={"evidence": rid}, **extra,
    )


class OrgMemoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="org-memory-tests-")
        url = os.environ.get("ORG_MEMORY_TEST_POSTGRES_URL", "")
        self.schema = ""
        if url:
            parsed = make_url(url)
            if (parsed.drivername != "postgresql+asyncpg" or parsed.host != "127.0.0.1"
                    or not re.fullmatch(r"soduwork_orgmemory_test_[a-f0-9]{24}", parsed.database or "")):
                raise RuntimeError("Only the disposable loopback PostgreSQL fixture is allowed")
            self.schema = "org_memory_test_" + uuid.uuid4().hex
            self.engine = create_async_engine(url)
            async with self.engine.begin() as connection:
                await connection.execute(text('CREATE SCHEMA "' + self.schema + '"'))
            await self.engine.dispose()
            self.engine = create_async_engine(url, connect_args={
                "server_settings": {"search_path": self.schema},
            })
        else:
            self.engine = create_async_engine(
                "sqlite+aiosqlite:///" + (Path(self.temp.name) / "test.db").as_posix(),
                connect_args={"timeout": 10},
            )
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda c: (
                models.OrgUnit.__table__.create(c), models.User.__table__.create(c),
                models.Role.__table__.create(c), MemoryRecord.__table__.create(c),
                models.AuditLog.__table__.create(c),
                models.AppSetting.__table__.create(c), models.Task.__table__.create(c),
            ))
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.sessions() as session:
            session.add_all([
                models.OrgUnit(id="org-a", name="A"),
                models.OrgUnit(id="org-b", name="B", parent_id="org-a"),
                models.User(id="super", username="super", org_id="org-a", is_super=True),
                models.Role(id="manager-role", name="Manager", permissions=["org.manage"]),
                models.User(id="manager-a", username="manager-a", org_id="org-a", role_id="manager-role"),
                models.User(id="manager-b", username="manager-b", org_id="org-b", role_id="manager-role"),
                models.User(id="employee", username="employee", org_id="org-a"),
            ])
            await session.commit()

    async def asyncTearDown(self):
        if self.schema:
            async with self.engine.begin() as connection:
                await connection.execute(text('DROP SCHEMA "' + self.schema + '" CASCADE'))
        await self.engine.dispose()
        self.temp.cleanup()

    async def user(self, session, uid="super"):
        user = await session.get(models.User, uid)
        user._perms = {"org.manage"}
        return user

    async def allow_legacy_duplicates(self):
        async with self.engine.begin() as connection:
            await connection.execute(text("DROP INDEX uq_memory_record_org_current"))

    async def test_existing_default_does_not_revive_or_shadow_current(self):
        async with self.sessions() as session:
            session.add_all([record("archived-default", key="default", archived=True),
                             record("active-legacy")])
            await session.commit()
            user = await self.user(session)
            current = await svc.org_listing(session, user)
            self.assertEqual([r["id"] for r in current["items"]], ["active-legacy"])
            history = await svc.org_listing(session, user, archived=True)
            self.assertEqual([r["id"] for r in history["items"]], ["archived-default"])
            edited = await svc.org_edit(session, user, "active-legacy", body("edited", revision=1))
            self.assertEqual(edited["item"]["key"], "active-legacy")
            old = await svc.org_get(session, user, "archived-default")
            self.assertTrue(old.archived)
            self.assertEqual(old.fields, {"summary": "archived-default"})
            with self.assertRaises(HTTPException) as failed:
                await svc.org_edit(session, user, old.id, body("resurrect", revision=1))
            self.assertEqual(failed.exception.status_code, 409)

    async def test_empty_current_can_create_without_reusing_archived_default(self):
        async with self.sessions() as session:
            session.add(record("old", key="default", archived=True))
            await session.commit()
            user = await self.user(session)
            self.assertEqual((await svc.org_listing(session, user))["items"], [])
            created = await svc.org_create(session, user, body("new", key="default"))
            self.assertNotEqual(created["item"]["id"], "old")
            self.assertNotEqual(created["item"]["key"], "default")
            old = await session.get(MemoryRecord, "old")
            self.assertTrue(old.archived)
            self.assertEqual(old.fields, {"summary": "old"})
            self.assertEqual(old.revision, 1)
            await svc.org_delete(session, user, created["item"]["id"])
            self.assertEqual((await svc.org_listing(session, user))["items"], [])
            self.assertEqual((await svc.org_listing(session, user, archived=True))["items"][0]["id"], "old")

    async def test_pre_migration_view_edit_and_delete_choose_the_same_record(self):
        await self.allow_legacy_duplicates()
        async with self.sessions() as session:
            session.add_all([record("canonical", key="default"), record("legacy"),
                             record("child", org="org-b")])
            await session.commit()
            user = await self.user(session)
            self.assertEqual((await svc.org_listing(session, user))["items"][0]["id"], "canonical")
            with self.assertRaises(HTTPException):
                await svc.org_edit(session, user, "legacy", body("wrong", revision=1))
            legacy = await session.get(MemoryRecord, "legacy")
            original_time = legacy.updated_at
            await svc.org_edit(session, user, "canonical", body("approved", revision=1))
            await session.refresh(legacy)
            self.assertEqual(legacy.fields, {"summary": "legacy"})
            self.assertEqual(legacy.updated_at, original_time)
            self.assertEqual(legacy.revision, 2)
            self.assertTrue(legacy.archived)
            self.assertFalse((await session.get(MemoryRecord, "child")).archived)
            # Simulate another older server's duplicate before the migration.
            session.add(record("late-legacy"))
            await session.commit()
            await svc.org_delete(session, user, "canonical")
            self.assertEqual((await svc.org_listing(session, user))["items"], [])
            self.assertTrue((await session.get(MemoryRecord, "late-legacy")).archived)
            self.assertIsNotNone(await session.get(MemoryRecord, "legacy"))
            self.assertFalse((await session.get(MemoryRecord, "child")).archived)

    async def test_revision_is_required_and_failed_writes_preserve_content(self):
        async with self.sessions() as session:
            user = await self.user(session)
            first = (await svc.org_create(session, user, body()))["item"]
            for revision in (None, 0, True, "1", [], 99):
                with self.subTest(revision=revision), self.assertRaises(HTTPException) as failed:
                    await svc.org_create(session, user, body("lost update", revision=revision, id=first["id"]))
                self.assertEqual(failed.exception.status_code, 409)
            result = await svc.org_edit(session, user, first["id"], body("new", revision=1))
            self.assertEqual(result["item"]["revision"], 2)
            with self.assertRaises(HTTPException):
                await svc.org_edit(session, user, first["id"], body("stale", revision=1))
            self.assertEqual((await svc.org_listing(session, user))["items"][0]["summary"], "new")

    async def race(self, calls):
        original = svc._org_current
        ready = asyncio.Event()
        readers = 0

        async def synchronized_read(*args):
            nonlocal readers
            result = await original(*args)
            readers += 1
            if readers == len(calls):
                ready.set()
            await asyncio.wait_for(ready.wait(), timeout=5)
            return result

        async def run(operation):
            async with self.sessions() as session:
                user = await self.user(session)
                try:
                    return await operation(session, user)
                except HTTPException as exc:
                    return exc.status_code

        with patch.object(svc, "_org_current", synchronized_read):
            results = await asyncio.gather(*(run(call) for call in calls))
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1, results)
        self.assertEqual(results.count(409), 1, results)
        return next(result for result in results if isinstance(result, dict))

    async def test_two_first_creates_have_one_winner_even_with_archived_default(self):
        async with self.sessions() as session:
            session.add(record("old", key="default", archived=True))
            await session.commit()
        winner = await self.race([
            lambda s, u: svc.org_create(s, u, body("create-A")),
            lambda s, u: svc.org_create(s, u, body("create-B")),
        ])
        async with self.sessions() as session:
            active = list((await session.scalars(select(MemoryRecord).where(
                MemoryRecord.archived.is_(False),
            ))).all())
            self.assertEqual(len(active), 1)
            self.assertEqual(active[0].id, winner["item"]["id"])
            self.assertEqual((await session.get(MemoryRecord, "old")).summary, "old")

    async def test_two_puts_compare_revision_in_the_database(self):
        async with self.sessions() as session:
            session.add(record("current"))
            await session.commit()
        winner = await self.race([
            lambda s, u: svc.org_edit(s, u, "current", body("edit-A", revision=1)),
            lambda s, u: svc.org_edit(s, u, "current", body("edit-B", revision=1)),
        ])
        async with self.sessions() as session:
            row = await session.get(MemoryRecord, "current")
            self.assertEqual(row.revision, 2)
            self.assertEqual(row.summary, winner["item"]["summary"])

    async def test_compatibility_post_and_put_share_revision_cas(self):
        async with self.sessions() as session:
            session.add(record("current"))
            await session.commit()
        await self.race([
            lambda s, u: svc.org_create(s, u, body("post", revision=1, id="current")),
            lambda s, u: svc.org_edit(s, u, "current", body("put", revision=1)),
        ])

    async def test_old_post_identity_cannot_replace_a_recreated_record(self):
        async with self.sessions() as session:
            user = await self.user(session)
            old = (await svc.org_create(session, user, body("old")))["item"]
            await svc.org_delete(session, user, old["id"])
            with self.assertRaises(HTTPException):
                await svc.org_create(session, user, body("stale", revision=1, id=old["id"]))
            new = (await svc.org_create(session, user, body("new")))["item"]
            self.assertNotEqual(new["id"], old["id"])
            self.assertEqual(new["revision"], old["revision"])
            for identity in (None, old["id"]):
                with self.assertRaises(HTTPException) as failed:
                    await svc.org_create(session, user, body("stale", revision=1, id=identity))
                self.assertEqual(failed.exception.status_code, 409)
            self.assertEqual((await svc.org_listing(session, user))["items"][0]["summary"], "new")

    async def test_database_blocks_duplicate_current_and_archived_restore(self):
        async with self.sessions() as session:
            session.add_all([record("current"), record("old", archived=True),
                             record("child", org="org-b")])
            await session.commit()
            session.add(record("duplicate"))
            with self.assertRaises(IntegrityError):
                await session.commit()
            await session.rollback()
            with self.assertRaises(IntegrityError):
                await session.execute(update(MemoryRecord).where(
                    MemoryRecord.id == "old",
                ).values(archived=False))
            await session.rollback()
            self.assertTrue((await session.get(MemoryRecord, "old")).archived)
            self.assertEqual((await session.get(MemoryRecord, "child")).summary, "child")

    async def test_http_singleton_conflicts_history_and_exact_org_boundaries(self):
        app = FastAPI()
        app.include_router(admin_router)

        async def request_session():
            async with self.sessions() as session:
                yield session

        app.dependency_overrides[get_session] = request_session
        url = "/api/v1/admin/org-memory"
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://isolated.test",
                               headers={"Authorization": "Bearer " + sign_token("super")}) as client:
            self.assertEqual((await client.get(url, headers={"Authorization": ""})).status_code, 401)
            self.assertEqual((await client.get(url, headers={
                "Authorization": "Bearer " + sign_token("employee"),
            })).status_code, 403)
            first = await client.post(url, json=body("parent", orgId="org-a"))
            self.assertEqual(first.status_code, 200, first.text)
            rid = first.json()["item"]["id"]
            self.assertEqual((await client.post(url, json=body("unconfirmed replacement"))).status_code, 409)
            second = await client.post(url, json=body("child", orgId="org-b"))
            self.assertEqual(second.status_code, 200, second.text)
            child_id = second.json()["item"]["id"]
            changed = await client.put(url + "/" + child_id, json=body("child updated", revision=1))
            self.assertEqual(changed.status_code, 200, changed.text)
            self.assertEqual((await client.get(url + "/" + child_id)).status_code, 200)
            stale = await client.put(url + "/" + child_id, json=body("stale", revision=1))
            self.assertEqual(stale.status_code, 409)
            headers = {"Authorization": "Bearer " + sign_token("manager-a")}
            self.assertEqual((await client.get(url + "?orgId=org-b", headers=headers)).status_code, 403)
            self.assertEqual((await client.get(url + "/" + child_id, headers=headers)).status_code, 404)
            self.assertEqual((await client.put(url + "/" + child_id, headers=headers,
                                              json=body("intrude", revision=2))).status_code, 404)
            self.assertEqual((await client.delete(url + "/" + child_id, headers=headers)).status_code, 404)
            self.assertEqual((await client.post(url, headers=headers,
                                               json=body("intrude", orgId="org-b"))).status_code, 403)
            self.assertEqual((await client.put(url + "/" + rid,
                                              json=body("move", revision=1, orgId="org-b"))).status_code, 422)
            async with self.sessions() as session:
                session.add(record("historical", archived=True))
                await session.commit()
            current = (await client.get(url)).json()["items"]
            history = (await client.get(url + "?archived=true")).json()["items"]
            self.assertEqual([r["id"] for r in current], [rid])
            self.assertEqual([r["id"] for r in history], ["historical"])
            self.assertEqual((await client.delete(url + "/" + rid)).status_code, 200)
            self.assertEqual((await client.get(url)).json()["items"], [])
            self.assertEqual((await client.get(url + "/historical")).status_code, 200)
            self.assertEqual((await client.get(url + "?orgId=org-b")).json()["items"][0]["id"], child_id)
        async with self.sessions() as session:
            events = list((await session.scalars(select(models.AuditLog))).all())
            self.assertEqual(sorted(row.action for row in events),
                             ["org_memory.create", "org_memory.create", "org_memory.delete", "org_memory.update"])
            self.assertTrue(all(row.actor_id == "super" for row in events))
            self.assertTrue(all(row.target_id in {rid, child_id} for row in events))
            self.assertEqual({row.detail["orgId"] for row in events if row.action == "org_memory.create"},
                             {"org-a", "org-b"})
            self.assertTrue(all(set(row.detail) <= {"orgId", "revision"} for row in events))
            self.assertTrue(all(not row.target_label for row in events))

    async def test_migration_on_the_configured_isolated_engine(self):
        async with self.engine.begin() as connection:
            await connection.run_sync(MemoryRecord.__table__.drop)
            await connection.run_sync(lambda c: OrgMemoryMigrationTests().check_migration(c))


def migration(name):
    path = Path(__file__).parent / "migrations" / "versions" / (name + ".py")
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class OrgMemoryMigrationTests(unittest.TestCase):
    def test_migration_retains_all_content_and_does_not_merge_departments(self):
        engine = create_engine("sqlite:///:memory:")
        with engine.begin() as connection:
            self.check_migration(connection)
        engine.dispose()

    def check_migration(self, connection):
        old = migration("0045_memory_records")
        new = migration("0052_org_memory_singleton")
        with Operations.context(MigrationContext.configure(connection)):
            old.upgrade()
            rows = [
                ("canonical", "org-a", "default", 0, "2026-01-01"),
                ("newer", "org-a", "newer", 0, "2026-09-30"),
                ("old-archive", "org-a", "old", 1, "2026-09-30"),
                ("child-current", "org-b", "child", 0, "2026-09-30"),
                ("child-older", "org-b", "older", 0, "2026-01-01"),
                ("empty-default", "org-c", "default", 1, "2026-09-30"),
                ("active-nondefault", "org-c", "active", 0, "2026-01-01"),
                ("only-archive", "org-d", "default", 1, "2026-09-30"),
            ]
            for rid, org, key, archived, time in rows:
                connection.execute(text(
                    "INSERT INTO memory_record "
                    "(id, scope, owner_user_id, org_id, memory_key, title, summary, fields, source_meta, archived, revision, updated_at) "
                    "VALUES (:id, 'org', '', :org, :key, :id, :id, :fields, :meta, :archived, 7, :time)"
                ).bindparams(bindparam("time", type_=DateTime(timezone=True))),
                    dict(id=rid, org=org, key=key, fields='{"summary":"original"}',
                         meta='{"original":true}', archived=bool(archived),
                         time=datetime.fromisoformat(time).replace(tzinfo=timezone.utc)))
            before = {r["id"]: dict(r) for r in connection.execute(text("SELECT * FROM memory_record")).mappings()}
            new.upgrade()
            after = {r["id"]: dict(r) for r in connection.execute(text("SELECT * FROM memory_record")).mappings()}
            self.assertEqual(set(before), set(after))
            retired = {"newer", "child-older"}
            for rid, original in before.items():
                expected = {**original, "archived": 1, "revision": 8} if rid in retired else original
                self.assertEqual(after[rid], expected)
            self.assertEqual({r["id"] for r in after.values() if not r["archived"]},
                             {"canonical", "child-current", "active-nondefault"})
            with self.assertRaises(IntegrityError):
                with connection.begin_nested():
                    connection.execute(text("UPDATE memory_record SET archived=false WHERE id='newer'"))
            new.downgrade()
            self.assertEqual(connection.execute(text("SELECT archived FROM memory_record WHERE id='newer'")).scalar(), 1)
            new.upgrade()
            self.assertEqual(connection.execute(text("SELECT revision FROM memory_record WHERE id='newer'")).scalar(), 8)


if __name__ == "__main__":
    unittest.main(verbosity=2)
