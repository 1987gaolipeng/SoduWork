"""Delivery-state regressions for completion-gate propagation, contract normalization, and
recoverable rework. Local-file tasks without repositories must not inherit repository-change
gates; missing sessions after restart must produce persisted, actionable rework state rather
than silent dead ends.
"""

import unittest
from datetime import datetime, timezone
from types import SimpleNamespace

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.db import Base
from app.services import delivery_truth, task_rework, tasks as task_service


def _now():
    return datetime.now(timezone.utc)


class ContractNormalizationTests(unittest.IsolatedAsyncioTestCase):
    """Tasks without code projects must not carry repository-change contracts."""

    def test_repository_contract_without_repo_gets_normalized(self):
        task = SimpleNamespace(
            project_id=None, repo_id="",
            work_routing={"outputContract": {"kind": "repository-change",
                                             "deliverables": ["代码提交"], "acceptance": ["可合并"]}},
        )
        self.assertTrue(task_service.normalize_output_contract(task))
        contract = task.work_routing["outputContract"]
        self.assertEqual(contract["kind"], "office-artifact")
        self.assertEqual(contract["normalizedFrom"], "repository-change")
        self.assertEqual(contract["deliverables"], ["代码提交" if False else "代码提交"] or ["代码提交"])
        # Preserve the original deliverables list.
        self.assertEqual(contract["deliverables"], ["代码提交"])

    def test_task_with_repo_keeps_contract(self):
        task = SimpleNamespace(project_id=None, repo_id="repo-1", work_routing={
            "outputContract": {"kind": "repository-change"}})
        self.assertFalse(task_service.normalize_output_contract(task))
        self.assertEqual(task.work_routing["outputContract"]["kind"], "repository-change")

    def test_project_task_keeps_contract(self):
        task = SimpleNamespace(project_id="proj-1", repo_id="", work_routing={
            "outputContract": {"kind": "repository-change"}})
        self.assertFalse(task_service.normalize_output_contract(task))

    def test_other_contracts_untouched(self):
        task = SimpleNamespace(project_id=None, repo_id="", work_routing={
            "outputContract": {"kind": "office-artifact"}})
        self.assertFalse(task_service.normalize_output_contract(task))
        self.assertEqual(task.work_routing["outputContract"]["kind"], "office-artifact")


class DeliveryGateDefenseTests(unittest.IsolatedAsyncioTestCase):
    """Require the project workflow completion gate only for tasks with actual code projects."""

    async def test_mislabeled_contract_does_not_block_completion(self):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        try:
            async with sessions() as session:
                task = models.Task(
                    id="tank-task", title="无仓任务", status="doing",
                    work_routing={"outputContract": {"kind": "repository-change"}})
                session.add(task)
                await session.commit()
                truth = await delivery_truth.evaluate(session, task)
                codes = [str(b.get("code") or "") for b in truth.get("blockers") or []]
                self.assertNotIn("managed_workflow_required", codes)
        finally:
            await engine.dispose()

    async def test_real_project_still_requires_workflow(self):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        try:
            async with sessions() as session:
                task = models.Task(
                    id="repo-task", title="真项目任务", status="doing", project_id="proj-1",
                    work_routing={"outputContract": {"kind": "repository-change"}})
                session.add(task)
                await session.commit()
                truth = await delivery_truth.evaluate(session, task)
                codes = [str(b.get("code") or "") for b in truth.get("blockers") or []]
                self.assertIn("managed_workflow_required", codes)
        finally:
            await engine.dispose()


