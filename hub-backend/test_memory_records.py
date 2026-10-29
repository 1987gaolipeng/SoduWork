"""Isolated SQLite checks for the scoped summary memory service.

Run directly (``python test_memory_records.py``); this module never points at a
configured Hub database.
"""
import os
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
os.environ["AUTH_SECRET"] = "memory-record-test-signing-key-not-for-production"

import unittest
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from app import models
from app.db import Base
from app.memory_record_models import MemoryRecord
from app.services import memory_records as svc


class MemoryRecordTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(lambda c: (models.OrgUnit.__table__.create(c), models.User.__table__.create(c),
                                          MemoryRecord.__table__.create(c), models.AppSetting.__table__.create(c),
                                          models.Task.__table__.create(c)))
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.sessions() as session:
            session.add(models.OrgUnit(id="org-a", name="测试组织"))
            session.add_all([
                models.User(id="user-a", username="memory-a", org_id="org-a", is_super=True, is_active=True),
                models.User(id="user-b", username="memory-b", org_id="org-a", is_active=True),
            ])
            await session.commit()
        self.client_a = SimpleNamespace(user_ref="user-a")
        self.client_b = SimpleNamespace(user_ref="user-b")

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_upsert_and_context_are_owner_scoped(self):
        async with self.sessions() as session:
            body = svc.MemoryWrite.model_validate({
                "scope": "workspace", "key": "workspace-hash", "workspaceKey": "workspace-hash",
                "title": "Workspace", "fields": {"summary": "first"}, "confirmed": True,
            })
            first = await svc.create(session, self.client_a, body)
            second = await svc.create(session, self.client_a, body.model_copy(update={
                "fields": {"summary": "second"}, "title": "Workspace 2",
            }))
            self.assertFalse(first["updated"])
            self.assertTrue(second["updated"])
            self.assertEqual(second["item"]["revision"], 2)
            edited = await svc.edit(session, self.client_a, second["item"]["id"], svc.MemoryPatch.model_validate({
                "title": "Manual", "fields": {"summary": "human-approved"},
                "confirmed": True, "revision": 2,
            }))
            preserved = await svc.create(session, self.client_a, body.model_copy(update={
                "fields": {"summary": "automatic-later"}, "title": "Automatic later",
                "source_session_id": "chat-auto", "source_hash": "hash-auto",
            }))
            self.assertFalse(preserved["updated"])
            self.assertEqual(preserved["item"]["fields"]["summary"], "human-approved")
            self.assertTrue(edited["item"]["sourceMeta"]["manual"])
            self.assertEqual(preserved["item"]["revision"], edited["item"]["revision"])
            manual = await svc.create(session, self.client_a, body.model_copy(update={
                "fields": {"summary": "explicit-replacement"}, "title": "Explicit replacement",
            }))
            self.assertTrue(manual["updated"])
            self.assertEqual(manual["item"]["fields"]["summary"], "explicit-replacement")
            data = await svc.context(session, self.client_a, [{
                "scope": "workspace", "key": "workspace-hash", "workspaceKey": "workspace-hash",
            }], [])
            self.assertEqual([item["key"] for item in data["items"]], ["workspace-hash"])
            foreign = await svc.context(session, self.client_b, [{
                "scope": "workspace", "key": "workspace-hash", "workspaceKey": "workspace-hash",
            }], [])
            self.assertEqual(foreign["items"], [])

            session.add(MemoryRecord(
                id="org-memory", scope="org", owner_user_id="", org_id="org-a",
                memory_key="org-key", title="Organization", summary="private",
                fields={"summary": "private"}, source_meta={}, archived=False, revision=1,
            ))
            await session.commit()
            listed = await svc.listing(session, self.client_a)
            self.assertEqual([item["key"] for item in listed["items"]], ["workspace-hash"])
            with self.assertRaises(Exception):
                await svc.context(session, self.client_a, [], ["org-memory"])

    async def test_delete_is_owner_scoped(self):
        async with self.sessions() as session:
            body = svc.MemoryWrite.model_validate({
                "scope": "session", "key": "session-hash", "title": "Session",
                "fields": {"summary": "forget me"}, "confirmed": True,
            })
            created = await svc.create(session, self.client_a, body)
            rid = created["item"]["id"]
            with self.assertRaises(Exception):
                await svc.delete(session, self.client_b, rid)
            result = await svc.delete(session, self.client_a, rid)
            self.assertEqual(result, {"ok": True})
            with self.assertRaises(Exception):
                await svc.get(session, self.client_a, rid)

    async def test_scope_requires_opaque_key(self):
        with self.assertRaises(Exception):
            svc._scope_key("workspace", "C:/Users/admin/project", "", "")

    async def test_organization_memory_is_one_logical_upsert(self):
        async with self.sessions() as session:
            first = await svc.org_create(session, await session.get(models.User, "user-a"), {
                "orgId": "org-a", "key": "legacy-title", "title": "组织规范",
                "fields": {"summary": "第一版规范"}, "confirmed": True,
            })
            second = await svc.org_create(session, await session.get(models.User, "user-a"), {
                "orgId": "org-a", "key": "another-title", "title": "组织规范 2",
                "fields": {"summary": "第二版规范"}, "confirmed": True, "revision": 1,
                "id": first["item"]["id"],
            })
            self.assertFalse(first["updated"])
            self.assertTrue(second["updated"])
            self.assertEqual(second["item"]["key"], svc.ORG_MEMORY_KEY)
            self.assertEqual(second["item"]["revision"], 2)
            listed = await svc.org_listing(session, await session.get(models.User, "user-a"), "org-a")
            self.assertEqual(len(listed["items"]), 1)
            self.assertEqual(listed["items"][0]["summary"], "第二版规范")

            # A malformed legacy row with an owner is not organization memory;
            # it must never appear in the admin singleton view.
            session.add(MemoryRecord(
                id="owned-org-memory", scope="org", owner_user_id="user-a", org_id="org-a",
                memory_key=svc.ORG_MEMORY_KEY, title="错误归属", summary="不应展示",
                fields={"summary": "不应展示"}, source_meta={}, archived=False, revision=1,
            ))
            await session.commit()
            listed = await svc.org_listing(session, await session.get(models.User, "user-a"), "org-a")
            self.assertEqual(len(listed["items"]), 1)
            self.assertEqual(listed["items"][0]["summary"], "第二版规范")

            # A legacy row with a different key remains physically recoverable,
            # but can never create a second visible organization memory.
            session.add(MemoryRecord(
                id="legacy-org-memory", scope="org", owner_user_id="", org_id="org-a",
                memory_key="old-key", title="旧记录", summary="旧内容",
                fields={"summary": "旧内容"}, source_meta={}, archived=True, revision=1,
            ))
            await session.commit()
            listed = await svc.org_listing(session, await session.get(models.User, "user-a"), "org-a")
            self.assertEqual(len(listed["items"]), 1)
            self.assertEqual(listed["items"][0]["key"], svc.ORG_MEMORY_KEY)
            third = await svc.org_create(session, await session.get(models.User, "user-a"), {
                "orgId": "org-a", "key": "ignored-again", "title": "组织规范 3",
                "fields": {"summary": "第三版规范"}, "confirmed": True, "revision": 2,
                "id": second["item"]["id"],
            })
            self.assertTrue(third["updated"])
            legacy = await session.get(MemoryRecord, "legacy-org-memory")
            self.assertTrue(legacy.archived)



    async def test_automatic_duplicate_and_backfill_preserve_current_record(self):
        async with self.sessions() as session:
            body = svc.MemoryWrite.model_validate({
                "scope": "session", "key": "auto-session", "title": "Automatic",
                "fields": {"summary": "new result"}, "sourceSessionId": "chat-new",
                "sourceHash": "hash-new", "confirmed": True,
            })
            first = await svc.create(session, self.client_a, body)
            repeated = await svc.create(session, self.client_a, body)
            self.assertFalse(repeated["updated"])
            self.assertEqual(repeated["item"], first["item"])
            older = await svc.create(session, self.client_a, body.model_copy(update={
                "source_session_id": "chat-old", "source_hash": "hash-old",
                "fields": {"summary": "old result"}, "backfill": True,
            }))
            self.assertFalse(older["updated"])
            self.assertEqual(older["item"], first["item"])
            missing = await svc.create(session, self.client_a, body.model_copy(update={
                "key": "backfill-missing", "backfill": True,
            }))
            self.assertFalse(missing["updated"])
            self.assertEqual(missing["item"]["fields"]["summary"], "new result")

    async def test_shared_automatic_sources_are_bounded_and_update_in_place(self):
        async with self.sessions() as session:
            for scope in ("workspace", "project"):
                with self.subTest(scope=scope):
                    body = svc.MemoryWrite.model_validate({
                        "scope": scope, "key": scope + "-automatic", "title": "Automatic",
                        "fields": {"summary": "initial"}, "sourceSessionId": "chat-0",
                        "sourceHash": "hash-0", "confirmed": True,
                    })
                    for index in range(10):
                        result = await svc.create(session, self.client_a, body.model_copy(update={
                            "source_session_id": "chat-" + str(index),
                            "source_hash": "hash-" + str(index),
                            "fields": {"summary": "result-" + str(index) + ":" + "x" * 700},
                        }))
                    sources = result["item"]["sourceMeta"]["sources"]
                    self.assertEqual([item["sourceSessionId"] for item in sources],
                                     ["chat-" + str(index) for index in range(2, 10)])
                    self.assertTrue(all(len(item["summary"]) <= 600 for item in sources))
                    self.assertLessEqual(len(result["item"]["summary"]), 6000)
                    self.assertEqual(result["item"]["fields"]["summary"], result["item"]["summary"])
                    self.assertIn("result-2:", result["item"]["summary"])
                    self.assertIn("result-9:", result["item"]["summary"])
                    updated = await svc.create(session, self.client_a, body.model_copy(update={
                        "source_session_id": "chat-4", "source_hash": "hash-4-new",
                        "fields": {"summary": "four revised"},
                    }))
                    sources = updated["item"]["sourceMeta"]["sources"]
                    self.assertEqual(len(sources), 8)
                    self.assertEqual(sources[-1]["sourceSessionId"], "chat-4")
                    self.assertEqual(sources[-1]["summary"], "four revised")
                    self.assertNotIn("result-4:", updated["item"]["summary"])
                    repeated = await svc.create(session, self.client_a, body.model_copy(update={
                        "source_session_id": "chat-3", "source_hash": "hash-3",
                        "fields": {"summary": "result-3:" + "x" * 700},
                    }))
                    self.assertFalse(repeated["updated"])
                    self.assertEqual(repeated["item"], updated["item"])

    async def test_backfill_cannot_replace_shared_or_manually_created_memory(self):
        async with self.sessions() as session:
            for scope in ("workspace", "project"):
                with self.subTest(scope=scope):
                    body = svc.MemoryWrite.model_validate({
                        "scope": scope, "key": scope + "-manual", "title": "Manual",
                        "fields": {"summary": "approved"}, "confirmed": True,
                    })
                    first = await svc.create(session, self.client_a, body)
                    self.assertTrue(first["item"]["sourceMeta"]["manual"])
                    automatic = body.model_copy(update={
                        "source_session_id": "old-chat", "source_hash": "old-hash",
                        "fields": {"summary": "unapproved"}, "title": "Automatic",
                    })
                    blocked = await svc.create(session, self.client_a, automatic)
                    self.assertEqual(blocked["item"], first["item"])
                    replacement = await svc.create(session, self.client_a, body.model_copy(update={
                        "title": "Replacement", "fields": {"summary": "explicit"},
                    }))
                    self.assertTrue(replacement["updated"])
                    backfill = await svc.create(session, self.client_a, automatic.model_copy(update={
                        "backfill": True,
                    }))
                    self.assertEqual(backfill["item"], replacement["item"])

    async def test_legacy_shared_source_is_retained_and_context_avoids_duplicates(self):
        async with self.sessions() as session:
            legacy = MemoryRecord(
                scope="workspace", owner_user_id="user-a", org_id="org-a", memory_key="legacy",
                workspace_key="legacy", title="Legacy", summary="previous result",
                fields={"summary": "previous result"},
                source_meta={"sourceSessionId": "old-chat", "sourceHash": "old-hash"},
                archived=False, revision=1,
            )
            session.add(legacy)
            await session.commit()
            result = await svc.create(session, self.client_a, svc.MemoryWrite.model_validate({
                "scope": "workspace", "key": "legacy", "title": "New",
                "fields": {"summary": "current result"}, "sourceSessionId": "new-chat",
                "sourceHash": "new-hash", "confirmed": True,
            }))
            sources = result["item"]["sourceMeta"]["sources"]
            self.assertEqual([item["summary"] for item in sources],
                             ["previous result", "current result"])
            data = await svc.context(session, self.client_a, [{"scope": "workspace", "key": "legacy"}])
            self.assertEqual(data["prompt"].count("previous result"), 1)
            self.assertEqual(data["prompt"].count("current result"), 1)
            self.assertEqual(data["items"][0]["sourceMeta"]["sources"], sources)

    async def test_session_automatic_summary_is_not_shortened_for_aggregation(self):
        async with self.sessions() as session:
            text = "full session result " * 100
            result = await svc.create(session, self.client_a, svc.MemoryWrite.model_validate({
                "scope": "session", "key": "long-session", "title": "Session",
                "fields": {"summary": text}, "sourceSessionId": "chat-long",
                "sourceHash": "hash-long", "confirmed": True,
            }))
            self.assertEqual(result["item"]["summary"], text.strip())
            self.assertNotIn("sources", result["item"]["sourceMeta"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
