"""Explicit PostgreSQL model admission regression; never calls a model.

The caller supplies SODUWORK_MODEL_TEST_POSTGRES_URL pointing to a disposable
soduwork_model_test_<12-32 lowercase hex> database and creates/removes that database.
This script creates and removes only its own random schema. It never loads .env.
Run this file with --check-guard to test refusal without connecting anywhere.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import re
import sys
import uuid
from unittest.mock import patch

import sqlalchemy as sa
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

ENV = 'SODUWORK_MODEL_TEST_POSTGRES_URL'
DATABASE = re.compile(r'soduwork_model_test_[0-9a-f]{12,32}\Z')


def checked_url(raw):
    if not raw:
        raise ValueError('An explicit disposable PostgreSQL database is required')
    try:
        url = make_url(raw)
    except Exception:
        raise ValueError('Invalid explicit fixture URL') from None
    if (url.drivername != 'postgresql+asyncpg' or not url.host
            or not DATABASE.fullmatch(url.database or '') or url.query):
        raise ValueError('Require an explicit host, asyncpg, no query overrides, '
                         'and database soduwork_model_test_<12-32 lowercase hex>')
    return url


async def exercise(url):
    from app import db
    from app.models import AppSetting
    from app.services import model_runtime as runtime

    checks, leases, work, retained_errors = [], [], [], []
    schema = 'model_probe_' + uuid.uuid4().hex
    admin = create_async_engine(url, poolclass=NullPool)
    engine = None
    created = False
    conf = dict(base='https://fixture.invalid/v1', key='fixture-private-key',
                model='fixture-model', provider='fixture-provider', user='alice')

    def expect(value, label):
        if not value:
            raise AssertionError(label)
        checks.append(label)

    async def acquire(user):
        lease = await runtime.acquire({**conf, 'user': user})
        leases.append(lease)
        return lease

    def spawn(coro):
        task = asyncio.create_task(coro)
        work.append(task)
        return task

    async def queued():
        async with asyncio.timeout(10):
            while (await runtime.snapshot())['queued'] != 1:
                await asyncio.sleep(.02)

    async def policy(**overrides):
        value = runtime.clean_policy({**runtime.DEFAULTS, **overrides})
        async with sessions() as session, session.begin():
            row = await runtime.lock_setting(session, runtime.POLICY_KEY)
            row.value = json.dumps(value)

    async def raw_state():
        async with sessions() as session:
            return (await session.get(AppSetting, runtime.STATE_KEY)).value

    async def cancel(task):
        task.cancel()
        try:
            await asyncio.wait_for(task, 8)
        except asyncio.CancelledError as error:
            retained_errors.append(error)
        else:
            raise AssertionError('Cancellation was lost')

    try:
        async with admin.begin() as conn:
            expect(await conn.scalar(sa.text('select current_database()')) == url.database,
                   'the explicit disposable database is used')
            await conn.execute(sa.schema.CreateSchema(schema))
            created = True
        engine = create_async_engine(url, connect_args={'server_settings': {
            'search_path': schema, 'statement_timeout': '5000', 'lock_timeout': '4000'}})
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as conn:
            expect(await conn.scalar(sa.text('select current_schema()')) == schema,
                   'every fixture table is isolated in the random schema')
            await conn.run_sync(AppSetting.__table__.create)

        with patch.object(runtime, 'SessionLocal', sessions):
            try:
                await policy(globalConcurrent=1, queueTimeout=10)
                first = await acquire('alice')
                waiting = spawn(acquire('bob'))
                await queued()
                expect(not waiting.done(), 'capacity overflow queues without starting')
                await first.close()
                second = await asyncio.wait_for(waiting, 8)
                status = await runtime.snapshot()
                expect((status['running'], status['queued']) == (1, 0),
                       'release hands the slot to the queued request')

                await policy(globalConcurrent=1, queueTimeout=1)
                try:
                    await acquire('carol')
                except runtime.CapacityError as error:
                    expect(error.status == 429, 'queue timeout is capacity pressure, not a service fault')
                else:
                    raise AssertionError('A full queue did not time out')
                status = await runtime.snapshot()
                expect(status['queued'] == 0 and status['lastHour'].get('queueTimeout') == 1,
                       'queue timeout removes its lease and records the right outcome')
                await second.close()

                await policy(globalConcurrent=1, queueTimeout=10)
                first = await acquire('alice')
                waiting = spawn(acquire('bob'))
                await queued()
                await cancel(waiting)
                status = await runtime.snapshot()
                expect((status['running'], status['queued']) == (1, 0),
                       'cancelled waiter leaves the active lease untouched')
                await first.close()
                resumed = await acquire('after-cancel')
                await resumed.close()
                expect((await runtime.snapshot())['running'] == 0,
                       'the request after cancellation can acquire and release')

                entered = asyncio.Event()
                async def cancelled_transaction():
                    async with runtime._state() as (state, _now, _config):
                        state['cancelled_fixture_write'] = True
                        entered.set()
                        await asyncio.Event().wait()
                transaction = spawn(cancelled_transaction())
                await asyncio.wait_for(entered.wait(), 8)
                await cancel(transaction)
                expect('cancelled_fixture_write' not in json.loads(await raw_state()),
                       'cancelled transaction rolls back while its traceback is retained')
                resumed = await acquire('after-rollback')
                await resumed.close()
                expect((await runtime.snapshot())['running'] == 0,
                       'rollback releases the PostgreSQL lock for the next request')

                sql_entered = asyncio.Event()
                original_now = runtime._now
                async def slow_database_clock(session):
                    sql_entered.set()
                    await session.execute(sa.text('select pg_sleep(0.15)'))
                    return await original_now(session)
                with patch.object(runtime, '_now', slow_database_clock):
                    sql_waiter = spawn(runtime.snapshot())
                    await asyncio.wait_for(sql_entered.wait(), 8)
                    await cancel(sql_waiter)
                resumed = await acquire('after-sql-cancel')
                await resumed.close()
                expect((await runtime.snapshot())['running'] == 0,
                       'cancellation during a real PostgreSQL statement leaves the next transaction usable')

                await policy(globalConcurrent=2, queueTimeout=20, userQueueSize=32)
                active = peak = 0
                async def request(index):
                    nonlocal active, peak
                    lease = await acquire('parallel-' + str(index))
                    active += 1
                    peak = max(peak, active)
                    try:
                        await asyncio.sleep(.03)
                    finally:
                        active -= 1
                        await lease.close()
                await asyncio.wait_for(asyncio.gather(*(spawn(request(i)) for i in range(12))), 40)
                status = await runtime.snapshot()
                expect(peak <= 2 and (status['running'], status['queued']) == (0, 0),
                       'parallel traffic obeys the limit and drains all leases')

                await policy(globalConcurrent=1, queueSize=0)
                expired = await acquire('expired-worker')
                async with runtime._state() as (state, now, _config):
                    next(row for row in state['leases'] if row['id'] == expired.id)['expires'] = now - 1
                successor = await acquire('successor')
                await expired.close()
                expect((await runtime.snapshot())['running'] == 1,
                       'an expired worker cannot release its successor lease')
                await successor.close()
                raw = await raw_state()
                expect(conf['key'] not in raw and conf['base'] not in raw,
                       'admission state stores neither credential nor upstream address')
                expect(len(retained_errors) == 3,
                       'all original cancellation exceptions remain alive through all follow-up checks')
            finally:
                for task in work:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*work, return_exceptions=True)
                for lease in leases:
                    await lease.close()
    finally:
        if engine is not None:
            await engine.dispose()
        await db.engine.dispose()
        if created:
            async with admin.begin() as conn:
                await conn.execute(sa.schema.DropSchema(schema, cascade=True))
                expect(await conn.scalar(sa.text('select to_regnamespace(:schema)'), {'schema': schema}) is None,
                       'the isolated schema is removed after the regression')
        await admin.dispose()
    print(json.dumps({'ok': True, 'dialect': 'postgresql', 'checks': checks,
                      'schemaRemoved': True, 'productionChanged': False, 'modelCalls': 0}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check-guard', action='store_true')
    args = parser.parse_args()
    if args.check_guard:
        unsafe = [None, '', 'sqlite:///test.db', 'postgresql+asyncpg://u:p@host/postgres',
                  'postgresql+asyncpg://u:p@host/soduwork',
                  'postgresql+asyncpg://u:p@host/soduwork_model_test_aabbccddeeff?options=x']
        for candidate in unsafe:
            try:
                checked_url(candidate)
            except ValueError:
                continue
            raise AssertionError('Unsafe URL accepted')
        checked_url('postgresql+asyncpg://u:p@host/soduwork_model_test_aabbccddeeff')
        print(json.dumps({'ok': True, 'refused': len(unsafe)}))
        return
    url = checked_url(os.environ.get(ENV))
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from app.config import Settings
    settings = Settings(_env_file=None, database_url=url.render_as_string(hide_password=False),
                        auth_secret='isolated-model-admission-regression-key')
    with patch('app.config.get_settings', return_value=settings):
        asyncio.run(exercise(url))


if __name__ == '__main__':
    main()
