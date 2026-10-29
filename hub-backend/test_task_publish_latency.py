"""Task fanout must not serialize slow devices or share recipient ACL payloads."""
import asyncio
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
from app.services import task_access, task_requirement_projection, task_requirements, requirement_edit_policy


class TaskPublishLatencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_device_does_not_delay_other_recipients(self):
        clients = [SimpleNamespace(id=str(i), user_ref=str(i)) for i in range(3)]
        task = SimpleNamespace(owner_client_id='0', owner_user_id='0', assignee_user_id='1')
        blocked, other_sent, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        events = {}
        async def publish(device, event, *, user_id):
            self.assertEqual(user_id, device)
            events[device] = event
            if device == '0':
                blocked.set()
                await release.wait()
            else:
                other_sent.set()
        async def decorate(session, client, task, api, **_prepared):
            return {**api, 'recipient':client.id}
        with patch.object(task_access, 'recipient_clients', AsyncMock(return_value=clients)), \
             patch.object(task_access, '_name_map', AsyncMock(return_value={})), \
             patch.object(task_access, '_device_name_map', AsyncMock(return_value={})), \
             patch.object(task_access, 'decorate', side_effect=lambda task, api, client, *args: dict(api)), \
             patch.object(task_requirement_projection, 'decorate_many', AsyncMock()), \
             patch.object(requirement_edit_policy, 'decorate_many', AsyncMock()), \
             patch.object(task_requirements, 'prepare_notifications', AsyncMock(return_value={c.id:None for c in clients})), \
             patch.object(task_requirements, 'decorate', side_effect=decorate), \
             patch.object(task_access.hub, 'publish', side_effect=publish):
            pending = asyncio.create_task(task_access.publish_task(None, task, 'task.updated', {'id':'t'}, arrival='assign'))
            try:
                await asyncio.wait_for(blocked.wait(), 1)
                await asyncio.wait_for(other_sent.wait(), 1)
            finally:
                release.set()
                await pending
        self.assertEqual(set(events), {'0', '1', '2'})
        for device, event in events.items():
            self.assertEqual(event['task']['recipient'], device)
            self.assertEqual(event.get('arrival'), 'assign' if device == '1' else None)
