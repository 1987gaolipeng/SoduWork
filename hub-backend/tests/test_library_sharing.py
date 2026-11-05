"""Organization sharing through the real router and isolated durable records."""
import os
import base64
import asyncio
import io
import unittest
import zipfile
from unittest.mock import AsyncMock, patch

os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///:memory:'

import httpx
from fastapi import FastAPI, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app import models, realtime
from app.api.library import router
from app.db import Base, get_session
from app.deps import current_client
from app.library_models import LibraryFolder, LibraryItem
from app.services import library_sharing, library_storage, mate_messages, mate_message_files, storage, task_assignment
from app.services import client_domain_events


class LibrarySharingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        await client_domain_events.stop()
        self.engine = create_async_engine('sqlite+aiosqlite:///:memory:', poolclass=StaticPool)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda conn: Base.metadata.create_all(conn, tables=[
                models.User.__table__, models.Client.__table__, models.Attachment.__table__, models.MateMessage.__table__,
                LibraryItem.__table__, LibraryFolder.__table__]))
        async with self.sessions() as session:
            for uid, org, active in [('sender', 'org-one', True), ('alice', 'org-one', True),
                                     ('bob', 'org-one', True), ('outsider', 'org-two', True),
                                     ('inactive', 'org-one', False)]:
                session.add(models.User(id=uid, username=uid, display_name=uid.title(), org_id=org, is_active=active))
            session.add(LibraryItem(id='fixture-file', owner_key='sender', filename='fixture.txt',
                                    title='Fixture file', storage_key='source-object', backend='local',
                                    content_type='text/plain', size=12))
            session.add(LibraryItem(id='other-file', owner_key='alice', filename='private.txt',
                                    title='Private file', storage_key='private-object', backend='local', size=7))
            session.add_all([models.Client(id='sender-device', user_ref='sender', auth_state='active'),
                             models.Client(id='sender-other-device', user_ref='sender', auth_state='active'),
                             models.Client(id='alice-device', user_ref='alice', auth_state='active'),
                             models.Client(id='bob-device', user_ref='bob', auth_state='active')])
            await session.commit()
        self.objects = {}

        def put(key, data, content_type):
            self.objects[key] = data
            return 'local'

        self.patches = [patch.object(library_storage, 'read_bytes', return_value=b'file content'),
                        patch.object(storage, 'put', side_effect=put),
                        patch.object(storage, 'delete', side_effect=lambda key, backend: self.objects.pop(key, None)),
                        patch.object(task_assignment, 'active_devices', new=AsyncMock(return_value=[]))]
        for replacement in self.patches:
            replacement.start()
        app = FastAPI()
        app.include_router(router)

        async def session_override():
            async with self.sessions() as session:
                yield session

        async def client_override(request: Request):
            owner = request.headers.get('X-Test-User', 'sender')
            return models.Client(id='device-' + owner, user_ref=owner)

        app.dependency_overrides[get_session] = session_override
        app.dependency_overrides[current_client] = client_override
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url='http://fixture')

    async def asyncTearDown(self):
        await client_domain_events.stop()
        for replacement in reversed(self.patches):
            replacement.stop()
        await self.http.aclose()
        await self.engine.dispose()

    async def post(self, ids, item='fixture-file', note='Please review'):
        return await self.http.post('/api/v1/library/items/' + item + '/share', json={'recipientUserIds': ids, 'note': note})

    async def test_single_and_batch_shares_wake_sender_devices_without_changing_legacy_notice(self):
        for batch in (False, True):
            with patch.object(client_domain_events.native_discovery, 'wake', new_callable=AsyncMock) as wake:
                if batch:
                    response = await self.http.post('/api/v1/library/items/batch-share',
                        json={'itemIds': ['fixture-file'], 'recipientUserIds': ['alice'], 'note': 'Batch'})
                else:
                    response = await self.post(['alice'])
                self.assertEqual(response.status_code, 200, response.text)
                wake.assert_not_awaited()
                await client_domain_events.flush_for_test(self.sessions)
                self.assertEqual({call.args for call in wake.await_args_list},
                                 {('sender-device', 'sender', 'team-messages'),
                                  ('sender-other-device', 'sender', 'team-messages'),
                                  ('alice-device', 'alice', 'team-messages')})

    async def records(self, model):
        async with self.sessions() as session:
            return list((await session.execute(select(model))).scalars())

    async def local_share(self, **changes):
        body = dict(requestId='6107d6aa-adbf-45ed-8c41-e3de833ee8a3', localItemId='local-fixture',
                    filename='renamed.txt', contentType='text/plain', data=base64.b64encode(b'local exact bytes').decode(),
                    recipientUserIds=['alice', 'bob'], note='Please review')
        body.update(changes)
        return await self.http.post('/api/v1/library/share-local', json=body)

    async def test_local_sharing_creates_only_notification_snapshots_without_remote_library_storage(self):
        before = {row.id for row in await self.records(LibraryItem)}
        with patch.object(library_storage, 'read_bytes', side_effect=AssertionError('No remote library read')):
            response = await self.local_share()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['shared'], 2)
        self.assertEqual({row.id for row in await self.records(LibraryItem)}, before)
        attachments = await self.records(models.Attachment)
        self.assertEqual(len(attachments), 2)
        self.assertTrue(all(row.filename == 'renamed.txt' for row in attachments))
        self.assertTrue(all(self.objects[row.storage_key] == b'local exact bytes' for row in attachments))
        async with self.sessions() as session:
            with patch('app.services.team._company_members', new=AsyncMock(return_value=[
                    models.User(id='sender'), models.User(id='alice'), models.User(id='bob')])):
                owned = next(row for row in attachments if row.evidence_meta['recipientId'] == 'alice')
                result = await mate_message_files.access(session, models.Client(id='alice-device', user_ref='alice'), owned.id)
                self.assertEqual(result['filename'], 'renamed.txt')
                with self.assertRaises(Exception) as denied:
                    await mate_message_files.access(session, models.Client(id='bob-device', user_ref='bob'), owned.id)
                self.assertEqual(denied.exception.status_code, 404)

    async def test_local_share_retry_is_bound_to_content_members_and_sender(self):
        first = await self.local_share()
        self.assertEqual(first.status_code, 200, first.text)
        messages = {row.id for row in await self.records(models.MateMessage)}
        objects = dict(self.objects)
        retry = await self.local_share(recipientUserIds=['bob', 'alice', 'alice'])
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertTrue(retry.json()['reused'])
        self.assertEqual({row.id for row in await self.records(models.MateMessage)}, messages)
        self.assertEqual(self.objects, objects)
        for changes in [dict(data=base64.b64encode(b'changed').decode()), dict(filename='other.txt'),
                        dict(recipientUserIds=['alice']), dict(note='changed')]:
            response = await self.local_share(**changes)
            self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(self.objects, objects)
        response = await self.http.post('/api/v1/library/share-local', headers={'X-Test-User': 'alice'}, json={
            'requestId': '6107d6aa-adbf-45ed-8c41-e3de833ee8a3', 'localItemId': 'local-fixture',
            'filename': 'renamed.txt', 'data': base64.b64encode(b'alice own file').decode(), 'recipientUserIds': ['bob']})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(await self.records(models.MateMessage)), 3)
        self.assertTrue(all(self.objects[key] == value for key, value in objects.items()))

    async def test_local_share_rejects_invalid_members_ids_names_and_encoding_without_side_effects(self):
        for changes, status in [(dict(recipientUserIds=['alice', 'outsider']), 403),
                                (dict(requestId='bad'), 400), (dict(filename='../bad.txt'), 400),
                                (dict(data='not-base64'), 400), (dict(recipientUserIds=['sender']), 400)]:
            response = await self.local_share(**changes)
            self.assertEqual(response.status_code, status, response.text)
            self.assertEqual(await self.records(models.MateMessage), [])
            self.assertEqual(self.objects, {})

    async def test_local_share_failure_rolls_back_every_recipient_and_can_retry(self):
        original = mate_messages.create
        attempts = 0
        async def fail_second(*args, **kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 2:
                raise RuntimeError('isolated local sharing failure')
            return await original(*args, **kwargs)
        with patch.object(mate_messages, 'create', side_effect=fail_second):
            self.assertEqual((await self.local_share()).status_code, 500)
        self.assertEqual(await self.records(models.MateMessage), [])
        self.assertEqual(await self.records(models.Attachment), [])
        self.assertEqual(self.objects, {})
        self.assertEqual((await self.local_share()).status_code, 200)

    async def test_concurrent_local_share_retries_commit_and_publish_only_once(self):
        async def devices(session, user_id):
            return [models.Client(id='device-' + user_id, user_ref=user_id)]
        publish = AsyncMock()
        with patch.object(task_assignment, 'active_devices', side_effect=devices), \
                patch.object(realtime.hub, 'is_online', return_value=True), \
                patch.object(realtime.hub, 'publish', publish):
            responses = await asyncio.gather(self.local_share(), self.local_share())
        self.assertTrue(all(response.status_code == 200 for response in responses), [r.text for r in responses])
        self.assertEqual(publish.await_count, 2)
        self.assertEqual(len(await self.records(models.MateMessage)), 2)
        self.assertEqual(len(await self.records(models.Attachment)), 2)
        self.assertEqual(len(self.objects), 2)

    async def test_directory_contains_only_active_same_organization_members(self):
        response = await self.http.get('/api/v1/library/share-members')
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body['meId'], 'sender')
        self.assertEqual({row['id'] for row in body['members']}, {'sender', 'alice', 'bob'})

    async def test_two_recipients_receive_separate_durable_messages_and_files(self):
        response = await self.post(['alice', 'bob'])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['shared'], 2)
        messages = await self.records(models.MateMessage)
        attachments = await self.records(models.Attachment)
        self.assertEqual({row.recipient_id for row in messages}, {'alice', 'bob'})
        self.assertTrue(all(row.sender_id == 'sender' and row.status == 'accepted' for row in messages))
        self.assertTrue(all('Please review' in row.text for row in messages))
        self.assertEqual(len(attachments), 2)
        self.assertEqual({row.evidence_meta['recipientId'] for row in attachments}, {'alice', 'bob'})
        self.assertTrue(all(self.objects[row.storage_key] == b'file content' for row in attachments))

    async def test_sender_and_recipient_can_list_and_access_the_shared_attachment(self):
        response = await self.post(['alice'])
        self.assertEqual(response.status_code, 200, response.text)

        async with self.sessions() as session:
            sender = models.Client(id='sender-device', user_ref='sender')
            recipient = models.Client(id='alice-device', user_ref='alice')
            sent = await mate_messages.list_for(session, sender, 'sent')
            received = await mate_messages.list_for(session, recipient, 'received')

            self.assertEqual(len(sent['items']), 1)
            self.assertEqual(len(received['items']), 1)
            sent_attachment = sent['items'][0]['attachments'][0]
            received_attachment = received['items'][0]['attachments'][0]
            self.assertEqual(sent_attachment, received_attachment)

            sender_file = await mate_message_files.access(session, sender, sent_attachment['id'])
            recipient_file = await mate_message_files.access(session, recipient, received_attachment['id'])
            self.assertEqual(sender_file['filename'], 'fixture.txt')
            self.assertEqual(recipient_file['filename'], 'fixture.txt')
            self.assertEqual(sender_file['url'], recipient_file['url'])

            with self.assertRaises(Exception) as denied:
                await mate_message_files.access(session, models.Client(id='bob-device', user_ref='bob'), sent_attachment['id'])
            self.assertEqual(denied.exception.status_code, 404)

    async def test_realtime_shares_identify_each_recipient_for_account_filtering(self):
        async def devices(session, user_id):
            return [models.Client(id='device-' + user_id, user_ref=user_id)]

        publish = AsyncMock()
        with patch.object(task_assignment, 'active_devices', side_effect=devices), \
                patch.object(realtime.hub, 'is_online', return_value=True), \
                patch.object(realtime.hub, 'publish', publish):
            response = await self.post(['alice', 'bob'])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(publish.await_count, 2)
        for call in publish.await_args_list:
            device_id, event = call.args
            expected = device_id.removeprefix('device-')
            self.assertIn(expected, {'alice', 'bob'})
            self.assertEqual(event.get('senderId'), 'sender')
            self.assertEqual(event.get('recipientId'), expected)
            self.assertEqual(event.get('recipientName'), expected.title())
        self.assertEqual({row.recipient_id for row in await self.records(models.MateMessage)}, {'alice', 'bob'})

    async def test_repeated_recipient_ids_do_not_duplicate_messages(self):
        response = await self.post(['alice', 'alice', 'bob'])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['shared'], 2)
        self.assertEqual(len(await self.records(models.MateMessage)), 2)

    async def test_empty_self_and_unknown_members_are_rejected_without_partial_sharing(self):
        for ids, expected in [([], 400), (['sender'], 400), (['alice', 'outsider'], 403),
                              (['alice', 'inactive'], 403), (['missing'], 403)]:
            with self.subTest(ids=ids):
                self.assertEqual((await self.post(ids)).status_code, expected)
                self.assertEqual(await self.records(models.MateMessage), [])
                self.assertEqual(self.objects, {})

    async def test_another_users_file_cannot_be_shared(self):
        self.assertEqual((await self.post(['bob'], item='other-file')).status_code, 404)
        self.assertEqual(await self.records(models.MateMessage), [])
        self.assertEqual(self.objects, {})

    async def test_folder_share_always_creates_zip_and_includes_nested_files(self):
        async with self.sessions() as session:
            session.add(LibraryFolder(id='share-folder', owner_key='sender', name='reports', backend='local'))
            session.add(LibraryFolder(id='share-child', owner_key='sender', parent_id='share-folder', name='2026', backend='local'))
            session.add(LibraryItem(id='share-root-file', owner_key='sender', folder_id='share-folder', filename='summary.md',
                                    title='Summary', storage_key='summary-object', backend='local', content_type='text/markdown', size=12))
            session.add(LibraryItem(id='share-nested-file', owner_key='sender', folder_id='share-child', filename='detail.txt',
                                    title='Detail', storage_key='detail-object', backend='local', content_type='text/plain', size=12))
            await session.commit()

        async with self.sessions() as session:
            result = await library_sharing.share_folders(
                session, models.Client(id='sender-device', user_ref='sender'), ['share-folder'], ['alice'],
            )
        self.assertTrue(result['packaged'])
        self.assertTrue(result['filename'].endswith('.zip'))
        self.assertEqual({entry['filename'] for entry in result['files']}, {'summary.md', 'detail.txt'})
        attachments = await self.records(models.Attachment)
        self.assertEqual(len(attachments), 1)
        archive = zipfile.ZipFile(io.BytesIO(self.objects[attachments[0].storage_key]))
        self.assertEqual(set(archive.namelist()), {'summary.md', 'detail.txt'})

    async def test_local_folder_snapshot_preserves_relative_zip_path_and_rejects_traversal(self):
        encoded = base64.b64encode(b'hello').decode()
        snapshots, ids = library_sharing.parse_local_snapshots([{
            'localItemId': 'local-nested-file', 'filename': 'reports/2026/detail.md',
            'contentType': 'text/markdown', 'data': encoded,
        }])
        self.assertEqual(ids, ['local-nested-file'])
        _, archive_data, manifest = library_sharing._archive_bytes(snapshots)
        self.assertEqual(manifest['files'][0]['filename'], 'reports/2026/detail.md')
        archive = zipfile.ZipFile(io.BytesIO(archive_data))
        self.assertEqual(archive.namelist(), ['reports/2026/detail.md'])
        with self.assertRaises(Exception):
            library_sharing.parse_local_snapshots([{
                'localItemId': 'local-unsafe', 'filename': '../secret.txt', 'data': encoded,
            }])

    async def test_batch_share_folder_endpoint_forces_zip_for_a_single_file_folder(self):
        async with self.sessions() as session:
            session.add(LibraryFolder(id='single-share-folder', owner_key='sender', name='single', backend='local'))
            session.add(LibraryItem(id='single-share-file', owner_key='sender', folder_id='single-share-folder',
                                    filename='only.md', title='Only', storage_key='only-object', backend='local',
                                    content_type='text/markdown', size=5))
            await session.commit()

        response = await self.http.post('/api/v1/library/items/batch-share', json={
            'folderIds': ['single-share-folder'], 'recipientUserIds': ['alice'],
            'requestId': 'f8b4e70d-6f2e-43d5-9d0a-2b3229fca4fd',
        })
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body['packaged'])
        self.assertTrue(body['filename'].endswith('.zip'))
        self.assertEqual(body['folderIds'], ['single-share-folder'])
        self.assertEqual(len(self.objects), 1)

    async def test_message_failure_rolls_back_all_recipients_and_uploaded_snapshots(self):
        original = mate_messages.create
        attempts = 0

        async def fail_second(*args, **kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 2:
                raise RuntimeError('isolated durable write failure')
            return await original(*args, **kwargs)

        with patch.object(mate_messages, 'create', side_effect=fail_second):
            self.assertEqual((await self.post(['alice', 'bob'])).status_code, 500)
        self.assertEqual(await self.records(models.MateMessage), [])
        self.assertEqual(await self.records(models.Attachment), [])
        self.assertEqual(self.objects, {}, 'A failed share must remove every file snapshot, including the failing recipient')


if __name__ == '__main__':
    unittest.main()