class ReworkFallbackTests(unittest.IsolatedAsyncioTestCase):
    """On rework failure, persist feedback and both events, and return an explicit fallback flag."""

    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_resume_failure_records_rework_pending(self):
        from unittest.mock import patch
        from app.services import ai_exec
        async with self.sessions() as session:
            task = models.Task(id="mine-task", title="排雷", status="doing",
                               owner_client_id="dev-1",
                               work_routing={"outputContract": {"kind": "office-artifact"}})
            session.add(task)
            artifact = am.ArtifactVersion(
                id="ver-1", task_id="mine-task", kind="files", state="rejected",
                source_ref="conversation:01a1252b", seq=1, checksum="fix",
                created_at=datetime.now(timezone.utc))
            session.add(artifact)
            await session.commit()

            # Client conversation sessions are unreachable from Hub; record terminal fallback without say_sync.
            def unexpected_say(*args, **kwargs):
                raise AssertionError("conversation: 引用不应再尝试 say_sync")

            with patch.object(ai_exec, "say_sync", new=unexpected_say):
                result = await task_rework.resume_after_rejection(
                    session, task, "驳回", artifact_version_id="ver-1",
                    request_id="req-1", actor="王振义")
            self.assertFalse(result.get("started"))
            self.assertEqual(result.get("fallback"), "rework_pending")
            row = (await session.execute(
                select(models.Task).where(models.Task.id == "mine-task"))).scalar_one()
            pending = dict(row.work_routing or {}).get("reworkPending") or {}
            self.assertEqual(pending.get("feedback"), "驳回")
            self.assertIn("客户端会话", pending.get("error") or "")
            # Unreachable client sessions cannot recover through retry; skip backoff redelivery.
            self.assertEqual(pending.get("state"), "failed")
            self.assertNotIn("nextAttemptAt", pending)
            kinds = [r for r in (await session.execute(
                select(models.TaskEvent.kind).where(
                    models.TaskEvent.task_id == "mine-task"))).scalars()]
            self.assertIn("ai.rework_failed", kinds)
            # Record a terminal anchor so retry scans skip non-retryable cards.
            self.assertIn("ai.rework_exhausted", kinds)
            self.assertNotIn("ai.rework_pending", kinds)

    async def test_rework_pending_survives_in_work_routing(self):
        """Expose work_routing.reworkPending through the API for client rework cards."""
        async with self.sessions() as session:
            task = models.Task(id="r-task", title="带返修意见", status="doing",
                               work_routing={"reworkPending": {
                                   "feedback": "驳回", "ref": "conversation:x", "error": "不在了"}})
            session.add(task)
            await session.commit()
            row = (await session.execute(
                select(models.Task).where(models.Task.id == "r-task"))).scalar_one()
            pending = dict(row.work_routing or {}).get("reworkPending") or {}
            self.assertEqual(pending.get("feedback"), "驳回")
            self.assertEqual(pending.get("error"), "不在了")


async def _noop():
    return None


class DeliveryStateGateTests(unittest.IsolatedAsyncioTestCase):
    """A rejected mark(done) keeps the task doing; the API must propagate that result."""

    async def test_mark_returns_false_when_gate_blocks(self):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        try:
            async with sessions() as session:
                task = models.Task(
                    id="repo-task-2", title="真项目", status="doing", project_id="proj-1",
                    work_routing={"outputContract": {"kind": "repository-change"}})
                session.add(task)
                await session.commit()
                from app.services import task_status
                applied = await task_status.mark(session, task, "done", why="验收通过")
                self.assertFalse(applied)
                self.assertEqual(task.status, "doing")
        finally:
            await engine.dispose()


class BlockedSummaryAxisTests(unittest.IsolatedAsyncioTestCase):
    """Treat project merge waiting as a valid intermediate state rather than a blocker."""

    def test_project_task_waiting_for_merge_is_not_blocked(self):
        from app.services import delivery_truth
        task = SimpleNamespace(project_id="proj-1", repo_id="", status="doing")
        summary = delivery_truth.blocked_summary(task, [
            {"code": "managed_workflow_required", "title": "必须走项目工作流"}])
        self.assertTrue(summary["awaitingWorkflow"])
        self.assertIn("工作流", summary["reason"])

    def test_local_task_with_other_blockers_is_blocked(self):
        from app.services import delivery_truth
        task = SimpleNamespace(project_id=None, repo_id="", status="doing")
        summary = delivery_truth.blocked_summary(task, [
            {"code": "unverified_output", "title": "产出未核验"}])
        self.assertFalse(summary["awaitingWorkflow"])

    def test_workflow_blocker_mixed_with_others_is_blocked(self):
        """Do not hide a real blocker behind an outstanding workflow prerequisite."""
        from app.services import delivery_truth
        task = SimpleNamespace(project_id="proj-1", repo_id="", status="doing")
        summary = delivery_truth.blocked_summary(task, [
            {"code": "managed_workflow_required"},
            {"code": "unverified_output"}])
        self.assertFalse(summary["awaitingWorkflow"])


if __name__ == "__main__":
    unittest.main()
