"""Integration tests for requirement-pool rework through real API handlers, release decisions, and
task_rework services. Cover rejection modes, pending cards, redelivery, manual takeover, renewed
budgets, resume branches, and lazy restoration. Mock only Runner RPC, live publication, dispatch
context, and local CLI process boundaries.
"""
import asyncio
import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.db import Base
from app.services import execution_sessions, task_rework


def _now():
    return datetime.now(timezone.utc)


class _Base(unittest.IsolatedAsyncioTestCase):

    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def _fixture(self, session, *, task_id="t-life", status="doing",
                       source_ref="conversation:sess-9", artifact_id=""):
        """Create the minimal delivery topology: creator, executor device, and pending artifact
        review.
        """
        aid = artifact_id or f"{task_id}-v1"
        session.add(models.User(id="u-owner", username="owner", display_name="创建人"))
        session.add(models.Client(id="c-review", name="审核设备", user_ref="u-owner"))
        session.add(models.Client(id="dev-1", name="执行机"))
        task = models.Task(id=task_id, title="中医知识展示网页", status=status,
                           owner_client_id="dev-1", created_by="u-owner",
                           created_by_name="创建人")
        session.add(task)
        session.add(am.ArtifactVersion(
            id=aid, task_id=task_id, kind="files", state="review",
            source_ref=source_ref, seq=1, checksum="c1",
            manifest={"schemaVersion": "2", "complete": True,
                      "primary": [], "problems": []},
            created_at=_now()))
        await session.commit()
        return task


