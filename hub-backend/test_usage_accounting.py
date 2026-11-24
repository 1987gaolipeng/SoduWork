"""Independent accounting invariants; synthetic identities and in-memory SQLite only."""
import os
os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///:memory:'
os.environ['CLUSTER_REDIS_URL'] = ''

import unittest
import asyncio
from uuid import uuid4
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from sqlalchemy import select, func
from sqlalchemy.engine import make_url
from sqlalchemy.schema import CreateSchema, DropSchema
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
        self.schema = None
        if parsed.get_backend_name() == 'postgresql':
            # The fixture has already migrated the full public schema. Keep it
            # intact; this module registers only the tables it exercises.
            self.schema = 'usage_case_' + uuid4().hex
            self.admin_engine = create_async_engine(url)
            async with self.admin_engine.begin() as connection:
                await connection.execute(CreateSchema(self.schema))
            self.engine = create_async_engine(url, connect_args={'server_settings': {
                'search_path': self.schema, 'statement_timeout': '20000'}})
        else:
            self.engine = create_async_engine(url)
        self.factory = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
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
        if self.schema:
            try:
                async with self.admin_engine.begin() as connection:
                    await connection.execute(DropSchema(self.schema, cascade=True))
            finally:
                await self.admin_engine.dispose()
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

    async def test_reused_device_source_keeps_account_counters_and_daily_facts_separate(self):
        at = datetime.now(timezone.utc)
        first = await self.report(100, at=at)
        first_id, first_key = first.id, first.idempotency_key
        other = models.User(id='another-owner', username='another-owner', org_id='org-B')
        self.session.add(other)
        self.client.user_ref = other.id
        await self.session.commit()
        second = await self.report(200, at=at)
        self.assertNotEqual(second.id, first_id)
        self.assertNotEqual(second.idempotency_key, first_key)
        repeated = await self.report(200, at=at)
        self.assertEqual(repeated.id, second.id)
        previous = await analytics.overview(self.session, user_id=self.user.id)
        current = await analytics.overview(self.session, user_id=other.id)
        self.assertEqual(previous['summary']['tokens'], 100)
        # Reusing a source ID on another account starts an independent counter,
        # rather than subtracting usage that belongs to the previous account.
        self.assertEqual(current['summary']['tokens'], 200)
        await self.session.refresh(first)
        self.assertEqual((first.billing_user_id, first.org_id, first.total_tokens),
                         (self.user.id, 'org-A', 100))
        self.assertEqual((second.billing_user_id, second.org_id, second.total_tokens),
                         (other.id, 'org-B', 200))

        self.client.user_ref = self.user.id
        await self.session.commit()
        resumed = await self.report(150, at=at)
        self.assertEqual(resumed.id, first_id)
        previous = await analytics.overview(self.session, user_id=self.user.id)
        current = await analytics.overview(self.session, user_id=other.id)
        self.assertEqual(previous['summary']['tokens'], 150)
        self.assertEqual(current['summary']['tokens'], 200)
        self.assertEqual(await self.session.scalar(select(func.count(models.AIUsageEvent.id))), 2)
        daily = (await self.session.scalars(select(models.AIUsageDaily))).all()
        self.assertEqual({(row.billing_user_id, row.org_id, row.total_tokens) for row in daily},
                         {(self.user.id, 'org-A', 150), (other.id, 'org-B', 200)})

    async def test_personal_receipts_preserve_legacy_platform_usage_and_replay_safely(self):
        from app.services import model_quota
        at = datetime.now(timezone.utc)
        legacy = models.AIUsageEvent(
            idempotency_key='client:' + self.client.id + ':legacy-personal-switch',
            billing_user_id=self.user.id, client_id=self.client.id,
            provider='organization', model='old-model', total_tokens=42,
            input_tokens=42, occurred_at=at,
        )
        self.session.add(legacy)
        await self.session.commit()
        self.assertEqual(await client_access.monthly_tokens(self.session, self.user.id), 42)
        conf = {'provider': 'personal-provider', 'model': 'personal-model', 'quotaScope': 'personal'}
        token = model_quota.usage_token(self.client, conf)
        payload = {'sourceId': 'legacy-personal-switch', 'agent': 'pi', 'provider': conf['provider'],
                   'model': conf['model'], 'quotaUsageToken': token, 'occurredAt': at.isoformat(),
                   'usage': {'input': 47, 'total': 47}}
        await ledger.from_client(self.session, self.client, payload)
        await self.session.commit()
        await ledger.from_client(self.session, self.client, payload)
        await self.session.commit()
        self.assertEqual(await client_access.monthly_tokens(self.session, self.user.id), 42)
        daily = (await self.session.scalars(select(models.AIUsageDaily))).all()
        self.assertEqual({(row.provider, row.model, row.quota_scope, row.total_tokens) for row in daily},
                         {('organization', 'old-model', 'platform', 42),
                          ('personal-provider', 'personal-model', 'personal', 5)})
        # A signed receipt for another model is not proof for this increment.
        await ledger.from_client(self.session, self.client, {**payload, 'model': 'other-model',
            'usage': {'input': 50, 'total': 50}})
        await self.session.commit()
        self.assertEqual(await client_access.monthly_tokens(self.session, self.user.id), 45)
        result = await analytics.overview(self.session, user_id=self.user.id)
        self.assertEqual(result['summary']['tokens'], 50)

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

    async def test_first_estimated_receipt_is_visible_until_better_evidence_arrives(self):
        await self.report(10, cost=0.25, quality='estimated')
        initial = await analytics.overview(self.session)
        self.assertEqual(initial['recent'][0]['quality'], 'estimated')
        self.assertEqual(initial['costQuality']['estimatedUsageMicrousd'], 250_000)
        self.assertEqual(initial['summary']['costMicrousd'], 250_000)
        await self.report(10, cost=0.25, quality='reconciled')
        await self.report(10, cost=0.25, quality='estimated')
        final = await analytics.overview(self.session)
        self.assertEqual(final['recent'][0]['quality'], 'reconciled')
        self.assertEqual(final['costQuality']['estimatedUsageUsd'], 0)
        self.assertEqual(final['summary']['costMicrousd'], 250_000)

    async def test_historical_anomalies_and_unpriced_cost_are_scoped_and_pageable(self):
        now = datetime.now(timezone.utc)
        threshold = 1_000_000_000
        huge = 10**18 + 1

        facts = []
        def fact(key, tokens, days_old=0, owner=self.user.id, quality='reported',
                 cost=None, currency='USD', cost_known=None):
            at = now - timedelta(days=days_old)
            dimensions = dict(billing_user_id=owner, source_type='chat', agent_key='fixture',
                              occurred_at=at, total_tokens=tokens, input_tokens=tokens,
                              cost_microusd=cost or 0, currency=currency)
            self.session.add(models.AIUsageEvent(id=key, idempotency_key=key, source_id=key,
                                                  quality=quality, **dimensions))
            facts.append(models.AIUsageDaily(usage_event_id=key,
                day_key=at.astimezone(timezone(timedelta(hours=8))).date().isoformat(),
                cost_known=(cost is not None if cost_known is None else cost_known), **dimensions))

        # Insert historical facts directly. Today's reporting endpoint rejects these counters.
        for i in range(31):
            fact(f'anomaly-{i}', huge, days_old=3)
        for i in range(30):
            fact(f'normal-{i}', 1, cost=0)
        fact('boundary', threshold, cost=2, quality='estimated')
        fact('other-currency', 1, currency='CNY', cost=4)
        fact('unknown-cost', 2, cost=42, cost_known=False)
        fact('older', huge, days_old=45)
        fact('foreign', huge, owner='other-owner')
        await self.session.flush()
        self.session.add_all(facts)
        await self.session.commit()

        scope = dict(user_ids={self.user.id}, agent_key='fixture', source_type='chat')
        report = await analytics.overview(self.session, **scope)
        self.assertEqual(report['anomalies'], {'records': 31, 'tokenLimit': threshold})
        self.assertTrue(all(not row['anomalous'] for row in report['recent']))
        self.assertEqual(report['costQuality']['knownUsd'], 31)
        self.assertEqual(report['costQuality']['knownMicrousd'], 2)
        self.assertEqual(report['costQuality']['estimatedUsageUsd'], 1)
        self.assertEqual(report['costQuality']['estimatedUsageMicrousd'], 2)
        self.assertEqual(report['costQuality']['knownOtherCurrency'], 1)
        self.assertEqual(report['costQuality']['unknown'], 32)
        self.assertEqual(report['costQuality']['unknownTokens'], str(31 * huge + 2))
        self.assertEqual(report['costQuality']['unknownAnomalous'], 31)
        for bucket in ['trend', 'bySource', 'byAgent', 'users']:
            self.assertEqual(sum(row['tokens'] for row in report[bucket]), 31 * huge + threshold + 33)
            self.assertEqual(sum(row['costMicrousd'] for row in report[bucket]), 2)

        first = await analytics.overview(self.session, detail='anomalous', **scope)
        second = await analytics.overview(self.session, detail='anomalous', page=2, **scope)
        rows = first['recent'] + second['recent']
        self.assertEqual(second['detailPage'], {'page': 2, 'pageSize': 30, 'total': 31})
        self.assertEqual({row['sourceId'] for row in rows}, {f'anomaly-{i}' for i in range(31)})
        self.assertTrue(all(row['anomalous'] and row['tokensExact'] == str(huge) and row['eventId'] for row in rows))

        clean = await analytics.overview(self.session, exclude_anomalies=True, detail='unpriced', **scope)
        self.assertEqual(clean['summary']['tokens'], threshold + 33)
        self.assertEqual(clean['summary']['costMicrousd'], 2)
        self.assertEqual(clean['detailPage']['total'], 32)
        self.assertEqual(clean['anomalies'], report['anomalies'])
        self.assertEqual(clean['costQuality'], report['costQuality'])
        self.assertTrue(all(not row['costKnown'] and row['costMicrousd'] == 0 for row in clean['recent']))

        empty = await analytics.overview(self.session, user_ids=set(), detail='anomalous')
        self.assertEqual(empty['anomalies']['records'], 0)
        self.assertEqual(empty['recent'], [])

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
