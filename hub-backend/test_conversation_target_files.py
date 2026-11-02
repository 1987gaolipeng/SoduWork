"""Authenticated follow-up files through a separate real Runner process."""
import asyncio
import base64
import json
from pathlib import Path
import unittest

import test_conversation_handoffs as fixture
from app import db, models
from app.api import cloud_conversations
from app.automation_models import RunnerNode
from app.services import runner_hub, device_auth


class TargetFileTests(unittest.IsolatedAsyncioTestCase):
    async def test_cloud_and_owned_pc_keep_target_session_and_follow_up_bytes(self):
        worker = fixture.HandoffTests()
        await worker.asyncSetUp()
        try:
            worker.app.include_router(cloud_conversations.router)
            worker.runner.caps.extend(['turnFiles1', 'admit1', 'executionSelection1'])
            async with db.SessionLocal() as session:
                session.add(models.Client(id='file-pc', user_ref='owner', auth_state='active'))
                await session.commit()
            for kind in ('cloud', 'work-computer'):
                worker.runner.client_id = 'file-pc' if kind == 'work-computer' else ''
                worker.runner.tags = [runner_hub.CLIENT_TAG] if worker.runner.client_id else []
                async with db.SessionLocal() as session:
                    row = await session.get(RunnerNode, 'cloud')
                    row.client_id = worker.runner.client_id
                    await session.commit()
                body = dict(sessionId='target-'+kind, agentId='codex', model='',
                    text='CLOUD_NEW_TEST: write a report', targetRunnerId='cloud', targetRunnerKind=kind)
                response = await worker.http.post('/api/v1/cloud-conversations/files-'+kind,
                    data={'options': json.dumps(body)})
                self.assertEqual(response.status_code, 200, response.text)
                receipt = response.json()
                self.assertEqual(receipt['phase'], 'committed', receipt)
                ref, task = receipt['ref'], receipt['taskId']
                await worker.complete(ref)
                before = worker.peer.calls.count('job.dispatch')
                content = ('proof-'+kind).encode()
                message = {'text': 'Read the additional proof.', 'messageId': 'files-'+kind,
                    'files': [{'name': 'proof.txt', 'data': base64.b64encode(content).decode(), 'contentType': 'text/plain'}]}
                result = await worker.http.post('/api/v1/tasks/'+task+'/ai-say', json=message)
                self.assertEqual(result.status_code, 200, result.text)
                self.assertEqual(result.json()['delivery'], 'accepted', result.text)
                await worker.complete(ref)
                raw = await asyncio.to_thread(worker.peer.call, worker.runner, 'job.session', {'ref': ref})
                users = [row for row in raw['data']['items'] if row.get('kind') == 'user']
                self.assertEqual(len(users), 2, users)
                self.assertEqual(Path(users[-1]['attachments'][0]['path']).read_bytes(), content)
                replay = await worker.http.get('/api/v1/tasks/'+task+'/ai-session')
                self.assertNotIn(str(fixture.WORK), replay.text)
                same = await worker.http.post('/api/v1/tasks/'+task+'/ai-say', json=message)
                self.assertTrue(same.json()['duplicate'], same.text)
                message['files'][0]['data'] = base64.b64encode(b'changed').decode()
                changed = await worker.http.post('/api/v1/tasks/'+task+'/ai-say', json=message)
                self.assertEqual(changed.status_code, 409, changed.text)
                self.assertEqual(worker.peer.calls.count('job.dispatch'), before)
                if kind == 'work-computer':
                    async with db.SessionLocal() as session:
                        pc = await session.get(models.Client, 'file-pc')
                        pc_token = device_auth.issue_session(pc)[0]
                    owner_turn = await worker.http.post('/api/v1/tasks/'+task+'/ai-say',
                        headers={'Authorization': 'Device '+pc_token},
                        json={**message, 'messageId': 'files-source-pc', 'text': 'Continue on this PC.'})
                    self.assertEqual(owner_turn.status_code, 200, owner_turn.text)
                    self.assertEqual(owner_turn.json()['delivery'], 'accepted', owner_turn.text)
                    await worker.complete(ref)
                    raw = await asyncio.to_thread(worker.peer.call, worker.runner, 'job.session', {'ref': ref})
                    users = [row for row in raw['data']['items'] if row.get('kind') == 'user']
                    self.assertEqual(len(users), 3, users)
                    self.assertEqual(Path(users[-1]['attachments'][0]['path']).read_bytes(), b'changed')
                    self.assertEqual(worker.peer.calls.count('job.dispatch'), before)
        finally:
            await worker.asyncTearDown()
