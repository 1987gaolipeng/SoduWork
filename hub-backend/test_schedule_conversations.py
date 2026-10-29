"""Automation conversation protocol, isolated from the real Hub/Runner and DB."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from fastapi import HTTPException
from app import models
from app.services import schedule_conversations as chats, schedules


class ConversationProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine('sqlite+aiosqlite:///:memory:')
        async with self.engine.begin() as conn:
            for table in [models.Client.__table__, models.AiSchedule.__table__, models.AiScheduleRun.__table__]:
                await conn.run_sync(table.create)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.client = models.Client(id='device', config={'automationConversationV1': 1}, agent_models={'pi': 'chosen-model'})
        self.schedule = models.AiSchedule(id='schedule', owner_client_id='device', title='自动化标题',
            note='完整需求与验收\n材料说明', assignee_id='local:pi', enabled=False,
            plugin_inputs={'question': '全部保留'}, required_capabilities=[])
        self.run = models.AiScheduleRun(id='run', schedule_id='schedule', owner_client_id='device',
            state='waiting', receipt={})
        self.session.add_all([self.client, self.schedule, self.run]); await self.session.commit()

    async def asyncTearDown(self):
        await self.session.close(); await self.engine.dispose()

    async def prepare(self):
        return await chats.prepare(self.session, self.schedule, self.client, None, 'run', 'pi', {})

    async def test_direct_execution_does_not_create_task(self):
        with patch.object(schedules, 'validate_execution', AsyncMock()), \
                patch.object(schedules, 'task_actor', return_value=('owner', 'Owner')), \
                patch.object(schedules, '_push_new', AsyncMock()) as push:
            result = await schedules.run_one(self.session, self.schedule, schedule_run_id='run')
        self.assertEqual(result['executionMode'], chats.PROTOCOL)
        self.assertNotIn('taskId', result); self.assertEqual(self.run.task_id, '')
        push.assert_not_awaited()

    async def test_envelope_preserves_input_and_selected_model_and_reuses_occurrence(self):
        await self.prepare()
        envelope = self.run.receipt['conversationInput']
        self.assertIn(self.schedule.note, envelope['text']); self.assertIn('全部保留', envelope['text'])
        self.assertEqual(envelope['modelName'], 'chosen-model'); self.assertEqual(envelope['adapterId'], 'pi')
        self.schedule.note = 'later edit'
        await self.prepare(); self.assertEqual(self.run.receipt['conversationInput'], envelope)

    async def test_old_devices_and_explicit_workflow_do_not_bypass_original_contract(self):
        self.assertEqual(chats.adapter_for(self.schedule, self.client), 'pi')
        self.client.config = {}; self.assertEqual(chats.adapter_for(self.schedule, self.client), '')
        self.client.config = {'automationConversationV1': 1}
        for field in ['flow', 'plugin_binding_id']:
            setattr(self.schedule, field, True if field == 'flow' else 'binding')
            self.assertEqual(chats.adapter_for(self.schedule, self.client), '')
            setattr(self.schedule, field, False if field == 'flow' else '')
        self.schedule.assignee_id = 'runner:invalid'
        self.assertEqual(chats.adapter_for(self.schedule, self.client), '')
        self.schedule.assignee_id = 'runner:remote:pi'
        with patch('app.services.runner_hub.get', return_value=SimpleNamespace(client_id='other')):
            self.assertEqual(chats.adapter_for(self.schedule, self.client), '')

    async def test_owner_inbox_opts_in_without_exposing_other_devices(self):
        await self.prepare(); self.client.config = {'otherSetting': 'keep'}
        items = await chats.inbox(self.session, self.client)
        self.assertEqual(items, [{'id': 'run', 'state': 'waiting'}])
        self.assertEqual(self.client.config['otherSetting'], 'keep')
        self.assertEqual(self.client.config['automationConversationV1'], 1)

    async def test_claim_is_owner_scoped_and_exclusive(self):
        await self.prepare()
        with self.assertRaises(HTTPException) as error:
            await chats.claim(self.session, SimpleNamespace(id='other'), 'run', 'worker')
        self.assertEqual(error.exception.status_code, 404)
        first = await chats.claim(self.session, self.client, 'run', 'worker')
        self.assertEqual(first['input']['runId'], 'run')
        second = await chats.claim(self.session, self.client, 'run', 'other-worker')
        self.assertTrue(second['busy'])

    async def test_claim_reports_authoritative_trigger_even_when_envelope_claims_manual(self):
        await self.prepare()
        self.run.trigger = 'timer'
        receipt = dict(self.run.receipt)
        receipt['conversationInput'] = {**receipt['conversationInput'], 'trigger': 'manual', 'accessMode': 'full'}
        self.run.receipt = receipt
        await self.session.commit()
        result = await chats.claim(self.session, self.client, 'run', 'worker')
        self.assertEqual(result.get('trigger'), 'timer')

    async def test_completion_is_not_task_acceptance_and_is_idempotent(self):
        await self.prepare(); await chats.claim(self.session, self.client, 'run', 'worker')
        body = {'instanceId': 'worker', 'conversationId': 'ordinary-chat', 'state': 'succeeded'}
        await chats.acknowledge(self.session, self.client, 'run', body)
        self.assertEqual(self.run.state, 'succeeded'); self.assertIsNotNone(self.run.finished_at)
        self.assertEqual(self.run.task_id, ''); self.assertEqual(self.run.workflow_run_id, '')
        await chats.acknowledge(self.session, self.client, 'run', {**body, 'state': 'running'})
        self.assertEqual(self.run.state, 'succeeded')
        result = schedules.run_to_api(self.run)
        self.assertEqual(result['conversationId'], 'ordinary-chat')

    async def test_missing_chat_invalid_state_wrong_worker_and_replacement_are_rejected(self):
        await self.prepare(); await chats.claim(self.session, self.client, 'run', 'worker')
        valid = {'instanceId': 'worker', 'conversationId': 'chat', 'state': 'running'}
        for body in [{**valid, 'state': 'unknown'}, {**valid, 'conversationId': ''}, {**valid, 'instanceId': 'intruder'}]:
            with self.assertRaises(HTTPException):
                await chats.acknowledge(self.session, self.client, 'run', body)
        await chats.acknowledge(self.session, self.client, 'run', valid)
        with self.assertRaises(HTTPException):
            await chats.acknowledge(self.session, self.client, 'run', {**valid, 'conversationId': 'different'})

    async def test_waiting_input_and_failure_record_truthful_state(self):
        await self.prepare(); await chats.claim(self.session, self.client, 'run', 'worker')
        await chats.acknowledge(self.session, self.client, 'run',
            {'instanceId': 'worker', 'conversationId': 'chat', 'state': 'waiting'})
        self.assertIsNone(self.run.finished_at)
        await chats.acknowledge(self.session, self.client, 'run',
            {'instanceId': 'worker', 'conversationId': 'chat', 'state': 'failed', 'error': 'failure'})
        self.assertEqual(self.run.error, 'failure'); self.assertIsNotNone(self.run.finished_at)

if __name__ == '__main__':
    unittest.main()
