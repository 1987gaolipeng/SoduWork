"""Planning uses durable execution intent without retaining stale device authority."""
import asyncio
import os
import unittest
from contextlib import ExitStack, contextmanager
from unittest.mock import AsyncMock, Mock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-plan-claim-test-key")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from sqlalchemy import select
from app import models
from app.api import tasks as task_api
from app.services import ai_exec, task_execution_model
from test_unified_requirements import UnifiedRequirementTests


class RequirementPlanClaimTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = UnifiedRequirementTests.asyncSetUp
    asyncTearDown = UnifiedRequirementTests.asyncTearDown
    call = UnifiedRequirementTests.call

    async def ready(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            task.assignee_user_id = "peer"
            task.triage_stage = "ready"
            task.work_routing = {}
            await session.commit()

    @contextmanager
    def isolated_execution(self, *, collect=None, dispatch=None):
        rpc = Mock(side_effect=dispatch, return_value={
            "ok": True, "issueId": "isolated:plan", "provider": "fixture",
            "assigneeName": "Fixture", "state": "running",
        })
        patches = [
            patch.object(ai_exec, "load", AsyncMock(return_value={})),
            patch.object(ai_exec, "enabled", return_value=True),
            patch.object(ai_exec, "collect_task_context", AsyncMock(side_effect=collect, return_value={})),
            patch.object(task_api, "_resolve_repo", AsyncMock(return_value=None)),
            patch.object(task_api, "_settle_work_dir", AsyncMock(return_value={"ok": True, "dir": "isolated", "workRoot": "isolated"})),
            patch.object(task_api, "_ext_project_id", AsyncMock(return_value="")),
            patch.object(ai_exec, "with_task_git", AsyncMock(return_value={})),
            patch.object(task_execution_model, "prepare", AsyncMock(return_value=({}, {}))),
            patch.object(ai_exec, "with_project_context", AsyncMock(side_effect=lambda session, extra, task, repo: extra)),
            patch.object(ai_exec, "dispatch_sync", rpc),
        ]
        with ExitStack() as stack:
            for item in patches:
                stack.enter_context(item)
            yield rpc

    async def events(self):
        async with self.sessions() as session:
            return list(await session.scalars(select(models.TaskEvent).where(
                models.TaskEvent.task_id == "shared")))

    async def test_claim_during_plan_preparation_rejects_stale_executor_before_rpc(self):
        await self.ready()

        async def collect(session, tid):
            claimed = await self.call("POST", "tasks/shared/prepare-execution", "peer", json={})
            self.assertEqual(claimed.status_code, 200, claimed.text)
            return {}

        with self.isolated_execution(collect=collect) as rpc:
            result = await self.call("POST", "tasks/shared/ai-plan", "owner", json={})
        self.assertEqual(result.status_code, 409, result.text)
        rpc.assert_not_called()
        self.assertFalse(any(event.kind == ai_exec.EV_DISPATCH_STARTED for event in await self.events()))
        current = (await self.call("GET", "tasks/shared", "peer")).json()
        self.assertEqual((current["ownerClientId"], current["status"]), ("peer", "todo"))

    async def test_plan_rpc_has_durable_intent_that_blocks_claim(self):
        await self.ready()
        loop = asyncio.get_running_loop()
        observed = {}

        async def during_rpc():
            events = await self.events()
            observed["started"] = [event for event in events if event.kind == ai_exec.EV_DISPATCH_STARTED]
            claimed = await self.call("POST", "tasks/shared/prepare-execution", "peer", json={})
            observed["claim"] = claimed.status_code
            return {"ok": True, "issueId": "isolated:plan", "provider": "fixture", "state": "running"}

        def dispatch(*_args, **_kwargs):
            return asyncio.run_coroutine_threadsafe(during_rpc(), loop).result(timeout=5)

        with self.isolated_execution(dispatch=dispatch) as rpc:
            result = await self.call("POST", "tasks/shared/ai-plan", "owner", json={})
        self.assertEqual(result.status_code, 200, result.text)
        rpc.assert_called_once()
        self.assertEqual(len(observed["started"]), 1)
        self.assertEqual(observed["claim"], 409)
        successful = [event for event in await self.events() if event.kind == ai_exec.EV_DISPATCHED]
        self.assertEqual(len(successful), 1)
        self.assertEqual(successful[0].detail["attemptId"], observed["started"][0].detail["attemptId"])

    async def test_definite_plan_failure_records_receipt_and_allows_later_claim(self):
        await self.ready()
        with self.isolated_execution(dispatch=lambda *_args: {"ok": False, "error": "isolated rejection"}):
            result = await self.call("POST", "tasks/shared/ai-plan", "owner", json={})
        self.assertEqual(result.status_code, 502, result.text)
        events = await self.events()
        started = [event for event in events if event.kind == ai_exec.EV_DISPATCH_STARTED]
        failed = [event for event in events if event.kind == ai_exec.EV_DISPATCH_FAILED]
        self.assertEqual(len(started), 1)
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0].detail["attemptId"], started[0].detail["attemptId"])
        claimed = await self.call("POST", "tasks/shared/prepare-execution", "peer", json={})
        self.assertEqual(claimed.status_code, 200, claimed.text)

    async def test_uncertain_plan_receipt_keeps_claim_blocked(self):
        await self.ready()
        with self.isolated_execution(dispatch=lambda *_args: {
            "ok": False, "uncertain": True, "error": "awaiting runner acknowledgement",
        }):
            result = await self.call("POST", "tasks/shared/ai-plan", "owner", json={})
        self.assertEqual(result.status_code, 502, result.text)
        events = await self.events()
        self.assertEqual(sum(event.kind == ai_exec.EV_DISPATCH_UNCERTAIN for event in events), 1)
        self.assertFalse(any(event.kind == ai_exec.EV_DISPATCH_FAILED for event in events))
        claimed = await self.call("POST", "tasks/shared/prepare-execution", "peer", json={})
        self.assertEqual(claimed.status_code, 409, claimed.text)

    async def test_thrown_rpc_error_preserves_uncertainty_until_execution_is_reconciled(self):
        await self.ready()

        def lost_response(*_args):
            raise RuntimeError("isolated connection lost after sending request")

        with self.isolated_execution(dispatch=lost_response):
            result = await self.call("POST", "tasks/shared/ai-plan", "owner", json={})
        self.assertEqual(result.status_code, 502, result.text)
        events = await self.events()
        self.assertEqual(sum(event.kind == ai_exec.EV_DISPATCH_UNCERTAIN for event in events), 1)
        self.assertFalse(any(event.kind == ai_exec.EV_DISPATCH_FAILED for event in events))
        claimed = await self.call("POST", "tasks/shared/prepare-execution", "peer", json={})
        self.assertEqual(claimed.status_code, 409, claimed.text)
