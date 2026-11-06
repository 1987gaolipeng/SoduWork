"""Synthetic SQLite admission pressure; never connect to business services or models."""
import asyncio
import json
import os
from pathlib import Path
import statistics
import sys
import tempfile
import time
from unittest.mock import patch

os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///:memory:'
os.environ['AUTH_SECRET'] = 'isolated-stability-pressure-fixture-not-a-production-key'

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app.models import AppSetting, Client, ModelProvider, ModelDef
from app.model_runtime_models import ModelRuntimeLease, ModelRuntimeMetric
from app.services import model_runtime as runtime
from app.services import model_runtime_transaction as transactions


async def main(output):
    with tempfile.TemporaryDirectory(prefix='soduwork-admission-pressure-') as folder:
        engine = create_async_engine('sqlite+aiosqlite:///' + (Path(folder) / 'isolated.db').as_posix())
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            for model in (AppSetting, Client, ModelProvider, ModelDef, ModelRuntimeLease, ModelRuntimeMetric):
                await connection.run_sync(model.__table__.create)
        waits, ticks, failures = [], [], []
        active = peak = completed = cancelled = 0
        running = True

        async def heartbeat():
            before = time.perf_counter()
            while running:
                await asyncio.sleep(.01)
                now = time.perf_counter()
                ticks.append(max(0, (now - before) * 1000 - 10))
                before = now

        async def call(index):
            nonlocal active, peak, completed, cancelled
            lease = None
            started = time.perf_counter()
            try:
                lease = await runtime.acquire(dict(base='https://fixture.invalid/v1', key='isolated-key',
                    provider='fixture', model='fixture', user='synthetic-' + str(index % 8)))
                waits.append((time.perf_counter() - started) * 1000)
                active += 1
                peak = max(peak, active)
                try:
                    await asyncio.sleep(.04)
                    completed += 1
                finally:
                    active -= 1
            except asyncio.CancelledError:
                cancelled += 1
                raise
            except Exception as error:
                failures.append(type(error).__name__)
            finally:
                if lease is not None:
                    await lease.close('completed')

        tasks = []
        monitor = asyncio.create_task(heartbeat())
        started = time.perf_counter()
        bindings = [patch.object(runtime, 'SessionLocal', sessions),
                    patch.object(runtime, '_broadcast_capacity', return_value=None)]
        for binding in bindings:
            binding.start()
        try:
            # Local wakeups still execute; only outbound cluster transport is isolated.
            async with sessions() as session, session.begin():
                setting = await runtime.lock_setting(session, runtime.POLICY_KEY)
                setting.value = json.dumps(runtime.clean_policy({**runtime.DEFAULTS,
                    'globalConcurrent': 16, 'providerConcurrent': 16, 'keyConcurrent': 16,
                    'modelConcurrent': 16, 'userConcurrent': 4, 'queueSize': 128,
                    'userQueueSize': 32, 'queueTimeout': 120}))
            tasks = [asyncio.create_task(call(i)) for i in range(128)]
            await asyncio.sleep(.1)
            for task in tasks[::8]:
                if not task.done():
                    task.cancel()
            async with asyncio.timeout(120):
                await asyncio.gather(*tasks, return_exceptions=True)
            # Cancellation intentionally returns within a bounded caller budget.
            # Join the owned compensation workers before checking final durability.
            cleanup_started = time.perf_counter()
            async with asyncio.timeout(10):
                while transactions._pending:
                    await asyncio.gather(*list(transactions._pending), return_exceptions=True)
                    await asyncio.sleep(0)
            final = await runtime.snapshot()
            assert not failures, failures
            assert peak <= 16, peak
            assert completed + cancelled == 128, (completed, cancelled)
            assert final['running'] == final['queued'] == 0, final
            assert ticks, 'Event loop heartbeat did not run'
            result = {'ok': True, 'boundary': 'One isolated SQLite Hub process; synthetic admission only; no network/model traffic. Not a PostgreSQL cluster capacity claim.',
                'requests': 128, 'completed': completed, 'cancelled': cancelled, 'peakActive': peak,
                'elapsedMs': round((time.perf_counter() - started) * 1000, 1),
                'cleanupDrainMs': round((time.perf_counter() - cleanup_started) * 1000, 1),
                'admissionMedianMs': round(statistics.median(waits), 1),
                'admissionP95Ms': round(sorted(waits)[int((len(waits) - 1) * .95)], 1),
                'loopLagP99Ms': round(sorted(ticks)[int((len(ticks) - 1) * .99)], 1),
                'remainingRunning': final['running'], 'remainingQueued': final['queued']}
            Path(output).write_text(json.dumps(result, indent=2), encoding='utf-8')
            print(json.dumps(result))
        finally:
            running = False
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            while transactions._pending:
                await asyncio.gather(*list(transactions._pending), return_exceptions=True)
                await asyncio.sleep(0)
            await monitor
            for binding in reversed(bindings):
                binding.stop()
            await engine.dispose()


if __name__ == '__main__':
    if len(sys.argv) != 2 or not Path(sys.argv[1]).is_absolute():
        raise SystemExit('An absolute evidence file is required')
    asyncio.run(main(sys.argv[1]))