class ReworkLifecycleApi(_Base):
    """Exercise both rejection routes through the real API handler and release_control.decide."""

    async def _reject_via_api(self, session, *, task_id="t-life", to_ai=True,
                              note="驳回：缺少药材图谱", client_id="c-review"):
        from app.api import tasks as tasks_api
        from app.realtime import hub as hub_bus

        notices = []

        async def fake_publish(client_id, payload, *, user_id=None):
            notices.append((client_id, payload))

        client = await session.get(models.Client, client_id)
        with patch.object(hub_bus, "publish", new=fake_publish):
            out = await tasks_api.reject_task_artifact(
                tid=task_id, body={"note": note, "toAI": to_ai},
                client=client, session=session)
        return out, notices

    async def _kinds(self, session, task_id):
        return [r for r in (await session.execute(
            select(models.TaskEvent.kind).where(
                models.TaskEvent.task_id == task_id))).scalars()]

    async def test_reject_to_backlog_full_flow(self):
        """toAI=false returns the task to pending, retains feedback, and notifies the executor."""
        async with self.sessions() as session:
            task = await self._fixture(session, task_id="t-backlog", status="done")
            out, notices = await self._reject_via_api(
                session, task_id="t-backlog", to_ai=False)
            self.assertTrue(out.get("ok"))
            fresh = await session.get(models.Task, "t-backlog")
            self.assertEqual(fresh.status, "todo")          # Verify the task actually returns to pending.
            self.assertNotIn("reworkPending", dict(fresh.work_routing or {}))
            kinds = await self._kinds(session, "t-backlog")
            self.assertIn("review.returned_to_backlog", kinds)
            self.assertIn("artifact.rejected", kinds)
            # Notify the producing executor of rejection and its reason.
            self.assertTrue(any(cid == "dev-1" and "驳回" in p.get("text", "")
                                for cid, p in notices))

    async def test_reject_to_ai_conversation_terminal_flow(self):
        """toAI=true with a client session skips unreachable RPC and records terminal fallback with
        reusable feedback.
        """
        async with self.sessions() as session:
            await self._fixture(session, task_id="t-conv", status="done",
                                source_ref="conversation:sess-9")
            out, notices = await self._reject_via_api(
                session, task_id="t-conv",
                note="驳回：缺用药说明", to_ai=True)
            fresh = await session.get(models.Task, "t-conv")
            card = dict(fresh.work_routing or {}).get("reworkPending") or {}
            self.assertEqual(card.get("state"), "failed")       # Client-hosted conversations produce terminal fallback.
            self.assertEqual(fresh.status, "doing")
            self.assertIn("客户端", card.get("error") or "")
            self.assertEqual(card.get("attempts"), 1)
            self.assertEqual(card.get("feedback"), "驳回：缺用药说明")
            self.assertNotIn("ai.rework_pending", await self._kinds(session, "t-conv"))
            self.assertIn("ai.rework_exhausted", await self._kinds(session, "t-conv"))
            # Report that rework did not start rather than claiming AI resumed successfully.
            self.assertTrue(any(cid == "dev-1" and "未启动" in p.get("text", "")
                                for cid, p in notices))
            rejected = (await session.execute(
                select(models.TaskEvent).where(
                    models.TaskEvent.task_id == "t-conv",
                    models.TaskEvent.kind == "artifact.rejected"))).scalars().all()
            self.assertFalse((rejected[0].detail if rejected else {}).get("toAI"))

    async def test_offline_rework_then_retry_delivers_and_dispatch_clears(self):
        """Offline Runners enter backoff; due redelivery resumes rework, and manual redispatch
        clears the card.
        """
        async with self.sessions() as session:
            await self._fixture(session, task_id="t-off", status="doing",
                                source_ref="runner:xyz", artifact_id="t-off-v1")
            from app.services import ai_exec

            def fake_offline(ctx, ref, text, *, message_id="", record_user=True):
                return {"ok": False, "code": "RUNNER_OFFLINE",
                        "error": "这条活所在的执行机不在线"}

            with patch.object(ai_exec, "say_sync", new=fake_offline):
                await self._reject_via_api(session, task_id="t-off", to_ai=True)
            fresh = await session.get(models.Task, "t-off")
            card = dict(fresh.work_routing)["reworkPending"]
            self.assertEqual(card["state"], "pending")
            self.assertEqual(card["attempts"], 1)
            self.assertEqual(card["messageId"], "rework:" + card["requestId"])
            self.assertIn("nextAttemptAt", card)
            self.assertEqual(fresh.status, "doing")

            # Deliver feedback to the original session and transition the task from done to doing.
            def fake_ok(ctx, ref, text, *, message_id="", record_user=True):
                return {"ok": True}

            with patch.object(ai_exec, "say_sync", new=fake_ok):
                card["nextAttemptAt"] = (_now() - timedelta(seconds=1)).isoformat()
                fresh.work_routing = dict(fresh.work_routing)
                await session.commit()
                out = await task_rework.retry_once(session)
            self.assertEqual(out.get("sent"), 1)
            fresh = await session.get(models.Task, "t-off")
            self.assertEqual(fresh.status, "doing")
            self.assertNotIn("reworkPending", dict(fresh.work_routing or {}))
            self.assertIn("ai.rework", await self._kinds(session, "t-off"))

            # After clearing the card, record_dispatch remains idempotent without another ai.rework_taken event.
            async def _noop(*a, **k):
                return None

            with patch("app.services.project_context.record_dispatch", new=_noop):
                await execution_sessions.record_dispatch(
                    session, fresh, {"issueId": "runner:xyz", "runnerId": "dev-1"})
            self.assertNotIn("reworkPending", dict(fresh.work_routing or {}))

    async def test_second_rejection_reopens_budget_via_api(self):
        """Reject repeated rejection of one version; a new version gets a new card, retry budget,
        and message ID.
        """
        async with self.sessions() as session:
            await self._fixture(session, task_id="t-two", status="doing",
                                source_ref="runner:abc", artifact_id="t-two-v1")
            from fastapi import HTTPException
            from app.services import ai_exec

            def fake_offline(ctx, ref, text, *, message_id="", record_user=True):
                return {"ok": False, "code": "RUNNER_OFFLINE", "error": "执行机不在线"}

            with patch.object(ai_exec, "say_sync", new=fake_offline):
                await self._reject_via_api(
                    session, task_id="t-two", to_ai=True, note="第一轮：样式不对")
                card1 = dict((await session.get(models.Task, "t-two")).work_routing)["reworkPending"]

                # Reject an already-rejected artifact version with 409 until a new version is submitted.
                with self.assertRaises(HTTPException) as caught:
                    await self._reject_via_api(
                        session, task_id="t-two", to_ai=True, note="重复退同一版")
                self.assertEqual(caught.exception.status_code, 409)

                # Submit revised version v2 and reject it again.
                session.add(am.ArtifactVersion(
                    id="t-two-v2", task_id="t-two", kind="files", state="review",
                    source_ref="runner:abc", seq=2, checksum="c2",
                    manifest={"schemaVersion": "2", "complete": True,
                              "primary": [], "problems": []},
                    created_at=_now()))
                await session.commit()
                await self._reject_via_api(
                    session, task_id="t-two", to_ai=True, note="第二轮：缺用法说明")
            fresh = await session.get(models.Task, "t-two")
            card2 = dict(fresh.work_routing)["reworkPending"]
            self.assertNotEqual(card2["messageId"], card1["messageId"])
            self.assertEqual(card2["attempts"], 1)               # Reset the retry budget for the new card.
            self.assertIn("第二轮", card2["feedback"])
            self.assertEqual(card2["state"], "pending")


