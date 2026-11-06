"""Isolated regressions for bounded work, scoped aggregation and missing delivery."""
import asyncio
from datetime import datetime, timezone
import os
import threading
import time
from types import SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, Mock, patch

import anyio

os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///:memory:'
os.environ['AUTH_SECRET'] = 'isolated-stability-followup-fixture-secret'

from sqlalchemy import event
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app import models
from app.api import admin_projects
from app.db import Base
from app.services import file_io, workflow_engine as workflow


class MigrationFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_required_backfill_failure_cannot_stamp_or_upgrade_legacy_database(self):
        from app import db, schema_migrations
        engine = create_async_engine('sqlite+aiosqlite:///:memory:')
        self.addAsyncCleanup(engine.dispose)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

        def fail_required_update(_conn, _cursor, statement, _parameters, _context, _many):
            if statement.startswith('UPDATE task SET start_at'):
                raise RuntimeError('Injected required backfill failure')

        event.listen(engine.sync_engine, 'before_cursor_execute', fail_required_update)
        with patch.object(schema_migrations, '_stamp_adopted_schema') as stamp, \
             patch.object(schema_migrations, '_upgrade_head') as upgrade:
            with self.assertRaisesRegex(RuntimeError, 'Injected required backfill failure'):
                await schema_migrations.migrate_database(engine, Base.metadata, db._ensure_columns, db._backfill_data)
            stamp.assert_not_called()
            upgrade.assert_not_called()


class DeploymentBatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_progress_commits_once_while_terminal_boundaries_and_runner_ownership_remain(self):
        from app import automation_models as am
        from app.services import deployments
        engine = create_async_engine('sqlite+aiosqlite:///:memory:')
        self.addAsyncCleanup(engine.dispose)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as session:
            session.add_all([am.DeploymentRun(id=str(i), task_id='fixture-task', artifact_version_id='fixture-artifact',
                environment_id='fixture-environment', target_id='fixture-target', state='running', runner_id='owner',
                attempt=1, idempotency_key='fixture-' + str(i)) for i in range(50)])
            await session.commit()
            commits = []
            event.listen(session.sync_session, 'after_commit', lambda _session: commits.append('commit'))
            snapshots = [{'id': str(i), 'state': 'running', 'log': 'progress'} for i in range(50)]
            updates = await deployments.ingest_runner_snapshots(session, NS(id='owner'), snapshots)
            self.assertEqual(len(updates), 50)
            self.assertEqual(commits, ['commit'])
            commits.clear()
            self.assertEqual(await deployments.ingest_runner_snapshots(session, NS(id='stranger'), snapshots), [])
            self.assertEqual(commits, [])

            async def terminal(db, run):
                self.assertEqual(commits, ['commit'])
                commits.append('terminal')
                self.assertEqual(run.id, '1')
                await db.commit()

            with patch.object(deployments, '_after_terminal', terminal):
                await deployments.ingest_runner_snapshots(session, NS(id='owner'), [
                    {'id': '0', 'state': 'running', 'log': 'new progress'},
                    {'id': '1', 'state': 'succeeded'}, {'id': '2', 'state': 'running', 'log': 'after terminal'}])
            self.assertEqual(commits, ['commit', 'terminal', 'commit', 'commit'])
            self.assertEqual((await session.get(am.DeploymentRun, '2')).logs, 'after terminal')


class StreamLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_cluster_rejection_has_request_id_metrics_and_preserves_read_access(self):
        import httpx
        from app.main import app
        from app.services import cluster_bus, runtime_telemetry
        runtime_telemetry.reset_for_test()
        self.addCleanup(runtime_telemetry.reset_for_test)
        with patch.object(cluster_bus, 'bus', NS(enabled=True, healthy=False)):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://fixture') as client:
                response = await client.post('/api/tasks/fixture', headers={'X-Request-ID': 'fixture-cluster-denial'})
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.headers['X-Request-ID'], 'fixture-cluster-denial')
                self.assertEqual(response.headers['Retry-After'], '3')
                summary = runtime_telemetry.summary()
                self.assertEqual(summary['requests'], 1)
                self.assertEqual(summary['errors'], 1)
                self.assertEqual(summary['recentErrors'][0]['type'], 'cluster_unavailable')
                self.assertEqual((await client.get('/healthz')).status_code, 200)

    async def test_heartbeat_never_splits_a_partial_event_and_cancellation_closes_reader(self):
        from app.api import ai_proxy
        closed = []

        class Response:
            async def chunks(self):
                try:
                    await asyncio.sleep(.035)
                    yield b'data: {"text":"'
                    await asyncio.sleep(.035)
                    yield b'answer"}\n\n'
                    await asyncio.sleep(.035)
                finally:
                    closed.append('reader')

            async def aclose(self):
                closed.append('response')

        with patch.object(ai_proxy, 'OPEN_KEEPALIVE_INTERVAL', .01):
            parts = [part async for part in ai_proxy._stream_upstream_response(Response())]
        self.assertGreater(parts.count(ai_proxy.OPEN_KEEPALIVE_COMMENT), 1)
        self.assertIn(b'data: {"text":"answer"}\n\n', b''.join(parts))
        self.assertEqual(closed, ['reader', 'response'])
        closed.clear()
        stream = ai_proxy._stream_upstream_response(Response())
        pending = asyncio.create_task(anext(stream))
        await asyncio.sleep(.005)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertEqual(closed, ['reader', 'response'])

    async def test_stream_failures_and_client_cancellation_have_separate_metrics(self):
        import json
        from app.api import ai_proxy
        from app.services import model_runtime, runtime_telemetry
        runtime_telemetry.reset_for_test()
        self.addCleanup(runtime_telemetry.reset_for_test)

        async def denied():
            error = model_runtime.CapacityError(status=503)
            error.retry_after = 120
            raise error

        response = await ai_proxy._open_then_stream(None, denied)
        body = b''.join([part async for part in response.body_iterator])
        self.assertEqual(response.status_code, 200)
        error = json.loads(body.split(b'data: ', 1)[1])['error']
        self.assertEqual(error['retry_after_ms'], 120000)
        self.assertIn('Retry after 120 seconds.', error['message'])
        summary = runtime_telemetry.summary()
        self.assertEqual(summary['streams']['failed'], 1)
        self.assertEqual(summary['requests'], 0)
        self.assertEqual(summary['recentErrors'][0]['type'], 'admission')

        async def forever():
            await asyncio.Event().wait()

        response = await ai_proxy._open_then_stream(None, forever)
        await anext(response.body_iterator)
        await response.body_iterator.aclose()
        summary = runtime_telemetry.summary()
        self.assertEqual(summary['streams']['cancelled'], 1)
        self.assertEqual(summary['streams']['failed'], 1)


class FileWorkTests(unittest.IsolatedAsyncioTestCase):
    async def test_expired_anyio_scope_joins_disk_work_without_cancellation_spin(self):
        finished = []
        original = asyncio.shield
        joins = []

        def shield(task):
            joins.append(task)
            return original(task)

        def job():
            time.sleep(.06)
            finished.append(True)

        with patch.object(file_io.asyncio, 'shield', shield):
            with anyio.move_on_after(.01) as scope:
                await file_io.run(job)
        self.assertTrue(scope.cancel_called)
        self.assertEqual(finished, [True])
        self.assertLessEqual(len(joins), 3)

    async def test_terminal_pressure_keeps_order_and_detaches_without_closing_execution(self):
        import json
        from app.api import term
        sent = []
        active = peak = 0

        async def write(_runner, _task, value):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(.001)
            sent.append(value)
            active -= 1

        websocket = NS(send_json=AsyncMock(), receive_text=AsyncMock(side_effect=[
            *[json.dumps({'t': 'i', 'd': str(i)}) for i in range(200)], term.WebSocketDisconnect()]))
        with patch.object(term, '_workdir_of', AsyncMock(return_value='fixture')), \
             patch.object(term, '_cli_sid_of', AsyncMock(return_value=('session', 'pi'))), \
             patch.object(term.runner_hub, 'term_open', AsyncMock(return_value={'ok': True})), \
             patch.object(term.runner_hub, 'term_write', write), \
             patch.object(term.runner_hub, 'term_detach', AsyncMock()) as detach, \
             patch.object(term.runner_hub, 'term_close', AsyncMock()) as close:
            await term._serve_terminal(websocket, 'task', 100, 30, 'session', NS(host='fixture'))
            self.assertEqual(sent, [str(i) for i in range(200)])
            self.assertEqual(peak, 1)
            detach.assert_awaited_once()
            close.assert_not_awaited()

    async def test_disk_pressure_is_bounded_without_blocking_the_loop(self):
        lock = threading.Lock()
        active = peak = ticks = 0

        def job():
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(.04)
            with lock:
                active -= 1

        tasks = [asyncio.create_task(file_io.run(job)) for _ in range(32)]
        while any(not task.done() for task in tasks):
            ticks += 1
            await asyncio.sleep(.005)
        await asyncio.gather(*tasks)
        self.assertEqual(peak, 4)
        self.assertGreater(ticks, 10)

    async def test_repeated_cancel_joins_worker_before_cleanup(self):
        entered, finish = threading.Event(), threading.Event()
        completed = []

        def job():
            entered.set()
            finish.wait(2)
            completed.append(True)

        task = asyncio.create_task(file_io.run(job))
        while not entered.is_set():
            await asyncio.sleep(.001)
        task.cancel()
        await asyncio.sleep(.01)
        task.cancel()
        await asyncio.sleep(.01)
        self.assertFalse(task.done())
        finish.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(completed, [True])


