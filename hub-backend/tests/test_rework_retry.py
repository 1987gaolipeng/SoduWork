"""Automatic rework redelivery contracts: persist intent, reuse a deterministic turnId for Runner
deduplication, and retry RUNNER_OFFLINE failures with backoff. Expose non-retryable, exhausted,
and workflow-owned outcomes explicitly; stop redelivery after human takeover to prevent parallel
execution.
"""

import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.db import Base
from app.services import task_rework


def _now():
    return datetime.now(timezone.utc)


class ReworkRetryTests(unittest.IsolatedAsyncioTestCase):
    """Verify due retries, backoff, terminal outcomes, and mutual exclusion with human takeover."""

    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add(models.User(id="u-owner", username="rework-owner"))
            session.add(models.Client(id="dev-1", user_ref="u-owner"))
            await session.commit()

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def _task_with_pending_card(self, session, *, task_id="rework-task",
                                      ref="runner:sid-1", attempts=1,
                                      next_in_seconds=0, state="pending",
                                      feedback="改一下配色", status="doing"):
        task = models.Task(id=task_id, title="中医知识展示网页", status=status,
                           owner_client_id="dev-1",
                           work_routing={"reworkPending": {
                               "feedback": feedback, "ref": ref,
                               "requestId": "req-1", "versionId": "ver-1",
                               "actor": "王振义", "error": "这条活所在的执行机不在线",
                               "at": _now().isoformat(),
                               "attempts": attempts, "maxAttempts": task_rework._MAX_ATTEMPTS,
                               "messageId": task_rework._message_id("req-1"),
                               "state": state,
                               **({"nextAttemptAt": (_now() + timedelta(seconds=next_in_seconds)).isoformat()}
                                  if next_in_seconds is not None else {}),
                           }})
        session.add(task)
        session.add(models.TaskEvent(
            id=f"anchor-{task_id}", task_id=task_id, kind="ai.rework_pending",
            detail={"requestId": "req-1"}, at=_now()))
        artifact = am.ArtifactVersion(
            id="ver-1", task_id=task_id, kind="files", state="rejected",
            source_ref=ref, seq=1, checksum="fix", created_at=_now())
        session.add(artifact)
        await session.commit()
        return task

    async def test_runner_offline_schedules_backoff(self):
        """An offline Runner creates a pending card with backoff and a deterministic messageId."""
        async with self.sessions() as session:
            task = models.Task(id="t-off", title="离线返修", status="doing",
                               owner_client_id="dev-1", work_routing={})
            session.add(task)
            artifact = am.ArtifactVersion(
                id="v-off", task_id="t-off", kind="files", state="rejected",
                source_ref="runner:sid-off", seq=1, checksum="c", created_at=_now())
            session.add(artifact)
            await session.commit()

            def fake_say(ctx, ref, text, *, message_id="", record_user=True):
                self.assertEqual(message_id, "rework:req-9")
                return {"ok": False, "code": "RUNNER_OFFLINE",
                        "error": "这条活所在的执行机不在线"}

            from app.services import ai_exec
            with patch.object(ai_exec, "say_sync", new=fake_say):
                result = await task_rework.resume_after_rejection(
                    session, task, "驳回", artifact_version_id="v-off", request_id="req-9")
            self.assertFalse(result.get("started"))
            self.assertTrue(result.get("retryable"))
            pending = dict(task.work_routing).get("reworkPending")
            self.assertEqual(pending.get("state"), "pending")
            self.assertEqual(pending.get("attempts"), 1)
            self.assertEqual(pending.get("messageId"), "rework:req-9")
            self.assertIn("nextAttemptAt", pending)

    async def test_retry_delivers_when_due_then_clears_card(self):
        """Successful due redelivery through the resume function clears the card and records
        events.
        """
        async with self.sessions() as session:
            await self._task_with_pending_card(session, task_id="t-due")
            from app.services import ai_exec

            calls = []

            def fake_say(ctx, ref, text, *, message_id="", record_user=True):
                calls.append({"ref": ref, "messageId": message_id})
                return {"ok": True, "queued": True}

            with patch.object(ai_exec, "say_sync", new=fake_say):
                out = await task_rework.retry_once(session)
            self.assertEqual(out.get("sent"), 1)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0].get("messageId"), "rework:req-1")
            row = (await session.execute(
                select(models.Task).where(models.Task.id == "t-due"))).scalar_one()
            self.assertNotIn("reworkPending", dict(row.work_routing or {}))
            self.assertEqual(row.status, "doing")  # Align the done-to-doing transition with the creator's shortcut path.
            kinds = [r for r in (await session.execute(
                select(models.TaskEvent.kind).where(
                    models.TaskEvent.task_id == "t-due"))).scalars()]
            self.assertIn("ai.rework", kinds)

    async def test_retry_waits_for_backoff_window(self):
        """Before the backoff deadline, preserve the card and send nothing."""
        async with self.sessions() as session:
            await self._task_with_pending_card(session, task_id="t-wait", next_in_seconds=600)
            from app.services import ai_exec

            def unexpected_say(*args, **kwargs):
                raise AssertionError("退避未到点不应发送")

            with patch.object(ai_exec, "say_sync", new=unexpected_say):
                out = await task_rework.retry_once(session)
            self.assertEqual(out.get("backoff"), 1)
            self.assertEqual(out.get("sent"), 0)

    async def test_exhausted_attempts_finalize_with_notice(self):
        """Exhausted retries produce explicit failed state, an event, and a notification."""
        async with self.sessions() as session:
            await self._task_with_pending_card(session, task_id="t-max", attempts=3)
            from app.services import ai_exec
            from app.realtime import hub as hub_bus

            notices = []

            async def fake_publish(client_id, payload, *, user_id=None):
                self.assertEqual(user_id, "u-owner")
                notices.append((client_id, payload))

            def unexpected_say(*args, **kwargs):
                raise AssertionError("预算耗尽不应再发送")

            with patch.object(ai_exec, "say_sync", new=unexpected_say), \
                 patch.object(hub_bus, "publish", new=fake_publish):
                out = await task_rework.retry_once(session)
            self.assertEqual(out.get("exhausted"), 1)
            row = (await session.execute(
                select(models.Task).where(models.Task.id == "t-max"))).scalar_one()
            pending = dict(row.work_routing or {}).get("reworkPending")
            self.assertEqual(pending.get("state"), "failed")
            self.assertEqual(pending.get("failReason"), "max_attempts")
            kinds = [r for r in (await session.execute(
                select(models.TaskEvent.kind).where(
                    models.TaskEvent.task_id == "t-max"))).scalars()]
            self.assertIn("ai.rework_exhausted", kinds)
            self.assertTrue(any("重新安排" in p.get("text", "") for _, p in notices))

    async def test_exhausted_notice_is_not_sent_after_device_account_switch(self):
        """The previous task reaches a terminal failure, but a new account on the same device must not receive the old account's notice."""
        async with self.sessions() as session:
            task = await self._task_with_pending_card(
                session, task_id="t-switched", attempts=3)
            self.assertEqual(task.owner_user_id, "u-owner")
            session.add(models.User(id="u-other", username="rework-other"))
            client = await session.get(models.Client, "dev-1")
            client.user_ref = "u-other"
            await session.commit()

            from app.services import ai_exec
            from app.realtime import hub as hub_bus

            notices = []

            async def fake_publish(client_id, payload, *, user_id=None):
                notices.append((client_id, user_id, payload))

            def unexpected_say(*args, **kwargs):
                raise AssertionError("预算耗尽不应再发送")

            with patch.object(ai_exec, "say_sync", new=unexpected_say), \
                 patch.object(hub_bus, "publish", new=fake_publish):
                out = await task_rework.retry_once(session)
            self.assertEqual(out.get("exhausted"), 1)
            await session.refresh(task)
            self.assertEqual(task.owner_user_id, "u-owner")
            pending = dict(task.work_routing or {}).get("reworkPending")
            self.assertEqual(pending.get("state"), "failed")
            self.assertEqual(pending.get("failReason"), "max_attempts")
            self.assertEqual(notices, [])

    async def test_permanent_error_goes_straight_to_failed(self):
        """Permanent mode=human errors terminate immediately without consuming retries."""
        async with self.sessions() as session:
            # Missing card feedback makes resume return non-retryable mode=human.
            await self._task_with_pending_card(session, task_id="t-perm", feedback="")
            from app.services import ai_exec
            from app.realtime import hub as hub_bus

            notices = []

            async def fake_publish(client_id, payload, *, user_id=None):
                self.assertEqual(user_id, "u-owner")
                notices.append(payload)

            def unexpected_say(*args, **kwargs):
                raise AssertionError("永久性错误不应发送")

            with patch.object(ai_exec, "say_sync", new=unexpected_say), \
                 patch.object(hub_bus, "publish", new=fake_publish):
                out = await task_rework.retry_once(session)
            self.assertEqual(out.get("exhausted"), 1)
            self.assertTrue(notices)

    async def test_workflow_takeover_supersedes_card(self):
        """Workflow takeover settles the card through ai.rework_taken without retrying the old
        session.
        """
        async with self.sessions() as session:
            task = await self._task_with_pending_card(session, task_id="t-wf")
            # Associate the execution reference with a workflow so resume returns mode=workflow.
            session.add(am.ExecutionSession(
                id="es-1", task_id="t-wf", ref="runner:sid-1",
                workflow_run_id="wfr-1", state="finished"))
            await session.commit()
            from app.services import ai_exec

            def unexpected_say(*args, **kwargs):
                raise AssertionError("工作流接管不应再送意见")

            with patch.object(ai_exec, "say_sync", new=unexpected_say):
                out = await task_rework.retry_once(session)
            self.assertEqual(out.get("sent"), 1)
            row = (await session.execute(
                select(models.Task).where(models.Task.id == "t-wf"))).scalar_one()
            self.assertNotIn("reworkPending", dict(row.work_routing or {}))

    async def test_manual_dispatch_supersedes_pending_card(self):
        """Persisting manual record_dispatch clears pending cards and stops redelivery."""
        from app.services import execution_sessions, project_context
        async with self.sessions() as session:
            task = await self._task_with_pending_card(session, task_id="t-manual")
            with patch.object(project_context, "record_dispatch", new=_noop_async):
                await execution_sessions.record_dispatch(session, task, {
                    "issueId": "runner:new-ref", "runnerId": "", "host": "后端执行机",
                })
            await session.commit()
            pending = dict(task.work_routing or {}).get("reworkPending")
            self.assertIsNone(pending)
            kinds = [r for r in (await session.execute(
                select(models.TaskEvent.kind).where(
                    models.TaskEvent.task_id == "t-manual"))).scalars()]
            self.assertIn("ai.rework_taken", kinds)

    async def test_settled_anchor_skips_scan(self):
        """A later ai.rework_taken event prevents duplicate scan redelivery."""
        async with self.sessions() as session:
            await self._task_with_pending_card(session, task_id="t-settled")
            session.add(models.TaskEvent(
                id="settled-1", task_id="t-settled", kind="ai.rework_taken",
                detail={"by": "dispatch"}, at=_now() + timedelta(seconds=5)))
            await session.commit()
            from app.services import ai_exec

            def unexpected_say(*args, **kwargs):
                raise AssertionError("已人工接手的卡不应补投")

            with patch.object(ai_exec, "say_sync", new=unexpected_say):
                out = await task_rework.retry_once(session)
            self.assertEqual(out.get("candidates"), 0)

    async def test_delivered_rework_moves_done_task_back_to_doing(self):
        """Starting rework for a rejected done task returns it to doing consistently with the
        creator shortcut.
        """
        async with self.sessions() as session:
            await self._task_with_pending_card(session, task_id="t-done", status="done")
            from app.services import ai_exec

            def fake_say(ctx, ref, text, *, message_id="", record_user=True):
                return {"ok": True}

            with patch.object(ai_exec, "say_sync", new=fake_say):
                out = await task_rework.retry_once(session)
            self.assertEqual(out.get("sent"), 1)
            row = (await session.execute(
                select(models.Task).where(models.Task.id == "t-done"))).scalar_one()
            self.assertEqual(row.status, "doing")

    async def test_new_rejection_reopens_retry_budget(self):
        """A second rejection creates a fresh retry budget, initial failure notification, and
        messageId.
        """
        async with self.sessions() as session:
            task = models.Task(id="t-two", title="两轮退回", status="doing",
                               owner_client_id="dev-1",
                               work_routing={"reworkPending": {
                                   "feedback": "第一轮意见", "ref": "runner:sid-2",
                                   "requestId": "req-1", "versionId": "v2",
                                   "attempts": 2, "maxAttempts": 3, "state": "pending"}})
            session.add(task)
            session.add(am.ArtifactVersion(
                id="v2", task_id="t-two", kind="files", state="rejected",
                source_ref="runner:sid-2", seq=1, checksum="c", created_at=_now()))
            await session.commit()
            from app.services import ai_exec

            def fake_say(ctx, ref, text, *, message_id="", record_user=True):
                return {"ok": False, "code": "RUNNER_OFFLINE",
                        "error": "这条活所在的执行机不在线"}

            with patch.object(ai_exec, "say_sync", new=fake_say):
                result = await task_rework.resume_after_rejection(
                    session, task, "第二轮意见", artifact_version_id="v2",
                    request_id="req-2")
            pending = dict(task.work_routing).get("reworkPending")
            # Reset the budget instead of inheriting attempts=3 and terminating immediately.
            self.assertEqual(pending.get("requestId"), "req-2")
            self.assertEqual(pending.get("attempts"), 1)
            self.assertEqual(pending.get("state"), "pending")
            self.assertEqual(pending.get("messageId"), "rework:req-2")
            self.assertFalse(result.get("exhausted"))

    async def test_uncertain_rpc_still_retries(self):
        """An uncertain RPC result enters backoff safely because Runner deduplicates the same
        message ID.
        """
        async with self.sessions() as session:
            task = models.Task(id="t-unc", title="抖动", status="doing",
                               owner_client_id="dev-1", work_routing={})
            session.add(task)
            session.add(am.ArtifactVersion(
                id="v-unc", task_id="t-unc", kind="files", state="rejected",
                source_ref="runner:sid-unc", seq=1, checksum="c", created_at=_now()))
            await session.commit()
            from app.services import ai_exec

            def fake_say(ctx, ref, text, *, message_id="", record_user=True):
                return {"ok": False, "uncertain": True, "error": "执行机响应超时"}

            with patch.object(ai_exec, "say_sync", new=fake_say):
                result = await task_rework.resume_after_rejection(
                    session, task, "驳回", artifact_version_id="v-unc",
                    request_id="req-unc")
            self.assertTrue(result.get("retryable"))
            pending = dict(task.work_routing).get("reworkPending")
            self.assertEqual(pending.get("state"), "pending")
            self.assertIn("nextAttemptAt", pending)

    async def test_legacy_card_without_schedule_is_adopted(self):
        """Adopt legacy pending cards without scheduling fields into the retry loop."""
        async with self.sessions() as session:
            task = models.Task(id="t-legacy", title="排雷小游戏", status="doing",
                               owner_client_id="dev-1",
                               work_routing={"reworkPending": {
                                   "feedback": "驳回", "ref": "runner:legacy",
                                   "requestId": "req-old", "versionId": "v-legacy",
                                   "error": "这个本地会话已经不在了"}})
            session.add(task)
            session.add(am.ArtifactVersion(
                id="v-legacy", task_id="t-legacy", kind="files", state="rejected",
                source_ref="runner:legacy", seq=1, checksum="c", created_at=_now()))
            session.add(models.TaskEvent(
                id="anchor-legacy", task_id="t-legacy", kind="ai.rework_pending",
                detail={}, at=_now() - timedelta(days=1)))
            await session.commit()
            from app.services import ai_exec

            def fake_say(ctx, ref, text, *, message_id="", record_user=True):
                return {"ok": True}

            with patch.object(ai_exec, "say_sync", new=fake_say):
                out = await task_rework.retry_once(session)
            self.assertEqual(out.get("sent"), 1)


class ReturnToBacklogTests(unittest.IsolatedAsyncioTestCase):
    """Both return-to-pending entry points remain idempotent after a client status update without
    recording skipped.
    """

    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_backlog_idempotent_when_client_already_set_todo(self):
        async with self.sessions() as session:
            task = models.Task(id="t-back", title="已待开始", status="todo",
                               triage_stage="ready", work_routing={"reworkPending": {
                                   "feedback": "驳回", "ref": "runner:x"}})
            session.add(task)
            await session.commit()
            out = await task_rework.return_to_backlog(session, task, "意见",
                                                      request_id="req-b")
            self.assertTrue(out.get("started"))
            self.assertEqual(task.status, "todo")
            self.assertEqual(task.triage_stage, "ready")
            kinds = [r for r in (await session.execute(
                select(models.TaskEvent.kind).where(
                    models.TaskEvent.task_id == "t-back"))).scalars()]
            self.assertIn("review.returned_to_backlog", kinds)
            self.assertNotIn("review.backlog_skipped", kinds)
            # Also clear the pending rework card.
            self.assertNotIn("reworkPending", dict(task.work_routing or {}))


async def _noop_async(*args, **kwargs):
    return None


if __name__ == "__main__":
    unittest.main()