class ResumeBranches(_Base):
    """Cover resume_after_rejection precondition branches without Runner RPC."""

    async def test_workflow_engine_takes_over(self):
        async with self.sessions() as session:
            task = await self._fixture(session, task_id="t-wf", status="doing")
            session.add(am.WorkflowRun(id="wr-1", task_id="t-wf", plugin_id="p1",
                                       plugin_version_id="pv1", state="running"))
            await session.commit()
            out = await task_rework.resume_after_rejection(
                session, task, "改一下", artifact_version_id="t-wf-v1",
                request_id="r-wf")
            self.assertEqual(out["mode"], "workflow")
            self.assertTrue(out["started"])

    async def test_version_of_other_task_is_rejected(self):
        async with self.sessions() as session:
            task = await self._fixture(session, task_id="t-a", status="doing",
                                       artifact_id="t-a-v1")
            session.add(am.ArtifactVersion(
                id="t-b-v1", task_id="t-b", kind="files", state="review",
                source_ref="runner:other", seq=1, checksum="c", created_at=_now()))
            await session.commit()
            out = await task_rework.resume_after_rejection(
                session, task, "改一下", artifact_version_id="t-b-v1",
                request_id="r-x")
            self.assertEqual(out["mode"], "human")
            self.assertIn("不属于这条需求", out["error"])

    async def test_no_session_ref_is_terminal(self):
        async with self.sessions() as session:
            task = await self._fixture(session, task_id="t-noref", status="doing",
                                       artifact_id="t-noref-v1")
            art = await session.get(am.ArtifactVersion, "t-noref-v1")
            art.source_ref = ""
            await session.commit()
            out = await task_rework.resume_after_rejection(
                session, task, "改一下", artifact_version_id="t-noref-v1",
                request_id="r-n")
            self.assertEqual(out["mode"], "human")
            self.assertIn("没有可续跑的 AI 会话", out["error"])

    async def test_finished_workflow_run_says_retry_from_stage(self):
        async with self.sessions() as session:
            task = await self._fixture(session, task_id="t-wfdone", status="doing",
                                       source_ref="runner:wf", artifact_id="t-wfdone-v1")
            session.add(am.ExecutionSession(
                ref="runner:wf", task_id="t-wfdone", runner_id="dev-1",
                workflow_run_id="wr-9", state="ended",
                started_at=_now(), metadata_={}))
            await session.commit()
            out = await task_rework.resume_after_rejection(
                session, task, "改一下", artifact_version_id="t-wfdone-v1",
                request_id="r-wfdone")
            self.assertEqual(out["mode"], "workflow")
            self.assertFalse(out["started"])
            self.assertIn("失败阶段", out["error"])


class LazyRecovery(_Base):
    """Verify file-based rehydrate behavior and its two public entry points."""

    def setUp(self):
        super().setUp()
        self._tmp = tempfile.TemporaryDirectory()
        import app.services.local_base as lb
        self._lb = lb
        self._old_store = lb._STORE
        self._old_runs = dict(lb._RUNS)
        lb._RUNS.clear()
        lb._STORE = self._tmp.name

    def tearDown(self):
        self._lb._STORE = self._old_store
        self._lb._RUNS.clear()
        self._lb._RUNS.update(self._old_runs)
        self._tmp.cleanup()
        super().tearDown()

    def _make_archive(self, ref, *, state="running", pid=0):
        d = os.path.join(self._tmp.name, ref)
        os.makedirs(d, exist_ok=True)
        meta = {"cli": "claude", "ws": "ws-1", "taskId": "t-1", "state": state,
                "started": time.time(), "pid": pid, "seq": 0,
                "segment": 1, "round": 1}
        with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False)

    def test_rehydrate_adopts_archived_session(self):
        """After Hub restart, comment_sync restores persisted sessions instead of reporting them
        missing.
        """
        self._make_archive("sess-abc", state="running", pid=0)
        run = self._lb.rehydrate("sess-abc")
        self.assertIsNotNone(run)          # Restore the session in memory and settle its dead process as interrupted.
        from app.services import local_stream
        out = local_stream.comment_sync({}, "sess-abc", "返修意见")
        self.assertNotIn("已经不在了", str(out.get("error") or ""))
        self.assertFalse(out.get("ok"))    # A settled session must not claim successful feedback delivery.

    def test_rehydrate_returns_none_without_archive(self):
        self.assertIsNone(self._lb.rehydrate("sess-gone"))
        from app.services import local_stream
        out = local_stream.comment_sync({}, "sess-gone", "意见")
        self.assertIn("已经不在了", out.get("error") or "")

    def test_rehydrate_never_overrides_live_run(self):
        """Never replace a live in-memory run with a disk snapshot during reclamation."""
        from app.services import local_stream
        with self._lb._LOCK:
            self._lb._RUNS["sess-live"] = {
                "state": "running", "ws": "ws-live", "queue": ["现场未发的话"]}
        self._make_archive("sess-live", state="running", pid=999999)
        self._lb.rehydrate("sess-live")
        with self._lb._LOCK:
            run = self._lb._RUNS["sess-live"]
        self.assertEqual(run.get("ws"), "ws-live")
        out = local_stream.comment_sync({}, "sess-live", "继续")
        self.assertTrue(out.get("queued"))  # Queue feedback for the live session without interference from its archive.


if __name__ == "__main__":
    unittest.main()
