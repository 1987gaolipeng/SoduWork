"""No-client recovery with isolated storage and controlled external boundaries."""
import asyncio
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import os
import threading
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-cloud-recovery-not-a-real-secret")

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models, automation_models as am
from app.conversation_handoff_models import ConversationHandoff as Handoff
from app.db import Base
from app.services import (ai_exec, ai_remote, artifact_ingest, cloud_conversations, cloud_deliveries, cloud_recovery,
                          code_delivery, conversation_handoffs as handoffs,
                          dispatch_reconcile, execution_settlement, project_context,
                          storage, task_dispatch, terminal_recovery)


class CloudRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="smoke-cloud-recovery-")
        self.engine = create_async_engine("sqlite+aiosqlite:///" + self.temp.name.replace("\\", "/") + "/test.db")
        tables = {model.__table__ for model in (
            models.User, models.Client, models.Task, models.TaskEvent, models.Attachment,
            Handoff, am.ExecutionSession, am.ResourceLease)}
        pending = list(tables)
        while pending:
            for foreign_key in pending.pop().foreign_keys:
                target = foreign_key.column.table
                if target not in tables:
                    tables.add(target)
                    pending.append(target)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda conn: Base.metadata.create_all(conn, tables=list(tables)))
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(cloud_recovery, "SessionLocal", self.sessions))
        self.stack.enter_context(patch.object(terminal_recovery, "SessionLocal", self.sessions))
        self.stack.enter_context(patch.object(handoffs, "destination", AsyncMock(return_value={
            "runnerId": "cloud", "runnerBootId": "boot", "name": "Cloud", "host": "fixture"})))
        self.stack.enter_context(patch.object(handoffs, "targets", AsyncMock(return_value=[{
            "id": "runner:cloud:pi", "runnerId": "cloud", "agentId": "pi"}])))
        async with self.sessions() as session:
            session.add_all([models.User(id="owner", username="owner", is_active=True),
                             models.Client(id="device", user_ref="owner", auth_state="active")])
            await session.commit()

    async def asyncTearDown(self):
        self.stack.close()
        await self.engine.dispose()
        self.temp.cleanup()

    async def seed(self, key="request", *, submitted=True, phase="prepared", event=None, status="todo"):
        async with self.sessions() as session:
            row = Handoff(id=handoffs.identity("device", key), owner_client_id="device", owner_user_id="owner",
                transfer_id=key, task_id="task-" + key, phase=phase, sha256="", request_hash="hash",
                options={"assigneeId": "runner:cloud:pi", "agentId": "pi", "model": "", "instruction": "Work",
                         "inputs": []}, source={"entryKind": "cloud", "sessionId": key},
                submitted_at=datetime.now(timezone.utc) if submitted else None,
                commit_started_at=datetime.now(timezone.utc) - timedelta(minutes=3),
                receipt={"runnerId": "cloud", "runnerBootId": "boot"})
            session.add_all([row, models.Task(id=row.task_id, title="Work", status=status,
                                             origin="cloud-conversation", owner_client_id="device")])
            if event:
                session.add(models.TaskEvent(task_id=row.task_id, kind=event,
                    detail={"attemptId": handoffs.dispatch_id(row), "runnerId": "cloud", "runnerBootId": "boot"}))
            await session.commit()
            return row.id, row.task_id

    async def accepted(self, tid, body, client, session):
        row = await session.scalar(select(Handoff).where(Handoff.task_id == tid))
        ref = "ref-" + tid
        session.add(models.TaskEvent(task_id=tid, kind=ai_exec.EV_DISPATCHED,
                    detail={"attemptId": handoffs.dispatch_id(row), "ref": ref, "runnerId": "cloud"}))
        await session.commit()
        return {"ref": ref, "state": "running"}

    async def test_prepared_is_not_submission_and_public_abort_contract(self):
        draft, _ = await self.seed("draft", submitted=False)
        authorized, _ = await self.seed("submitted")
        dispatch = AsyncMock(side_effect=self.accepted)
        with patch.object(task_dispatch, "dispatch", dispatch):
            out = await cloud_recovery.recover_submissions()
            self.assertEqual(out.get("dispatched"), 1)
            self.assertEqual(dispatch.await_count, 1)
        async with self.sessions() as session:
            original = await session.get(Handoff, draft)
            self.assertEqual(original.phase, "prepared")
            self.assertFalse(handoffs.public(original)["accepted"])
            self.assertTrue(handoffs.public(original)["canAbort"])
            submitted = await session.get(Handoff, authorized)
            self.assertTrue(handoffs.public(submitted)["accepted"])
            self.assertFalse(handoffs.public(submitted)["canAbort"])

    async def test_submit_commit_crash_recovers_without_request_retry(self):
        body = {"sessionId": "new-cloud", "agentId": "pi", "text": "Make a report", "targetRunnerId": "cloud"}
        with patch.object(task_dispatch, "dispatch", AsyncMock(side_effect=asyncio.CancelledError)):
            async with self.sessions() as session:
                client = await session.get(models.Client, "device")
                with self.assertRaises(asyncio.CancelledError):
                    await cloud_conversations.create(session, client, "crashed", body, [])
        row_id = handoffs.identity("device", "crashed")
        async with self.sessions() as session:
            row = await session.get(Handoff, row_id)
            self.assertIsNotNone(row.submitted_at)
            self.assertEqual(row.phase, "committing")
            row.commit_started_at = datetime.now(timezone.utc) - timedelta(minutes=3)
            await session.commit()
        with patch.object(task_dispatch, "dispatch", AsyncMock(side_effect=self.accepted)) as dispatch:
            self.assertEqual((await cloud_recovery.recover_submissions()).get("dispatched"), 1)
            self.assertEqual(dispatch.await_count, 1)
            self.assertEqual((await cloud_recovery.recover_submissions())["candidates"], 0)
        async with self.sessions() as session:
            client = await session.get(models.Client, "device")
            with self.assertRaises(HTTPException) as failure:
                await cloud_conversations.create(session, client, "crashed", {**body, "text": "Different"}, [])
            self.assertEqual(failure.exception.status_code, 409)

    async def test_unconfirmed_started_never_relaunches_after_timeout(self):
        row_id, _ = await self.seed(phase="committing", event=ai_exec.EV_DISPATCH_STARTED)
        async with self.sessions() as session:
            row = await session.get(Handoff, row_id)
            row.commit_started_at = datetime.now(timezone.utc) - timedelta(minutes=15)
            await session.commit()
        with patch.object(dispatch_reconcile, "probe", AsyncMock(return_value={"state": "not-started"})), \
             patch.object(task_dispatch, "dispatch", AsyncMock()) as dispatch:
            out = await cloud_recovery.recover_submissions()
            self.assertEqual(out.get("uncertain"), 1)
            async with self.sessions() as session:
                client = await session.get(models.Client, "device")
                response = await handoffs.commit(session, client, "request", "")
                self.assertEqual(response["phase"], "committing")
            dispatch.assert_not_awaited()
        async with self.sessions() as session:
            row = await session.get(Handoff, row_id)
            self.assertEqual(row.phase, "committing")
            self.assertEqual(row.recovery_attempts, 1)
            self.assertIsNotNone(row.retry_after)
            self.assertIn("不会重复派发", row.error)
        self.assertEqual((await cloud_recovery.recover_submissions())["candidates"], 0)

    async def test_changed_device_owner_blocks_unattended_dispatch(self):
        await self.seed()
        async with self.sessions() as session:
            client = await session.get(models.Client, "device")
            client.user_ref = "another-owner"
            await session.commit()
        with patch.object(task_dispatch, "dispatch", AsyncMock()) as dispatch:
            self.assertEqual((await cloud_recovery.recover_submissions()).get("blocked"), 1)
            dispatch.assert_not_awaited()

    async def test_durable_same_boot_negative_reuses_original_dispatch_identity(self):
        row_id, tid = await self.seed(phase="committing", event=ai_exec.EV_DISPATCH_STARTED)
        with patch.object(dispatch_reconcile, "probe", AsyncMock(return_value={
                "state": "not-started", "admissionDurable": True, "observedBootId": "boot"})), \
             patch.object(task_dispatch, "dispatch", AsyncMock(side_effect=self.accepted)) as dispatch:
            self.assertEqual((await cloud_recovery.recover_submissions()).get("dispatched"), 1)
            self.assertEqual(dispatch.await_count, 1)
        async with self.sessions() as session:
            row = await session.get(Handoff, row_id)
            events = list(await session.scalars(select(models.TaskEvent).where(models.TaskEvent.task_id == tid)))
            self.assertEqual({event.detail["attemptId"] for event in events}, {handoffs.dispatch_id(row)})
            self.assertEqual(row.phase, "committed")

    async def test_two_workers_share_one_durable_claim(self):
        started, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def operation():
            calls.append(1)
            started.set()
            await release.wait()
            return "finished"
        first = asyncio.create_task(cloud_recovery._leased("test", "one", operation))
        await started.wait()
        try:
            second = await cloud_recovery._leased("test", "one", operation)
            self.assertEqual(second, "busy")
            self.assertEqual(calls, [1])
        finally:
            release.set()
            self.assertEqual(await first, "finished")

    async def execution(self, *, settled=True, status="done"):
        _, tid = await self.seed(status=status, phase="committed")
        async with self.sessions() as session:
            meta = {"round": 1}
            if settled:
                meta["terminalSettlement"] = {"state": "done_no_output", "round": 1, "executionState": "done"}
            row = am.ExecutionSession(task_id=tid, ref="execution", state="done", metadata_=meta)
            session.add(row)
            await session.commit()
            return row.id, tid

    async def test_successful_settlement_never_saves_to_library_or_retries_an_old_save_failure(self):
        row_id, tid = await self.execution(status="done")
        async with self.sessions() as session:
            row = await session.get(am.ExecutionSession, row_id)
            await cloud_deliveries._mark(session, row, "failed", error="Previous save failed")
        with patch.object(cloud_deliveries, "archive_task", AsyncMock()) as save:
            self.assertEqual((await cloud_recovery.recover_deliveries()).get("done"), 1)
            self.assertEqual((await cloud_recovery.recover_deliveries())["candidates"], 0)
            save.assert_not_awaited()
        async with self.sessions() as session:
            row = await session.get(am.ExecutionSession, row_id)
            self.assertEqual(row.metadata_["deliverySync"]["state"], "failed")
            self.assertEqual(row.metadata_["terminalRecovery"]["state"], "done")
            self.assertEqual((await session.get(models.Task, tid)).status, "done")

    async def test_missing_terminal_marker_is_reconciled_without_viewer(self):
        row_id, _ = await self.execution(settled=False, status="done")
        with patch.object(ai_exec, "load", AsyncMock(return_value={})), \
             patch.object(ai_exec, "status_sync", return_value={"ok": True, "done": True}), \
             patch.object(code_delivery, "repo_for", AsyncMock(return_value=None)), \
             patch.object(project_context, "record_completion", AsyncMock()):
            self.assertEqual((await cloud_recovery.recover_deliveries()).get("done"), 1)
        async with self.sessions() as session:
            row = await session.get(am.ExecutionSession, row_id)
            self.assertEqual(row.metadata_["terminalSettlement"]["state"], "done_no_output")
            self.assertNotIn("deliverySync", row.metadata_)

    async def test_retry_metadata_cannot_overwrite_new_turn(self):
        row_id, _ = await self.execution()
        async def new_turn(session, *args, **kwargs):
            row = await session.get(am.ExecutionSession, row_id)
            row.metadata_ = {"round": 2, "sentinel": "preserve"}
            row.state = "running"
            await session.commit()
            return {"ok": True}
        with patch.object(execution_settlement, "settle_terminal", new_turn):
            self.assertEqual((await cloud_recovery.recover_deliveries()).get("stale"), 1)
        async with self.sessions() as session:
            row = await session.get(am.ExecutionSession, row_id)
            self.assertEqual(row.metadata_, {"round": 2, "sentinel": "preserve"})
            self.assertEqual(row.state, "running")

    async def test_terminal_rpc_cannot_settle_a_newer_turn(self):
        row_id, tid = await self.execution(settled=False)
        ready, release = asyncio.Event(), threading.Event()
        loop = asyncio.get_running_loop()

        def status(*args):
            loop.call_soon_threadsafe(ready.set)
            if not release.wait(10):
                raise TimeoutError("Fixture release was not signaled")
            return {"ok": True, "done": True}

        with patch.object(ai_exec, "load", AsyncMock(return_value={})), \
             patch.object(ai_exec, "status_sync", status), \
             patch.object(project_context, "record_completion", AsyncMock()) as completion:
            async with self.sessions() as session:
                work = asyncio.create_task(execution_settlement.settle_terminal(
                    session, tid, "execution", include_task=False))
                try:
                    await asyncio.wait_for(ready.wait(), 10)
                    async with self.sessions() as writer:
                        row = await writer.get(am.ExecutionSession, row_id)
                        row.metadata_, row.state = {"round": 2, "sentinel": "preserve"}, "running"
                        await writer.commit()
                finally:
                    release.set()
                self.assertEqual((await work)["reason"], "execution-advanced")
                completion.assert_not_awaited()
        async with self.sessions() as session:
            row = await session.get(am.ExecutionSession, row_id)
            self.assertEqual(row.metadata_, {"round": 2, "sentinel": "preserve"})

    async def test_delivery_rejection_is_visible_and_can_reconcile_without_reexecuting(self):
        row_id, tid = await self.execution(settled=False)
        with patch.object(ai_exec, "load", AsyncMock(return_value={})), \
             patch.object(ai_exec, "status_sync", return_value={"ok": True, "done": True, "attachments": [{"id": "page"}]}), \
             patch.object(ai_exec, "pull_artifacts", AsyncMock(return_value={"submissionError": "交付文件校验未通过"})) as pull, \
             patch.object(project_context, "record_completion", AsyncMock()):
            async with self.sessions() as session:
                blocked = await execution_settlement.settle_terminal(session, tid, "execution", include_task=False)
                self.assertFalse(blocked["ok"])
                self.assertEqual(blocked["settlement"]["state"], "incomplete")
                row = await session.get(am.ExecutionSession, row_id)
                self.assertEqual(row.metadata_["error"], "交付文件校验未通过")
                pull.return_value = {"files": 1}
                recovered = await execution_settlement.settle_terminal(session, tid, "execution", include_task=False)
                self.assertTrue(recovered["ok"])
                self.assertEqual(recovered["settlement"]["state"], "done")
                await session.refresh(row)
                self.assertEqual(row.metadata_["error"], "")
                self.assertEqual(row.state, "done")

    async def test_terminal_callers_commit_one_settlement_and_reload_persisted_receipt(self):
        row_id, tid = await self.execution(settled=False)
        ready, release = asyncio.Event(), threading.Event()
        loop = asyncio.get_running_loop()

        def status(*args):
            loop.call_soon_threadsafe(ready.set)
            if not release.wait(10):
                raise TimeoutError("Fixture release was not signaled")
            return {"ok": True, "done": True}

        with patch.object(ai_exec, "load", AsyncMock(return_value={})), \
             patch.object(ai_exec, "status_sync", side_effect=status) as rpc, \
             patch.object(code_delivery, "repo_for", AsyncMock(return_value=None)), \
             patch.object(project_context, "record_completion", AsyncMock()) as completion, \
             patch.object(cloud_deliveries, "archive_task", AsyncMock()):
            async with self.sessions() as first, self.sessions() as second:
                await second.get(am.ExecutionSession, row_id)
                work = asyncio.create_task(execution_settlement.settle_terminal(
                    first, tid, "execution", include_task=False))
                try:
                    await asyncio.wait_for(ready.wait(), 10)
                    concurrent = asyncio.create_task(execution_settlement.settle_terminal(
                        second, tid, "execution", include_task=False))
                    await asyncio.sleep(0.1)
                finally:
                    release.set()
                results = await asyncio.gather(work, concurrent)
                self.assertTrue(any(result["ok"] for result in results))
                repeated = await execution_settlement.settle_terminal(second, tid, "execution", include_task=False)
                self.assertTrue(repeated["idempotent"])
                self.assertEqual(completion.await_count, 1)

    async def test_unavailable_runner_reconciles_stored_outputs_only_from_the_current_round(self):
        row_id, tid = await self.execution(settled=False)
        async with self.sessions() as session:
            row = await session.get(am.ExecutionSession, row_id)
            row.metadata_ = {"round": 2}
            attachment = models.Attachment(task_id=tid, filename="result.md", content_type="text/markdown",
                storage_key="isolated-result", backend="local", size=10, role="output",
                uploaded_by="agent:runner", source_ref="execution", evidence_meta={"round": 1})
            session.add(attachment)
            await session.commit()
            with patch.object(ai_exec, "load", AsyncMock(return_value={})), \
                 patch.object(ai_exec, "status_sync", return_value={"ok": False, "error": "Runner offline"}), \
                 patch.object(ai_exec, "pull_artifacts", AsyncMock(return_value={"files": 0})) as pull, \
                 patch.object(project_context, "record_completion", AsyncMock()):
                stale = await execution_settlement.settle_terminal(session, tid, "execution", include_task=False)
                self.assertTrue(stale["retry"])
                pull.assert_not_awaited()
                attachment.evidence_meta = {"round": 2}
                await session.commit()
                recovered = await execution_settlement.settle_terminal(session, tid, "execution", include_task=False)
                self.assertTrue(recovered["ok"])
                self.assertEqual(recovered["settlement"]["state"], "done")
                self.assertEqual(pull.await_args.args[3]["round"], 2)
                self.assertTrue(pull.await_args.kwargs["settle"])

    async def artifact_fixture(self):
        _, tid = await self.execution(settled=False)
        async with self.sessions() as session:
            session.add(models.TaskEvent(task_id=tid, kind=ai_exec.EV_DISPATCHED,
                detail={"ref": "execution", "provider": "runner", "runnerId": "cloud"}))
            await session.commit()
        return tid, {"ok": True, "done": True, "round": 1,
                     "attachments": [{"filename": "report.md", "id": "report.md"}]}

    async def test_status_ingestion_and_terminal_settlement_share_durable_file_receipt(self):
        tid, status = await self.artifact_fixture()
        ready, release = asyncio.Event(), threading.Event()
        first_committed = threading.Event()
        fetch_lock = threading.Lock()
        fetch_count = 0
        loop = asyncio.get_running_loop()

        def fetch(*args):
            nonlocal fetch_count
            with fetch_lock:
                fetch_count += 1
                first_fetch = fetch_count == 1
            loop.call_soon_threadsafe(ready.set)
            if not release.wait(10):
                raise TimeoutError("Fixture release was not signaled")
            # This case asserts the status reader imports the file. Keep the
            # terminal reader concurrent, but do not let OS thread scheduling
            # choose the importer whose new-file count is asserted below.
            if not first_fetch and not first_committed.wait(10):
                raise TimeoutError("First ingestion did not commit")
            return b"# Verified report\nComplete result.\n"

        with patch.object(ai_remote, "fetch_attachment_for_sync", side_effect=fetch) as download, \
             patch.object(storage, "put", return_value="fixture"), \
             patch.object(storage, "delete", return_value=None), \
             patch.object(ai_exec, "load", AsyncMock(return_value={})), \
             patch.object(ai_exec, "status_sync", return_value=status), \
             patch.object(code_delivery, "check", AsyncMock(return_value={"applies": True})), \
             patch.object(project_context, "record_completion", AsyncMock()), \
             patch.object(cloud_deliveries, "archive_task", AsyncMock()):
            async with self.sessions() as first, self.sessions() as second:
                one = asyncio.create_task(artifact_ingest.pull_artifacts(
                    first, tid, {}, status, "execution", settle=False))
                await asyncio.wait_for(ready.wait(), 10)
                two = asyncio.create_task(execution_settlement.settle_terminal(
                    second, tid, "execution", include_task=False))
                try:
                    await asyncio.sleep(0.1)
                finally:
                    release.set()
                try:
                    first_result = await one
                finally:
                    first_committed.set()
                self.assertEqual(first_result["files"], 1)
                self.assertTrue((await two)["ok"])
                self.assertIn(download.call_count, (1, 2))
        async with self.sessions() as session:
            files = list(await session.scalars(select(models.Attachment).where(models.Attachment.task_id == tid)))
            self.assertEqual([item.filename for item in files], ["report.md"])

    async def test_lost_ingestion_commit_ack_does_not_create_a_second_attachment(self):
        tid, status = await self.artifact_fixture()
        with patch.object(ai_remote, "fetch_attachment_for_sync", return_value=b"# Report\nComplete.\n") as download, \
             patch.object(storage, "put", return_value="fixture"):
            async with self.sessions() as session:
                original_commit = session.commit

                async def lost_ack():
                    await original_commit()
                    raise ConnectionError("Commit acknowledgement lost")

                with patch.object(session, "commit", side_effect=lost_ack):
                    with self.assertRaises(ConnectionError):
                        await artifact_ingest.pull_artifacts(session, tid, {}, status, "execution", settle=False)
            async with self.sessions() as session:
                retry = await artifact_ingest.pull_artifacts(session, tid, {}, status, "execution", settle=False)
                files = list(await session.scalars(select(models.Attachment).where(models.Attachment.task_id == tid)))
                self.assertEqual(retry["files"], 0)
                self.assertEqual(len(files), 1)
                self.assertEqual(download.call_count, 1)

    async def test_ingestion_preserves_outer_write_transaction_and_storage_failure_rollback(self):
        tid, status = await self.artifact_fixture()
        with patch.object(ai_remote, "fetch_attachment_for_sync", return_value=b"# Report\nComplete.\n"), \
             patch.object(storage, "put", side_effect=[OSError("Object store unavailable"), "fixture"]):
            async with self.sessions() as session:
                task = await session.get(models.Task, tid)
                task.title = "Uncommitted caller intent"
                await session.flush()
                with self.assertRaises(OSError):
                    await asyncio.wait_for(artifact_ingest.pull_artifacts(
                        session, tid, {}, status, "execution", settle=False), 3)
            async with self.sessions() as session:
                task = await session.get(models.Task, tid)
                self.assertEqual(task.title, "Work")
                self.assertEqual((await artifact_ingest.pull_artifacts(
                    session, tid, {}, status, "execution", settle=False))["files"], 1)
                files = list(await session.scalars(select(models.Attachment).where(models.Attachment.task_id == tid)))
                self.assertEqual(len(files), 1)


if __name__ == "__main__":
    unittest.main()
