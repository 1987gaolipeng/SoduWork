"""HTTP regressions for text validation and lossless legacy task replay."""
import unittest

from sqlalchemy import func, select

import test_unified_requirements as fixture
from app import models


class TaskTextCompatibilityTests(unittest.IsolatedAsyncioTestCase):
    # Share only the isolated HTTP/database fixture, not its unrelated test cases.
    asyncSetUp = fixture.UnifiedRequirementTests.asyncSetUp
    asyncTearDown = fixture.UnifiedRequirementTests.asyncTearDown
    call = fixture.UnifiedRequirementTests.call

    async def seed_legacy(self, tid="long-history", *, origin="local"):
        values = {"title": "  " + "\u9700\U0001f680" * 110 + "  ",
                  "source": "\u6765\U0001f30d" * 70, "note": "Historical note"}
        async with self.sessions() as session:
            session.add(models.Task(id=tid, owner_client_id="owner", created_by="owner",
                                    origin=origin, **values))
            await session.commit()
        return values

    async def assert_saved_text(self, tid, values):
        async with self.sessions() as session:
            task = await session.get(models.Task, tid)
            self.assertIsNotNone(task)
            for field in ("title", "source"):
                self.assertEqual(getattr(task, field), values[field], field)
            self.assertEqual(task.owner_client_id, "owner")
            self.assertEqual(task.owner_user_id, "owner")
            self.assertEqual(task.origin, "local")

    def assert_length_error(self, response, field):
        self.assertEqual(response.status_code, 422, response.text)
        errors = response.json()["detail"]
        self.assertTrue(any(error["loc"][-1] == field and
                            error["type"] == "string_too_long" for error in errors), errors)

    async def test_create_length_boundaries_count_unicode_characters(self):
        for symbol in ("x", "\u9700", "\U0001f680"):
            for field, limit in (("title", 200), ("source", 120)):
                for size in (limit - 1, limit, limit + 1):
                    with self.subTest(symbol=symbol, field=field, size=size):
                        payload = {"title": "New task", "source": "Source", field: symbol * size}
                        async with self.sessions() as session:
                            before = await session.scalar(select(func.count()).select_from(models.Task))
                        response = await self.call("POST", "tasks", json=payload)
                        if size > limit:
                            self.assert_length_error(response, field)
                            async with self.sessions() as session:
                                after = await session.scalar(select(func.count()).select_from(models.Task))
                            self.assertEqual(after, before, "Rejected creates must not insert a task")
                        else:
                            self.assertEqual(response.status_code, 200, response.text)
                            self.assertEqual(response.json()[field], payload[field])

    async def test_patch_length_boundaries_do_not_truncate_or_partially_save(self):
        for symbol in ("x", "\u9700", "\U0001f680"):
            for field, limit in (("title", 200), ("source", 120)):
                for size in (limit - 1, limit, limit + 1):
                    with self.subTest(symbol=symbol, field=field, size=size):
                        before = (await self.call("GET", "tasks/private")).json()
                        payload = {field: symbol * size, "note": f"Edit {field}: {size}"}
                        response = await self.call("PATCH", "tasks/private", json=payload)
                        if size > limit:
                            self.assert_length_error(response, field)
                            saved = (await self.call("GET", "tasks/private")).json()
                            self.assertEqual(saved[field], before[field])
                            self.assertEqual(saved["note"], before["note"])
                        else:
                            self.assertEqual(response.status_code, 200, response.text)
                            self.assertEqual(response.json()[field], payload[field])

    async def test_historical_text_can_be_read_and_edited_without_resubmitting_it(self):
        original = await self.seed_legacy()
        detail = await self.call("GET", "tasks/long-history")
        self.assertEqual(detail.status_code, 200, detail.text)
        for field in ("title", "source"):
            self.assertEqual(detail.json()[field], original[field])
        listing = await self.call("GET", "tasks")
        self.assertEqual(listing.status_code, 200, listing.text)
        row = next(row for row in listing.json() if row["id"] == "long-history")
        self.assertEqual(row["title"], original["title"])
        self.assertEqual(row["source"], original["source"])
        response = await self.call("PATCH", "tasks/long-history", json={"note": "Updated note"})
        self.assertEqual(response.status_code, 200, response.text)
        response = await self.call("POST", "tasks/batch-update",
                                   json={"ids": ["long-history", "private"], "patch": {"urgent": True}})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["updated"], 2)
        await self.assert_saved_text("long-history", original)

    async def test_repeated_full_put_preserves_historical_text_and_identity(self):
        original = await self.seed_legacy()
        for attempt in range(2):
            response = await self.call("PUT", "tasks/long-history",
                                       json={**original, "note": f"Replay {attempt}"})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["title"], original["title"])
            self.assertEqual(response.json()["source"], original["source"])
            await self.assert_saved_text("long-history", original)
        async with self.sessions() as session:
            count = await session.scalar(select(func.count()).select_from(models.Task).where(
                models.Task.id == "long-history"))
        self.assertEqual(count, 1)

    async def test_old_offline_create_survives_first_upload_and_replay(self):
        original = {"title": "\U0001f680" * 250, "source": "\u6765\u6e90" * 100,
                    "note": "Created before the Hub upgrade"}
        for _ in range(2):
            response = await self.call("PUT", "tasks/offline-history", json=original)
            self.assertEqual(response.status_code, 200, response.text)
            await self.assert_saved_text("offline-history", original)

    async def test_undo_after_confirmed_delete_recreates_complete_legacy_text(self):
        original = await self.seed_legacy()
        deleted = await self.call("DELETE", "tasks/long-history")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual((await self.call("GET", "tasks/long-history")).status_code, 404)
        restored = await self.call("PUT", "tasks/long-history", json=original)
        self.assertEqual(restored.status_code, 200, restored.text)
        await self.assert_saved_text("long-history", original)
        read = await self.call("GET", "tasks/long-history")
        self.assertEqual(read.status_code, 200, read.text)
        self.assertEqual(read.json()["title"], original["title"])
        self.assertEqual(read.json()["source"], original["source"])

    async def test_invalid_batch_is_rejected_before_any_row_is_updated(self):
        original = await self.seed_legacy()
        for field, size in (("title", 201), ("source", 121)):
            response = await self.call("POST", "tasks/batch-update", json={
                "ids": ["private", "long-history"],
                "patch": {field: "x" * size, "note": "Must not be partially saved"},
            })
            self.assert_length_error(response, field)
            async with self.sessions() as session:
                self.assertEqual((await session.get(models.Task, "private")).note, "private note")
                self.assertEqual((await session.get(models.Task, "long-history")).note, original["note"])
            await self.assert_saved_text("long-history", original)

    async def test_replay_cannot_overwrite_another_account_or_managed_task(self):
        original = await self.seed_legacy()
        for who in ("peer", "outsider"):
            response = await self.call("PUT", "tasks/long-history", who,
                                       json={**original, "note": "Unauthorized edit"})
            self.assertEqual(response.status_code, 404, response.text)
        managed = await self.seed_legacy("managed-history", origin="dispatch")
        response = await self.call("PUT", "tasks/managed-history", json={**managed, "note": "Overwrite"})
        self.assertEqual(response.status_code, 409, response.text)
        async with self.sessions() as session:
            task = await session.get(models.Task, "managed-history")
            self.assertEqual(task.origin, "dispatch")
            self.assertEqual(task.note, managed["note"])
            task = await session.get(models.Task, "long-history")
            self.assertEqual(task.note, original["note"])
        await self.assert_saved_text("long-history", original)

    async def test_same_account_other_device_cannot_take_over_replay(self):
        original = await self.seed_legacy()
        async with self.sessions() as session:
            self.clients["second"] = models.Client(id="second-device", user_ref="owner", auth_state="active")
            session.add(self.clients["second"])
            await session.commit()
        response = await self.call("PUT", "tasks/long-history", "second", json=original)
        self.assertEqual(response.status_code, 409, response.text)
        await self.assert_saved_text("long-history", original)

    async def test_device_account_switch_does_not_reassign_historical_work(self):
        original = await self.seed_legacy()
        async with self.sessions() as session:
            device = await session.get(models.Client, "owner")
            device.user_ref = "outsider"
            await session.commit()
        self.clients["owner"].user_ref = "outsider"
        response = await self.call("PUT", "tasks/long-history", json=original)
        self.assertEqual(response.status_code, 404, response.text)
        await self.assert_saved_text("long-history", original)


if __name__ == "__main__":
    unittest.main()
