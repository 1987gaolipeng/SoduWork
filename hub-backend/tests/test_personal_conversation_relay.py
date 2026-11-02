import importlib.util
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path

from fastapi import FastAPI, HTTPException
import httpx
from sqlalchemy import select, create_engine, inspect
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from app.db import Base
from app.models import Client, User, AppSetting
from app.services import device_auth
from app.account_conversation_models import AccountConversation, PersonalConversationRelay as Relay
from app.api import personal_conversation_relay as api


class PersonalRelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.engine = create_async_engine('sqlite+aiosqlite:///' + str(Path(self.directory.name) / 'relay.db'))
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
                Client.__table__, User.__table__, AppSetting.__table__, AccountConversation.__table__, Relay.__table__]))
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.pc = Client(id='pc', name='My PC', user_ref='u1', auth_state='active')
        self.phone = Client(id='phone', user_ref='u1', auth_state='active')
        self.foreign = Client(id='foreign', user_ref='u2', auth_state='active')
        self.source = AccountConversation(id='conversation-1', owner_user_id='u1', source_client_id='pc',
            source_session_id='native-1', source_epoch='e1', source_revision=2, revision=8, state='idle')
        self.session.add_all([self.pc, self.phone, self.foreign, self.source,
            User(id='u1', username='first', display_name='First', is_active=True),
            User(id='u2', username='second', display_name='Second', is_active=True)])
        await self.session.commit()
        await api.poll(client=self.pc, session=self.session)

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()
        self.directory.cleanup()

    def body(self, **values):
        return dict(conversationId='conversation-1', targetClientId='pc', expectedRevision=8,
                    instruction='continue locally', **values)

    async def prepare(self, request='m1', body=None):
        return await api.prepare(request, body or self.body(), client=self.phone, session=self.session)

    async def test_native_target_requires_current_same_account_heartbeat(self):
        self.assertTrue((await api.target('conversation-1', self.phone, self.session))['available'])
        self.pc.config = {api.PREFIX: {'owner': 'u2', 'protocol': 1, 'at': api.now().timestamp()}}
        await self.session.commit()
        self.assertFalse((await api.target('conversation-1', self.phone, self.session))['available'])
        with self.assertRaises(HTTPException): await self.prepare()

    async def test_foreign_account_cannot_discover_send_claim_or_ack(self):
        for operation in [api.target('conversation-1', self.foreign, self.session),
                          api.prepare('other', self.body(), self.foreign, self.session)]:
            with self.assertRaises(HTTPException) as caught: await operation
            self.assertEqual(caught.exception.status_code, 404)
        row = await self.prepare()
        with self.assertRaises(HTTPException): await api.claim(row['id'], self.phone, self.session)
        with self.assertRaises(HTTPException): await api.acknowledge(row['id'], {'phase': 'accepted'}, self.foreign, self.session)

    async def test_immutable_retry_and_exact_target(self):
        first = await self.prepare()
        self.assertEqual(first['id'], (await self.prepare())['id'])
        changed = self.body(); changed['instruction'] = 'different'
        with self.assertRaises(HTTPException): await self.prepare(body=changed)
        changed = self.body(); changed['targetClientId'] = 'another-pc'
        with self.assertRaises(HTTPException): await self.prepare('another', changed)
        self.assertEqual(len(list((await self.session.scalars(select(Relay))).all())), 1)

    async def test_source_version_changes_reject_without_execution(self):
        first = await self.prepare()
        self.source.source_revision += 1
        await self.session.commit()
        with self.assertRaises(HTTPException): await api.claim(first['id'], self.pc, self.session)
        status = await api.status('m1', self.phone, self.session)
        self.assertEqual(status['phase'], 'rejected')

    async def test_claim_is_single_use_and_ack_is_idempotent(self):
        first = await self.prepare()
        self.assertEqual((await api.poll(self.pc, self.session))['requests'][0]['sourceSessionId'], 'native-1')
        await api.claim(first['id'], self.pc, self.session)
        with self.assertRaises(HTTPException): await api.claim(first['id'], self.pc, self.session)
        await api.acknowledge(first['id'], {'phase': 'accepted'}, self.pc, self.session)
        self.assertEqual((await api.acknowledge(first['id'], {'phase': 'accepted'}, self.pc, self.session))['phase'], 'accepted')
        with self.assertRaises(HTTPException): await api.acknowledge(first['id'], {'phase': 'rejected'}, self.pc, self.session)
        self.assertEqual((await api.status('m1', self.phone, self.session))['phase'], 'accepted')

    async def test_unclaimed_expiry_does_not_execute_after_reconnect(self):
        first = await self.prepare()
        row = await self.session.get(Relay, first['id'])
        row.expires_at = api.now() - timedelta(seconds=1)
        await self.session.commit()
        self.assertEqual((await api.poll(self.pc, self.session))['requests'], [])
        self.assertEqual((await api.status('m1', self.phone, self.session))['phase'], 'rejected')
        with self.assertRaises(HTTPException): await api.claim(first['id'], self.pc, self.session)

    async def test_uncertain_delivery_blocks_new_request(self):
        first = await self.prepare()
        with self.assertRaises(HTTPException): await self.prepare('second')
        await api.claim(first['id'], self.pc, self.session)
        await api.acknowledge(first['id'], {'phase': 'uncertain'}, self.pc, self.session)
        with self.assertRaises(HTTPException): await self.prepare('second')
        self.assertEqual((await api.poll(self.pc, self.session))['requests'], [])

    async def test_logout_or_reassigned_source_cannot_receive(self):
        first = await self.prepare()
        self.pc.user_ref = 'u2'
        await self.session.commit()
        self.assertEqual((await api.poll(self.pc, self.session))['requests'], [])
        with self.assertRaises(HTTPException): await api.claim(first['id'], self.pc, self.session)
        with self.assertRaises(HTTPException): await api.status('m1', self.phone, self.session)

    async def test_stale_busy_and_archived_sources_are_not_admitted(self):
        body = self.body(); body['expectedRevision'] = 7
        with self.assertRaises(HTTPException): await self.prepare(body=body)
        self.source.state = 'responding'
        await self.session.commit()
        with self.assertRaises(HTTPException): await self.prepare()
        self.source.state, self.source.archived = 'idle', True
        await self.session.commit()
        with self.assertRaises(HTTPException): await self.prepare()

    async def test_uncertain_resolution_is_explicit_and_never_replays(self):
        first = await self.prepare()
        with self.assertRaises(HTTPException):
            await api.resolve('m1', {'checkedOnSourcePC': True}, self.phone, self.session)
        await api.claim(first['id'], self.pc, self.session)
        await api.acknowledge(first['id'], {'phase': 'uncertain'}, self.pc, self.session)
        with self.assertRaises(HTTPException): await api.resolve('m1', {}, self.phone, self.session)
        with self.assertRaises(HTTPException):
            await api.resolve('m1', {'checkedOnSourcePC': True}, self.foreign, self.session)
        result = await api.resolve('m1', {'checkedOnSourcePC': True}, self.phone, self.session)
        self.assertEqual(result['phase'], 'closed')
        with self.assertRaises(HTTPException): await api.claim(first['id'], self.pc, self.session)
        self.assertEqual((await self.prepare('second'))['phase'], 'prepared')

    async def test_archiving_after_send_does_not_hide_the_receipt(self):
        first = await self.prepare()
        await api.claim(first['id'], self.pc, self.session)
        self.source.archived = True
        await self.session.commit()
        await api.acknowledge(first['id'], {'phase': 'accepted'}, self.pc, self.session)
        self.assertEqual((await api.status('m1', self.phone, self.session))['phase'], 'accepted')

    async def test_http_device_auth_and_cross_account_boundaries(self):
        application = FastAPI()
        application.include_router(api.router)
        async def database():
            yield self.session
        application.dependency_overrides[api.get_session] = database
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url='http://fixture') as http:
            base = '/api/v1/personal-conversation-relay'
            self.assertEqual((await http.get(base + '/targets/conversation-1')).status_code, 401)
            phone = {'Authorization': 'Device ' + device_auth.issue_session(self.phone)[0]}
            pc = {'Authorization': 'Device ' + device_auth.issue_session(self.pc)[0]}
            foreign = {'Authorization': 'Device ' + device_auth.issue_session(self.foreign)[0]}
            self.assertEqual((await http.get(base + '/targets/conversation-1', headers=foreign)).status_code, 404)
            self.assertTrue((await http.get(base + '/targets/conversation-1', headers=phone)).json()['available'])
            created = await http.post(base + '/requests/http-request', headers=phone, json=self.body())
            self.assertEqual(created.status_code, 200, created.text)
            rid = created.json()['id']
            self.assertEqual((await http.post(base + '/claims/' + rid, headers=phone)).status_code, 404)
            self.assertEqual((await http.post(base + '/claims/' + rid, headers=pc)).status_code, 200)
            self.assertEqual((await http.post(base + '/acks/' + rid, headers=pc, json={'phase': 'accepted'})).status_code, 200)
            self.assertEqual((await http.get(base + '/requests/http-request', headers=phone)).json()['phase'], 'accepted')
            self.pc.auth_version += 1
            await self.session.commit()
            self.assertEqual((await http.post(base + '/poll', headers=pc)).status_code, 401)


class MigrationTests(unittest.TestCase):
    def test_upgrade_matches_model_and_downgrade_preserves_other_tables(self):
        spec = importlib.util.spec_from_file_location('relay_migration',
            Path(__file__).resolve().parents[1] / 'migrations/versions/0074_personal_conversation_relay.py')
        migration = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(migration)
        engine = create_engine('sqlite://')
        try:
            with engine.begin() as connection:
                connection.exec_driver_sql('CREATE TABLE preserved (id INTEGER PRIMARY KEY)')
                with Operations.context(MigrationContext.configure(connection)):
                    migration.upgrade()
                    columns = {row['name'] for row in inspect(connection).get_columns(Relay.__tablename__)}
                    self.assertEqual(columns, set(Relay.__table__.columns.keys()))
                    migration.downgrade()
                self.assertEqual(inspect(connection).get_table_names(), ['preserved'])
        finally:
            engine.dispose()


if __name__ == '__main__':
    unittest.main()
