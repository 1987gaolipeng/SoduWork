"""Auth fences and change hints share real transactions and a private Redis."""
import asyncio
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ.update(DATABASE_URL='sqlite+aiosqlite:///:memory:', CLUSTER_REDIS_URL='',
                  AUTH_SECRET='isolated-combined-auth-push', ADMIN_PASS='isolated-combined-auth-push')
import test_auth_cache_transactions as transactions
from app import models
from app.config import get_settings
from app.services import auth_cache_transactions, shared_auth_cache
from app.services import automation_inbox_events as inbox
from app.services import cloud_sync_notifications as cloud


class AuthCachePushTransactionTests(transactions.AuthCacheTransactionTests):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        # Use the actual configured-cache getter with enabled reads and fencing.
        # Its Redis connection is the fixture's unique private Unix socket.
        self.cache_patch.stop()
        self.transaction_patch.stop()
        self.enabled = [patch.object(get_settings(), 'auth_cache_enabled', True),
                        patch.object(get_settings(), 'auth_cache_fencing_enabled', True),
                        patch.object(shared_auth_cache, '_cache', self.first)]
        for item in self.enabled:
            item.start()
        self.assertIs(shared_auth_cache.get_cache(), self.first)
        self.assertIs(auth_cache_transactions.get_cache(), self.first)
        self.assertTrue(shared_auth_cache.reads_enabled())
        self.assertEqual(await self.redis.ping(), True)
        tables = {models.AiSchedule.__table__, models.AiScheduleRun.__table__, models.Task.__table__}
        pending = list(tables)
        while pending:
            for key in pending.pop().foreign_keys:
                if key.column.table not in tables:
                    tables.add(key.column.table)
                    pending.append(key.column.table)
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda c: models.Base.metadata.create_all(c, tables=list(tables)))
        inbox.start()
        cloud.start()
        self.inbox_transport = AsyncMock()
        self.cloud_transport = AsyncMock()
        self.transport_patches = [patch.object(inbox, '_publish', self.inbox_transport),
                                  patch.object(cloud, 'publish', self.cloud_transport),
                                  patch('app.services.cluster_bus.bus.enabled', True)]
        for item in self.transport_patches:
            item.start()
        async with self.read_sessions() as session:
            session.add(models.AiSchedule(id='plan', owner_client_id='pc', owner_user_id='alice'))
            session.add(models.Task(id='task-a', title='initial', owner_client_id='pc'))
            await session.flush()
            session.add(models.AiScheduleRun(id='run', schedule_id='plan', owner_client_id='pc',
                owner_user_id='alice', state='waiting', receipt={}))
            await session.commit()
        await self.drain()
        self.inbox_transport.reset_mock()
        self.cloud_transport.reset_mock()
        self.assertTrue((await shared_auth_cache.load('user', 'alice', self.database_loader('user', 'alice')))['is_active'])
        self.assertTrue((await self.snapshot('user', 'alice', peer=True))['is_active'])
        self.callback_order = []
        self.original_release = self.first.release
        async def release(token, subjects):
            self.callback_order.append('fence-release')
            await self.original_release(token, subjects)
        self.first.release = release

    async def asyncTearDown(self):
        await inbox.stop()
        await cloud.stop()
        for item in reversed(self.transport_patches):
            item.stop()
        for item in reversed(self.enabled):
            item.stop()
        await super().asyncTearDown()

    async def drain(self):
        await inbox.flush_for_test()
        await cloud.flush_for_test()

    async def change(self, session):
        user = await session.get(models.User, 'alice')
        run = await session.get(models.AiScheduleRun, 'run')
        task = await session.get(models.Task, 'task-a')
        user.is_active = False
        run.receipt = {'executionMode': 'soduwork.automation-conversation/v1'}
        run.state = 'running'
        task.title = 'changed'
        await session.flush()

    async def check_pending(self):
        self.assertEqual(await self.redis.hlen(self.first.scope('user', 'alice')), 2)
        await self.assert_fenced('user', 'alice')
        await asyncio.sleep(.30)
        self.inbox_transport.assert_not_awaited()
        self.cloud_transport.assert_not_awaited()
        self.assertEqual(self.callback_order, [])

    async def check_finished(self, *, changed, hints):
        self.assertEqual(await self.redis.hlen(self.first.scope('user', 'alice')), 1)
        self.assertEqual(self.callback_order, ['fence-release'])
        self.assertEqual((await self.assert_shared_again('user', 'alice'))['is_active'], not changed)
        await self.drain()
        if hints:
            self.inbox_transport.assert_awaited_once_with({('pc', 'alice')})
            self.cloud_transport.assert_awaited_once()
            self.assertIn(('task-a', '', ''), self.cloud_transport.call_args.args[1])
        else:
            self.inbox_transport.assert_not_awaited()
            self.cloud_transport.assert_not_awaited()
        async with self.read_sessions() as reader:
            row = await reader.get(models.AiScheduleRun, 'run')
            self.assertEqual(row.state, 'running' if changed else 'waiting')

    async def test_combined_commit(self):
        async with self.sessions() as session:
            await self.change(session)
            await self.check_pending()
            await session.commit()
        await self.check_finished(changed=True, hints=True)

    async def test_combined_outer_rollback(self):
        async with self.sessions() as session:
            await self.change(session)
            await self.check_pending()
            await session.rollback()
        await self.check_finished(changed=False, hints=False)

    async def outer_write(self, session):
        # Establish a real SQLite outer SQL transaction before SAVEPOINT.
        # This unrelated presence write creates neither auth fence nor hints.
        device = await session.get(models.Client, 'pc')
        device.name = 'outer-transaction'
        await session.flush()

    async def test_combined_nested_commit_then_outer_commit(self):
        async with self.sessions() as session:
            await self.outer_write(session)
            nested = await session.begin_nested()
            await self.change(session)
            await nested.commit()
            await self.check_pending()
            await session.commit()
        await self.check_finished(changed=True, hints=True)

    async def test_combined_nested_commit_then_outer_rollback(self):
        async with self.sessions() as session:
            await self.outer_write(session)
            nested = await session.begin_nested()
            await self.change(session)
            await nested.commit()
            await self.check_pending()
            await session.rollback()
        await self.check_finished(changed=False, hints=False)

    async def test_combined_nested_rollback_then_outer_commit(self):
        async with self.sessions() as session:
            await self.outer_write(session)
            nested = await session.begin_nested()
            await self.change(session)
            await nested.rollback()
            await self.check_pending()
            await session.commit()
        await self.check_finished(changed=False, hints=False)


def load_tests(_loader, _tests, _pattern):
    # The parent module owns its existing auth tests. This module adds every
    # locally declared integration case without rerunning inherited cases.
    return unittest.TestSuite(AuthCachePushTransactionTests(name)
        for name in AuthCachePushTransactionTests.__dict__ if name.startswith('test_'))


if __name__ == '__main__':
    unittest.main()
