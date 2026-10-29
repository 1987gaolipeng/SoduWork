"""Missing telemetry pages cannot finalize an IM reply until authorized archive repair."""
import asyncio
import json
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy import func, select, update

from im_test_support import IMFixture
from app import automation_models as am, im_models as im, models
from app.api import runner_ws
from app.services import ai_local, execution_sessions, im_archive, im_execution, im_worker, local_base
from runner_main import Runner


class IMArchiveTests(IMFixture, unittest.IsolatedAsyncioTestCase):
    async def admitted(self):
        self.ref = "im-archive-fixture"
        async with self.sessions() as session:
            row = await session.get(am.ExecutionSession, "im-session")
            row.ref = self.ref
            event = (await session.scalars(select(models.TaskEvent))).one()
            event.detail = {**event.detail, "ref": self.ref}
            await session.commit()
        identifier, credentials = await self.connection()
        await self.pair(identifier, credentials)
        await self.incoming(identifier, credentials, "Return the complete result", 2)
        await im_worker.process_route(self.sessions, self.task.id)
        async with self.sessions() as session:
            inbox = (await session.scalars(select(im.IMInbox).where(im.IMInbox.event_id == "2"))).one()
            self.assertEqual(inbox.status, "waiting")
            self.inbox_id, self.key = inbox.id, inbox.admission_key

    async def objects(self, session):
        inbox = await session.get(im.IMInbox, self.inbox_id)
        binding = await session.get(im.IMBinding, inbox.binding_id)
        row = await session.get(am.ExecutionSession, "im-session")
        return row, inbox, binding

    async def partial(self, session):
        await execution_sessions.ingest_runner_snapshots(session, self.live, [{
            "ref": self.ref, "taskId": self.task.id, "state": "done", "seq": 4, "round": 2,
            "admissionKey": self.key, "turnCorrelationVersion": 1,
            "items": [{"seq": 3, "kind": "say", "text": "TAIL", "admissionKey": self.key},
                {"seq": 4, "kind": "turn-end", "turnState": "done", "text": "",
                    "admissionKey": self.key, "admissionStartSeq": 1}]}])
        await session.commit()

    async def test_real_dropped_heartbeat_page_is_repaired_without_adopting_later_desktop_turn(self):
        await self.admitted()
        run = {"state": "running", "round": 2, "segment": 1, "seq": 1, "lines": [],
            "admissionKey": self.key, "admissionStartSeq": 1, "taskId": self.task.id,
            "cli": "pi", "ws": self.temp.name}
        with patch.object(local_base, "_STORE", self.temp.name), patch.dict(local_base._RUNS, {self.ref: run}, clear=True):
            local_base._record_event(self.ref, {"kind": "say", "text": "IMPORTANT FIRST PART"})
            for _ in range(299):
                local_base._record_event(self.ref, {"kind": "tool", "text": "progress"})
            local_base._record_event(self.ref, {"kind": "say", "text": "LAST PART"})
            run["state"] = "done"
            local_base._save_meta(self.ref)
            boundary = run["seq"]
            machine = object.__new__(Runner)
            machine._agent_inventory, machine._session_marks = [], {}
            first, advances = machine._session_snapshots()
            queue = asyncio.Queue(maxsize=1)
            queue.put_nowait(([], []))
            runner_ws._enqueue_telemetry(queue, (first, []))
            self.assertEqual(queue.get_nowait(), ([], []))
            machine._apply_marks(advances)
            run.update(state="running", round=3, admissionKey="comment:private-desktop", admissionStartSeq=boundary)
            local_base._record_event(self.ref, {"kind": "say", "text": "PRIVATE DESKTOP"})
            second, advances = machine._session_snapshots()
            machine._apply_marks(advances)
            async with self.sessions() as session:
                await execution_sessions.ingest_runner_snapshots(session, self.live, second)
                await session.commit()
                row, inbox, _ = await self.objects(session)
                self.assertIsNone(await im_execution.final_text(session, row, inbox))
            self.assertFalse(machine._session_snapshots()[0], "sent marks alone cannot repair the dropped page")
            async def archived(operation, packet, timeout):
                self.assertEqual((operation, packet["ref"], timeout), ("job.session", self.ref, 15))
                self.assertLessEqual(packet["limit"], im_archive.PAGE_SIZE)
                data = ai_local.session_sync({}, packet["ref"], packet["since"], packet["limit"])
                self.assertEqual(data["admissionKey"], "comment:private-desktop")
                return {"ok": True, "data": data}
            self.live.call = AsyncMock(side_effect=archived)
            pages = (300 + im_archive.PAGE_SIZE - 1) // im_archive.PAGE_SIZE
            for page in range(pages):
                await self.ready()
                await im_worker.process_route(self.sessions, self.task.id)
                async with self.sessions() as session:
                    row, inbox, _ = await self.objects(session)
                    self.assertEqual(inbox.status, "done" if page == pages - 1 else "waiting")
                    self.assertEqual(row.state, "running")
                    self.assertEqual(row.metadata_["admissionKey"], "comment:private-desktop")
                    replies = list((await session.scalars(select(im.IMOutbox).where(
                        im.IMOutbox.inbox_id == inbox.id, im.IMOutbox.kind == "done"))).all())
                    if page < pages - 1:
                        self.assertEqual(replies, [])
                    else:
                        self.assertEqual("".join(item.text for item in replies), "IMPORTANT FIRST PART\n\nLAST PART")
            self.assertEqual(self.live.call.await_count, pages)
            self.assertEqual(len(self.submitted), 1, "archive recovery must never replay execution")

    async def test_lost_entire_terminal_page_recovers_from_disk_after_a_later_turn(self):
        await self.admitted()
        run = {"state": "running", "round": 2, "segment": 1, "seq": 1, "lines": [],
            "admissionKey": "comment:older-desktop", "admissionStartSeq": 0, "taskId": self.task.id,
            "cli": "pi", "ws": self.temp.name}
        with patch.object(local_base, "_STORE", self.temp.name), patch.dict(local_base._RUNS, {self.ref: run}, clear=True):
            for _ in range(39):
                local_base._record_event(self.ref, {"kind": "tool", "text": "OLDER PRIVATE HISTORY"})
            run["state"] = "done"
            local_base._save_meta(self.ref)
            run.update(state="running", admissionKey=self.key, admissionStartSeq=run["seq"])
            local_base._record_event(self.ref, {"kind": "say", "text": "COMPLETE MOBILE ANSWER"})
            run["state"] = "done"
            local_base._save_meta(self.ref)
            machine = object.__new__(Runner)
            machine._agent_inventory, machine._session_marks = [], {}
            lost, advances = machine._session_snapshots()
            queue = asyncio.Queue(maxsize=1)
            queue.put_nowait(([], []))
            runner_ws._enqueue_telemetry(queue, (lost, []))
            machine._apply_marks(advances)
            run.update(state="running", round=3, admissionKey="comment:later-desktop", admissionStartSeq=run["seq"])
            local_base._record_event(self.ref, {"kind": "say", "text": "PRIVATE DESKTOP"})
            later, advances = machine._session_snapshots()
            machine._apply_marks(advances)
            async with self.sessions() as session:
                await execution_sessions.ingest_runner_snapshots(session, self.live, later)
                await session.commit()
                self.assertEqual(await session.scalar(select(func.count()).select_from(am.ExecutionEvent).where(
                    am.ExecutionEvent.kind == "turn-end")), 0)
            # Rehydrate metadata without its memory buffer so RPC must read events.jsonl.
            stored = json.loads(Path(local_base._store_dir(self.ref), "meta.json").read_text(encoding="utf-8"))
            local_base._RUNS[self.ref] = stored
            async def archived(operation, packet, timeout):
                return {"ok": True, "data": ai_local.session_sync({}, packet["ref"], packet["since"], packet["limit"])}
            self.live.call = AsyncMock(side_effect=archived)
            for expected in ("waiting", "waiting", "done"):
                await self.ready()
                await im_worker.process_route(self.sessions, self.task.id)
                async with self.sessions() as session:
                    row, inbox, _ = await self.objects(session)
                    self.assertEqual(inbox.status, expected)
                    self.assertEqual((row.state, row.metadata_["admissionKey"]), ("running", "comment:later-desktop"))
                    if expected == "done":
                        reply = (await session.scalars(select(im.IMOutbox).where(im.IMOutbox.kind == "done"))).one()
                        self.assertEqual(reply.text, "COMPLETE MOBILE ANSWER")
            self.assertEqual(self.live.call.await_count, 2)
            self.assertEqual(len(self.submitted), 1)

    async def test_wrong_response_scope_and_revocation_cannot_fill_a_gap(self):
        await self.admitted()
        async with self.sessions() as session:
            await self.partial(session)
            row, inbox, binding = await self.objects(session)
            correct = {"ok": True, "ref": self.ref, "taskId": self.task.id,
                "items": [{"seq": 2, "kind": "say", "text": "HEAD", "admissionKey": self.key}]}
            variants = [{**correct, "ref": "foreign-ref"}, {**correct, "taskId": "im-foreign-task"},
                {**correct, "items": [{**correct["items"][0], "admissionKey": "comment:foreign"}]},
                {**correct, "items": [{**correct["items"][0], "seq": 3}]},
                {**correct, "items": []}, {**correct, "items": correct["items"] * 4}]
            for data in variants:
                with self.subTest(response=data):
                    self.live.call = AsyncMock(return_value={"ok": True, "data": data})
                    self.assertIsNone(await im_execution.final_text(session, row, inbox, binding))
                    self.assertEqual(await session.scalar(select(func.count()).select_from(am.ExecutionEvent)), 2)
            async def revoked(*args, **kwargs):
                async with self.sessions() as changed:
                    await changed.execute(update(im.IMBinding).where(im.IMBinding.id == binding.id).values(enabled=False))
                    await changed.commit()
                return {"ok": True, "data": correct}
            self.live.call = AsyncMock(side_effect=revoked)
            self.assertIsNone(await im_execution.final_text(session, row, inbox, binding))
            self.assertEqual(await session.scalar(select(func.count()).select_from(am.ExecutionEvent)), 2)

    async def test_unavailable_archive_waits_and_old_terminal_boundary_is_never_guessed(self):
        await self.admitted()
        async with self.sessions() as session:
            await self.partial(session)
        self.live.call = AsyncMock(side_effect=TimeoutError("isolated timeout"))
        await self.ready()
        await im_worker.process_route(self.sessions, self.task.id)
        async with self.sessions() as session:
            row, inbox, binding = await self.objects(session)
            self.assertEqual(inbox.status, "waiting")
            self.assertEqual(await session.scalar(select(func.count()).select_from(im.IMOutbox).where(im.IMOutbox.kind == "done")), 0)
            terminal = (await session.scalars(select(am.ExecutionEvent).where(am.ExecutionEvent.kind == "turn-end"))).one()
            terminal.detail = {key: value for key, value in terminal.detail.items() if key != "admissionStartSeq"}
            await session.commit()
            self.live.call.reset_mock()
            with self.assertRaises(HTTPException):
                await im_execution.final_text(session, row, inbox, binding)
            self.live.call.assert_not_awaited()
        await self.ready()
        await im_worker.process_route(self.sessions, self.task.id)
        async with self.sessions() as session:
            self.assertEqual((await session.get(im.IMInbox, self.inbox_id)).status, "uncertain")


if __name__ == "__main__":
    unittest.main()
