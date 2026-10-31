"""User requirements survive persistence and dispatch, or fail explicitly before execution."""
import os
import unittest

os.environ.setdefault("AUTH_SECRET", "isolated-automation-long-instruction-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-automation-long-instruction-admin")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app import models
from app.api import tasks as api
from app.services import schedule_conversations, schedule_run_contracts, task_requirements


class AutomationLongInstructionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.addAsyncCleanup(self.engine.dispose)
        async with self.engine.begin() as conn:
            for table in (models.Client.__table__, models.AiSchedule.__table__, models.AiScheduleRun.__table__):
                await conn.run_sync(table.create)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.addAsyncCleanup(self.session.close)
        self.client = models.Client(id="audit-device", name="isolated", config={"automationConversationV1": 1})
        self.session.add(self.client)
        await self.session.commit()

    async def create(self, **changes):
        body = {"title": "Long instruction", "note": "initial", "every": "daily",
                "assigneeId": "local:pi", "personalPluginKey": "audit-method", "requiredCapabilities": []}
        body.update(changes)
        return await api.create_my_schedule(body, self.client, self.session)

    async def test_saved_and_updated_long_note_reaches_execution_envelope(self):
        text = "执行说明。" * 4000 + "TAIL: do not publish"
        parameter_tail = "TAIL: keep exact CSV order"
        parameter = "x" * (8000 - len(parameter_tail)) + parameter_tail
        created = await self.create(note=text, pluginInputs={"goal": parameter})
        self.assertEqual(created["note"], text)
        self.assertEqual(created["pluginInputs"]["goal"], parameter)
        sid = created["id"]
        self.session.expire_all()
        saved = await self.session.get(models.AiSchedule, sid)
        self.assertEqual(saved.note, text)
        run = models.AiScheduleRun(id="audit-run", schedule_id=sid, owner_client_id="audit-device")
        self.session.add(run)
        await self.session.commit()
        self.client = await self.session.get(models.Client, "audit-device")
        await schedule_conversations.prepare(self.session, saved, self.client, None, run.id, "pi", {})
        dispatched = run.receipt["conversationInput"]["text"]
        self.assertEqual(run.receipt["conversationInput"]["personalPlugin"], {
            "key": "audit-method", "versionPolicy": "latest",
            "version": "", "checksum": "",
        })
        self.assertIn(text, dispatched)
        self.assertIn(parameter, dispatched)
        changed = text + "\nUPDATE: never delete source data"
        updated = await api.update_my_schedule(sid, {"note": changed}, self.client, self.session)
        self.assertEqual(updated["note"], changed)

    async def test_oversized_schedule_note_is_rejected_not_saved_as_prefix(self):
        with self.assertRaises(HTTPException) as raised:
            await self.create(note="x" * 50001)
        self.assertEqual(raised.exception.status_code, 422)

    async def test_oversized_plugin_input_is_rejected_by_save_and_update(self):
        with self.assertRaises(HTTPException) as raised:
            await self.create(pluginInputs={"goal": "x" * 8001})
        self.assertEqual(raised.exception.status_code, 400)
        created = await self.create(pluginInputs={"goal": "original"})
        with self.assertRaises(HTTPException) as raised:
            await api.update_my_schedule(created["id"], {"pluginInputs": {"goal": "x" * 8001}}, self.client, self.session)
        self.assertEqual(raised.exception.status_code, 400)
        await self.session.rollback()
        saved = await self.session.get(models.AiSchedule, created["id"])
        self.assertEqual(saved.plugin_inputs, {"goal": "original"})

    async def test_too_many_plugin_inputs_are_rejected_instead_of_dropped(self):
        with self.assertRaises(ValueError):
            schedule_run_contracts.clean_plugin_inputs({"field" + str(i): i for i in range(51)})

    async def test_oversized_acceptance_item_is_rejected_instead_of_shortened(self):
        task = models.Task(acceptance_criteria=["existing"])
        text = "x" * 1000 + "TAIL: do not overwrite existing output"
        with self.assertRaises(HTTPException) as raised:
            await task_requirements.apply(None, None, task, {"acceptanceCriteria": [text]}, creating=True)
        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(task.acceptance_criteria, ["existing"])


if __name__ == "__main__":
    unittest.main()
