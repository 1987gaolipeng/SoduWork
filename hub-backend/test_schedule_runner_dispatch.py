"""Exercise automation dispatch with a private DB and an isolated Runner RPC.

Keep provider loading, executor selection, model resolution and run receipts real.
The RPC boundary never starts an Agent or contacts a model service.
"""
import importlib
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-schedule-runner-test-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-test-password")

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.api import personal_schedules
from app.db import Base
from app.services import (
    ai_exec, ai_local, ai_remote, client_access, dispatch_identity,
    model_catalog, runner_hub, schedule_conversations, schedules,
)
from tests.sqlite_schema import create_fresh_sqlite_schema

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


class ScheduleRunnerDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as connection:
            await create_fresh_sqlite_schema(connection, Base.metadata)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.owner = models.User(id="owner", username="owner", is_active=True)
        self.client = models.Client(id="device", user_ref="owner", auth_state="active", config={})
        self.session.add_all([self.owner, self.client])
        await self.session.flush()
        self.schedule = models.AiSchedule(
            id="schedule", owner_client_id="device", owner_user_id="owner",
            title="Scheduled instruction", note="Keep the complete instruction and acceptance criteria",
            assignee_id="local:codex", assignee_type="agent", enabled=False,
            every="daily", time_zone="Asia/Shanghai", required_capabilities=[],
        )
        self.session.add(self.schedule)
        await self.session.commit()
        self.runner = runner_hub._Runner(None, {
            "runnerId": "desktop", "clientId": "device", "host": "isolated-device",
            "version": "1.13.3", "bootId": "test-boot", "inventoryReady": True,
            "agents": [{"key": "codex", "name": "Codex", "auth": "authed"}],
            "tags": [runner_hub.CLIENT_TAG],
            "skills": ["office"], "workRoot": "X:/isolated-workspace",
        })
        self.runner.ready = True
        self.runner.dispatch_mode = "accepting"
        self.calls = []

        def rpc(runner, op, data, **kwargs):
            if runner is not self.runner or op != "job.dispatch":
                raise AssertionError("Unexpected external Runner RPC: " + op)
            self.calls.append(data)
            return {"ok": True, "data": {
                "ref": dispatch_identity.execution_ref(data["dispatchId"]),
                "identifier": "isolated-job", "state": "running", "dispatchId": data["dispatchId"],
            }}

        self.patches = [
            patch.object(ai_local, "_HUB_CLUSTER_MODE", True),
            patch.object(runner_hub, "_RUNNERS", {self.runner.id: self.runner}),
            patch.object(runner_hub, "call_sync", side_effect=rpc),
            patch.object(ai_remote, "_WHERE", ai_remote.OrderedDict()),
            patch.object(client_access, "_policy_cache", None),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()

    async def run_schedule(self):
        result = await personal_schedules.run_my_schedule(
            "schedule", body={}, client=self.client, session=self.session)
        self.assertTrue(result["ok"])
        self.assertEqual(result["executionMode"], schedule_conversations.PROTOCOL)
        self.assertEqual(self.calls, [], "Hub must not launch task RPC for an ordinary conversation")
        self.assertIsNone(await self.session.scalar(select(models.Task)))
        self.assertIsNone(await self.session.scalar(select(am.ExecutionSession)))
        run = await self.session.get(models.AiScheduleRun, result["scheduleRunId"])
        self.assertEqual(run.state, "waiting")
        self.assertEqual(run.owner_user_id, "owner")
        self.assertFalse(run.task_id or run.workflow_run_id)
        return run, run.receipt["conversationInput"]

    async def test_desktop_native_account_queues_without_a_hub_local_cli(self):
        ctx = await ai_exec.load(self.session, force=True)
        self.assertFalse(ai_exec.configured(ctx))
        run, envelope = await self.run_schedule()
        self.assertEqual(envelope["adapterId"], "codex")
        self.assertIn(self.schedule.note, envelope["text"])
        self.assertEqual(envelope["runId"], run.id)
        self.assertEqual(envelope["modelName"], "")

    async def test_personal_plugin_keeps_pinned_identity_and_inputs_for_owner_device(self):
        self.schedule.personal_plugin_key = "personal-method"
        self.schedule.personal_plugin_version_policy = "pinned"
        self.schedule.personal_plugin_version = "2.0.0"
        self.schedule.personal_plugin_checksum = "a" * 64
        self.schedule.plugin_inputs = {"instruction": "Keep this plugin input", "count": 2}
        await self.session.commit()
        run, envelope = await self.run_schedule()
        self.assertEqual(envelope["personalPlugin"], {
            "key": "personal-method", "versionPolicy": "pinned", "version": "2.0.0",
            "checksum": "a" * 64})
        self.assertIn("Keep this plugin input", envelope["text"])
        self.assertIn('"count": 2', envelope["text"])
        claimed = await schedule_conversations.claim(self.session, self.client, run.id, "owner-worker")
        self.assertEqual(claimed["input"], envelope)

    async def test_gateway_agent_uses_explicit_schedule_model_without_forwarding_credentials(self):
        self.schedule.assignee_id, self.schedule.model_name = "local:pi", "selected-model"
        self.client.agent_models = {"pi": "different-composer-model"}
        self.session.add_all([
            models.ModelProvider(id="private", base_url="https://model.invalid/v1", api_key="fixture-key"),
            models.ModelDef(id="private:selected-model", provider_id="private", name="selected-model")])
        await self.session.commit()
        _, envelope = await self.run_schedule()
        self.assertEqual(envelope["modelName"], "selected-model")
        self.assertEqual(envelope["adapterId"], "pi")
        self.assertNotIn("fixture-key", json.dumps(envelope))
        self.assertNotIn("https://model.invalid", json.dumps(envelope))

    async def test_unavailable_explicit_model_fails_with_durable_receipt(self):
        self.schedule.assignee_id, self.schedule.model_name = "local:pi", "removed-model"
        await self.session.commit()
        with self.assertRaises(HTTPException) as caught:
            await personal_schedules.run_my_schedule("schedule", body={}, client=self.client, session=self.session)
        self.assertIn("removed-model", caught.exception.detail)
        self.assertEqual(self.calls, [])
        run = await self.session.scalar(select(models.AiScheduleRun))
        self.assertEqual(run.state, "failed")
        self.assertIn("removed-model", run.error)
        self.assertFalse(run.task_id)

    async def test_disabled_explicit_model_cannot_reuse_legacy_credentials(self):
        self.schedule.assignee_id, self.schedule.model_name = "local:pi", "disabled-model"
        self.session.add_all([
            models.AppSetting(key="llm_base_url", value="https://disabled-model.invalid/v1"),
            models.AppSetting(key="llm_api_key", value="disabled-fixture-key"),
            models.AppSetting(key="llm_model", value="disabled-model"),
            models.ModelProvider(id="company", base_url="https://disabled-model.invalid/v1",
                                 api_key="disabled-fixture-key", enabled=False),
            models.ModelDef(id="company:disabled-model", provider_id="company",
                            name="disabled-model", enabled=False)])
        await self.session.commit()
        with self.assertRaises(HTTPException):
            await personal_schedules.run_my_schedule("schedule", body={}, client=self.client, session=self.session)
        run = await self.session.scalar(select(models.AiScheduleRun))
        self.assertEqual(run.state, "failed")
        self.assertNotIn("disabled-fixture-key", json.dumps(run.receipt))
        self.assertEqual(self.calls, [])

    async def test_empty_schedule_model_follows_runtime_default_not_saved_composer_model(self):
        self.schedule.assignee_id = "local:pi"
        self.client.agent_models = {"pi": "removed-composer-model"}
        await self.session.commit()
        _, envelope = await self.run_schedule()
        self.assertEqual(envelope["modelName"], "")

    async def test_runner_offline_or_logged_out_waits_for_owner_device_instead_of_task_fallback(self):
        for case in ("other-device", "draining", "logged-out", "missing-agent"):
            with self.subTest(case=case):
                self.runner.client_id = "other" if case == "other-device" else "device"
                self.runner.dispatch_mode = "draining" if case == "draining" else "accepting"
                self.runner.agents = ([] if case == "missing-agent" else [
                    {"key": "codex", "name": "Codex", "auth": "unauthed" if case == "logged-out" else "authed"}])
                run, _ = await self.run_schedule()
                self.assertIsNone(run.finished_at)
        runs = (await self.session.scalars(select(models.AiScheduleRun))).all()
        self.assertEqual(len(runs), 4)
        self.assertEqual([run.state for run in runs], ["waiting"] * 4)

    async def test_capability_contract_reaches_device_and_actual_failure_is_retained(self):
        self.schedule.required_capabilities = ["browser"]
        await self.session.commit()
        run, envelope = await self.run_schedule()
        self.assertEqual(envelope["capabilities"], ["browser"])
        self.assertEqual(envelope["skills"], ["browser-use"])
        await schedule_conversations.claim(self.session, self.client, run.id, "capability-worker")
        await schedule_conversations.acknowledge(self.session, self.client, run.id, {
            "instanceId": "capability-worker", "state": "failed", "error": "本次所需能力尚未安装或授权"})
        await schedules.reconcile_runs(self.session, schedule_id="schedule")
        self.assertEqual(run.state, "failed")
        self.assertEqual(run.error, "本次所需能力尚未安装或授权")
        self.assertFalse(run.task_id)
        self.assertIsNone(await self.session.scalar(select(models.TaskEvent)))

    async def test_exhausted_quota_is_enforced_at_conversation_execution_and_failure_is_durable(self):
        self.session.add(models.AppSetting(key=client_access.POLICY_KEY, value=json.dumps({
            "tokenLimitEnabled": True, "monthlyTokenLimit": 10})))
        self.session.add(models.AIUsageEvent(
            idempotency_key="fixture-usage", billing_user_id="owner", total_tokens=10))
        await self.session.commit()
        run, _ = await self.run_schedule()
        await schedule_conversations.claim(self.session, self.client, run.id, "quota-worker")
        with self.assertRaises(client_access.ClientAccessError) as caught:
            await client_access.assert_quota(self.session, "owner")
        self.assertEqual(caught.exception.code, "TOKEN_QUOTA_EXCEEDED")
        await schedule_conversations.acknowledge(self.session, self.client, run.id, {
            "instanceId": "quota-worker", "state": "failed", "error": caught.exception.code})
        await schedules.reconcile_runs(self.session, schedule_id="schedule")
        self.assertEqual(run.state, "failed")
        self.assertEqual(run.error, "TOKEN_QUOTA_EXCEEDED")
        self.assertEqual(self.calls, [])

    async def test_account_change_does_not_reassign_saved_automation(self):
        self.client.user_ref = "another-account"
        await self.session.commit()
        with self.assertRaises(HTTPException) as caught:
            await personal_schedules.run_my_schedule("schedule", body={}, client=self.client, session=self.session)
        self.assertEqual(caught.exception.status_code, 404)
        self.assertIsNone(await self.session.scalar(select(models.AiScheduleRun)))

    async def test_other_device_or_changed_account_cannot_claim_private_prompt(self):
        run, _ = await self.run_schedule()
        for client in (models.Client(id="other", user_ref="owner"),
                       models.Client(id="device", user_ref="different-account")):
            with self.subTest(device=client.id, account=client.user_ref):
                with self.assertRaises(HTTPException) as caught:
                    await schedule_conversations.claim(self.session, client, run.id, "intruder")
                self.assertEqual(caught.exception.status_code, 404)
        self.assertNotIn("worker", run.receipt)

    async def test_conversation_handoff_works_with_and_without_legacy_capability_flag(self):
        for config in ({}, {"automationConversationV1": 1}):
            self.client.config = config
            await self.session.commit()
            run, envelope = await self.run_schedule()
            self.assertEqual(envelope["runId"], run.id)


if __name__ == "__main__":
    unittest.main()
