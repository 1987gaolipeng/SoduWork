"""Real HTTP/SQLite collaboration receipts; only WebSocket delivery is captured."""
import copy
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///:memory:'

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import automation_models  # Register foreign-key targets for this standalone fixture.
from app.api import tasks
from app.db import Base, get_session
from app.models import Client, Task, User
from app.realtime import hub
from app.services import device_auth


class ReceiptDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='soduwork-receipt-delivery-')
        self.engine = create_async_engine('sqlite+aiosqlite:///' +
                                         (Path(self.temp.name) / 'fixture.sqlite').as_posix())
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        self.devices = {'owner': 'executor', 'owner-other-device': 'executor',
                        'creator': 'creator', 'creator-other-device': 'creator',
                        'requester': 'requester', 'requester-other-device': 'requester',
                        'unrelated': 'unrelated'}
        async with self.sessions() as session, session.begin():
            session.add_all([User(id=user, username=user, display_name=user, is_active=True)
                             for user in set(self.devices.values())])
            session.add_all([Client(id=device, name=device, user_ref=user, auth_state='active')
                             for device, user in self.devices.items()])
            session.add(Task(id='task', title='Isolated delivery', status='doing', owner_client_id='owner',
                             created_by='creator', requester_user_id='requester', assignee_user_id='executor',
                             work_routing={'conversationTurn': {'conversationId': 'chat', 'turnId': 'turn',
                                                               'state': 'running', 'executor': 'native'}}))
        app = FastAPI()
        app.include_router(tasks.router)
        async def isolated_session():
            async with self.sessions() as session:
                yield session
        app.dependency_overrides[get_session] = isolated_session
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture')
        self.headers = {}
        async with self.sessions() as session:
            for device in self.devices:
                token, _ = device_auth.issue_session(await session.get(Client, device))
                self.headers[device] = {'Authorization': 'Device ' + token}

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()
        self.temp.cleanup()

    async def complete(self):
        return await self.http.post('/api/v1/tasks/task/conversation-turn', headers=self.headers['owner'],
            json={'action': 'complete', 'conversationId': 'chat', 'turnId': 'turn', 'executor': 'native'})

    async def test_completed_receipt_reaches_participants_all_devices_with_scoped_read_only_metadata(self):
        received = []
        async def capture(device, event, *, user_id=""):
            self.assertEqual(user_id, self.devices[device], "delivery must retain its account fence")
            # A fresh reader proves publishing happens after the receipt commits.
            async with self.sessions() as session:
                self.assertEqual((await session.get(Task, 'task')).work_routing['conversationTurn']['state'], 'completed')
            received.append((device, copy.deepcopy(event)))
        with patch.object(hub, 'publish', side_effect=capture):
            response = await self.complete()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['turn']['state'], 'completed')
        self.assertEqual(response.json()['task']['status'], 'doing', 'a receipt must not fake human acceptance')
        self.assertEqual({device for device, _ in received}, set(self.devices) - {'unrelated'})
        self.assertEqual(len(received), 6, 'a device with multiple roles receives one event')
        for device, event in received:
            self.assertEqual(event['type'], 'task.updated')
            payload = event['task']
            self.assertEqual(payload['workRouting']['conversationTurn']['state'], 'completed')
            self.assertEqual(payload['readOnly'], device != 'owner')
            self.assertEqual(payload['executionDeviceName'], 'owner')
            self.assertEqual(payload['assigneeName'], 'executor')
            self.assertEqual(payload['createdByName'], 'creator')
            self.assertEqual(payload['requesterName'], 'requester')
            self.assertNotIn('arrival', event, 'tracking updates must not auto-open another execution')
        for device in self.devices:
            result = await self.http.get('/api/v1/tasks/task', headers=self.headers[device])
            self.assertEqual(result.status_code, 404 if device == 'unrelated' else 200, result.text)
            if device != 'unrelated':
                self.assertEqual(result.json()['readOnly'], device != 'owner')

    async def test_realtime_failure_cannot_turn_a_committed_receipt_into_failed_execution(self):
        with patch.object(hub, 'publish', side_effect=RuntimeError('isolated transport failure')):
            result = await self.complete()
        self.assertEqual(result.status_code, 200, result.text)
        self.assertTrue(result.json()['ok'])
        async with self.sessions() as session:
            self.assertEqual((await session.get(Task, 'task')).work_routing['conversationTurn']['state'], 'completed')

    async def test_null_legacy_conversation_receipt_keeps_requirement_detail_readable(self):
        async with self.sessions() as session, session.begin():
            (await session.get(Task, 'task')).work_routing = {'conversationTurn': None}
        response = await self.http.get('/api/v1/tasks/task', headers=self.headers['owner'])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['requirementStage'], 'delivering')


if __name__ == '__main__':
    unittest.main()
