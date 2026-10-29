"""Independent accounting invariants; synthetic identities and in-memory SQLite only."""
import os
os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///:memory:'
os.environ['CLUSTER_REDIS_URL'] = ''

import unittest
import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from sqlalchemy import select, func
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app import models, automation_models
from app.db import Base
from app.services import usage_ledger as ledger, usage_analytics as analytics, client_access


class UsageAccountingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        url = os.environ.get('USAGE_ACCOUNTING_TEST_POSTGRES_URL', 'sqlite+aiosqlite:///:memory:')
        parsed = make_url(url)
        if parsed.get_backend_name() == 'postgresql' and (parsed.host != '127.0.0.1' or not parsed.database.startswith('soduwork_orgmemory_test_')):
            raise RuntimeError('Accounting tests require a new disposable loopback database')
        self.engine = create_async_engine(url)
        self.factory = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            if parsed.get_backend_name() == 'postgresql':
                await connection.run_sync(Base.metadata.drop_all)
            await connection.run_sync(Base.metadata.create_all)
        self.session = self.factory()
        self.user = models.User(id='usage-owner', username='usage-owner', org_id='org-A')
        self.client = models.Client(id='usage-device', user_ref=self.user.id)
        self.session.add_all([self.user, self.client])
        await self.session.commit()
        client_access.invalidate_quota()

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()
        client_access.invalidate_quota()

    async def report(self, tokens, model='A', at=None, cost=None, **extra):
        payload = {'sourceId': 'conversation', 'conversationId': 'conversation',
                   'agent': 'pi', 'model': model,
                   'occurredAt': (at or datetime.now(timezone.utc)).isoformat(),
                   'usage': {'input': tokens, **({'cost': cost} if cost is not None else {}), **extra}}
        result = await ledger.from_client(self.session, self.client, payload)
        await self.session.commit()
        return result

    async def test_model_changes_do_not_relabel_old_daily_facts(self):
        await self.report(100, model='A', cost=0.0000015)
        await self.report(300, model='B', cost=0.000004)
        await self.report(300, model='B', cost=0.000004)  # repeat must add nothing
        await self.report(100, model='A', cost=0.0000015)  # delayed stale replay
        result = await analytics.overview(self.session, user_id=self.user.id)
        self.assertEqual({item['model']: item['tokens'] for item in result['byAgent']}, {'A': 100, 'B': 200})
        self.assertEqual(result['summary']['tokens'], 300)
        self.assertEqual(result['summary']['costMicrousd'], 4)
        for group in ('trend', 'byAgent', 'bySource', 'users'):
            self.assertEqual(sum(item['tokens'] for item in result[group]), 300)
            self.assertEqual(sum(item['costMicrousd'] for item in result[group]), 4)
        self.assertEqual(await self.session.scalar(select(func.count(models.AIUsageDaily.id))), 2)

    async def test_billing_user_changes_do_not_move_the_previous_users_usage(self):
        await self.report(100)
        other = models.User(id='another-owner', username='another-owner')
        self.session.add(other)
        self.client.user_ref = other.id
        await self.session.commit()
        await self.report(200)
        previous = await analytics.overview(self.session, user_id=self.user.id)
        current = await analytics.overview(self.session, user_id=other.id)
        self.assertEqual(previous['summary']['tokens'], 100)
        self.assertEqual(current['summary']['tokens'], 100)

    async def test_cross_month_quota_counts_increments_instead_of_session_anchor(self):
        zone = timezone(timedelta(hours=8))
        start = datetime.now(zone).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        await self.report(1000, at=start - timedelta(minutes=1))
        await self.report(1800, at=start + timedelta(minutes=1))
        self.assertEqual(await client_access.monthly_tokens(self.session, self.user.id), 800)

    async def test_unknown_prices_and_other_currencies_are_not_added_as_usd(self):
        await self.report(10)
        # New USD usage with an explicit known zero remains distinct from missing price.
        await self.report(20, cost=0)
        await self.report(30, currency='CNY', cost=1)
        result = await analytics.overview(self.session, user_id=self.user.id)
        self.assertEqual(result['summary']['tokens'], 30)
        self.assertEqual(result['summary']['costMicrousd'], 0)
        self.assertEqual(result['costQuality']['unknown'], 1)
        self.assertEqual(result['costQuality']['otherCurrency'], 1)

    def test_exact_integer_counters_and_decimal_half_up_costs(self):
        self.assertEqual(ledger.normalize_usage({'total': 9007199254740993})['total_tokens'], 9007199254740993)
        self.assertEqual(ledger.normalize_usage({'input': 2, 'cost': 0.0000015})['cost_microusd'], 2)
        self.assertEqual(ledger.normalize_usage({'input': 2, 'costMicrousd': 0, 'cost': 1})['cost_microusd'], 0)
        self.assertFalse(ledger.normalize_usage({'input': 2})['cost_known'])
        self.assertTrue(ledger.normalize_usage({'input': 2, 'cost': 0})['cost_known'])
        self.assertFalse(ledger.normalize_usage({'input': 2, 'costUsd': '0.00000001'})['cost_known'])
        self.assertEqual(ledger.normalize_usage({'input': 2, 'costUsd': '0.000003', 'costMicrousd': 4})['cost_microusd'], 3)
        self.assertEqual(ledger.normalize_usage({'input_tokens': 100, 'cached_input_tokens': 40, 'output_tokens': 10})['total_tokens'], 110)
        self.assertEqual(ledger.normalize_usage({'input': 60, 'cache_read_input_tokens': 40, 'output': 10})['total_tokens'], 110)
        with self.assertRaises(ValueError):
            ledger.normalize_usage({'input': 2 ** 70})

    def test_native_accumulator_preserves_cost_and_total_only_receipts(self):
        from app.services.local_stream import _accumulate_usage
        run = {'usage': {}}
        _accumulate_usage(run, {'input': 10, 'cost': 0.0000015}, step=True)
        _accumulate_usage(run, {'total_tokens': 5, 'cost': 0.0000015}, step=True)
        self.assertEqual(run['usage']['costMicrousd'], 3)
        self.assertEqual(run['usage']['costUsd'], '0.0000030')
        self.assertEqual(run['usage']['total'], 15)
        self.assertTrue(run['usage']['costKnown'])
        from app.services.runtime_messages import billed_event
        usage, scope = billed_event({'type': 'step_finish', 'part': {
            'tokens': {'input': 5, 'output': 2}, 'cost': 0.25}})
        self.assertEqual(scope, 'step')
        _accumulate_usage(run, usage, step=True)
        self.assertEqual(run['usage']['costMicrousd'], 250003)

    @unittest.skipUnless(os.environ.get('USAGE_ACCOUNTING_TEST_POSTGRES_URL'), 'requires isolated PostgreSQL fixture')
    async def test_concurrent_retry_and_snapshot_reconcile(self):
        async def write(amount):
            async with self.factory() as session:
                client = await session.get(models.Client, self.client.id)
                await ledger.from_client(session, client, {'sourceId': 'concurrent',
                    'usage': {'input': amount, 'costMicrousd': amount}})
                await session.commit()
        await asyncio.gather(*(write(amount) for amount in [100, 300, 200, 300, 100, 250, 300, 200]))
        # The production report must use one committed snapshot despite the
        # request session's earlier authentication transaction.
        result = await analytics.consistent_overview(self.session, user_id=self.user.id)
        self.assertEqual(result['summary']['tokens'], 300)
        self.assertEqual(result['summary']['costMicrousd'], 300)
        self.assertEqual(sum(row['tokens'] for row in result['trend']), 300)
        self.assertEqual(result['summary']['sessions'], 1)


if __name__ == '__main__':
    unittest.main()