class ProjectCountsTests(unittest.IsolatedAsyncioTestCase):
    async def test_scoped_counts_use_three_queries_for_one_thousand_projects(self):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            async with async_sessionmaker(engine, expire_on_commit=False)() as session:
                session.add_all([models.Project(id=str(i), name=str(i), org_id="allowed") for i in range(1000)])
                session.add_all([models.Project(id="outside", name="private", org_id="outside"),
                                 models.Project(id="shared", name="shared")])
                session.add_all([models.Task(id="t" + str(i), title="fixture", project_id="1", status=status,
                    archived_at=datetime.now(timezone.utc) if archived else None)
                    for i, (status, archived) in enumerate([("todo", False), ("done", False),
                        ("cancel", False), ("done", True), ("doing", True)])])
                await session.commit()
                sql = []
                event.listen(engine.sync_engine, "before_cursor_execute",
                             lambda _c, _cursor, statement, *_args: sql.append(statement))
                with patch.object(admin_projects.rbac, "scope_org_ids", AsyncMock(return_value={"allowed"})):
                    rows = await admin_projects.list_projects(NS(id="viewer"), session)
                self.assertEqual(len(sql), 3)
                self.assertEqual(len(rows), 1001)
                by_id = {row["id"]: row for row in rows}
                self.assertNotIn("outside", by_id)
                self.assertEqual([by_id["1"][key] for key in ("total", "done", "closed")], [2, 1, 3])
                self.assertEqual([by_id["0"][key] for key in ("total", "done", "closed")], [0, 0, 0])
        finally:
            await engine.dispose()


class MissingDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_finished_execution_without_required_file_fails_contract_without_acceptance(self):
        session = NS(get=AsyncMock(return_value=NS(id="task")), add=Mock())
        run = NS(id="run", task_id="task", context={})
        node = NS(id="node", node_key="write", node_type="ai", state="running", error="",
                  executor={"ref": "fixture"}, output={}, started_at=None, attempt=1)
        definition = {"key": "write", "outputs": [{"kind": "file", "key": "result", "path": "required.md", "required": True}]}
        with patch.object(workflow, "_restore_ai_route", return_value=("fixture", "")), \
                patch.object(workflow.ai_exec, "load", AsyncMock(return_value={})), \
                patch.object(workflow.ai_exec, "status_sync", return_value={"ok": True, "done": True}), \
                patch.object(workflow, "_node_config", AsyncMock(return_value={})), \
                patch.object(workflow, "_version", AsyncMock(return_value=NS())), \
                patch.object(workflow, "_nodes", return_value=[definition]), \
                patch.object(workflow, "_wait_for_output_settle", return_value=False), \
                patch.object(workflow, "_completion_decision", AsyncMock()) as decision, \
                patch.object(workflow, "_begin_rework", AsyncMock(return_value=False)), \
                patch.object(workflow, "_event"):
            await workflow._poll_node(session, run, node)
        self.assertEqual(node.state, "failed")
        self.assertEqual(node.output["failureKind"], "contract")
        self.assertTrue(node.output["outputReceipt"]["missing"])
        decision.assert_not_awaited()
        session.add.assert_not_called()


if __name__ == "__main__":
    unittest.main()
